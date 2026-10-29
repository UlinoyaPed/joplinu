package org.joplinu.app

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Executes the actual WebView → Capacitor → Android SQLite path, without a mock plugin. */
@RunWith(AndroidJUnit4::class)
class NativeDatabaseTest {
    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1)
        val result = AtomicReference<String>()
        scenario.onActivity { activity -> activity.bridge.webView.evaluateJavascript(script) { value -> result.set(value); latch.countDown() } }
        assertTrue("JavaScript callback timed out", latch.await(15, TimeUnit.SECONDS))
        return result.get()
    }

    private fun awaitTrue(scenario: ActivityScenario<MainActivity>, script: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
        while (System.nanoTime() < deadline) {
            if (evaluate(scenario, script) == "true") return
            Thread.sleep(100)
        }
        val state = evaluate(scenario, "JSON.stringify({heading:document.querySelector('h1')?.textContent,error:document.querySelector('[role=alert]')?.textContent,status:document.querySelector('footer')?.textContent})")
        throw AssertionError("WebView condition timed out: $script; UI: $state")
    }

    @Test
    fun sqliteChunkingConflictValidationAndActivityRecovery() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地 · SQLite'))")
            evaluate(scenario, """
                window.__databaseTestResult = 'pending';
                (async () => {
                    const db = window.Capacitor.Plugins.JoplinuDatabase;
                    const original = await db.read();
                    const value = JSON.parse(original.payload);
                    value.chunkProbe = '汉字📝'.repeat(350000);
                    const payload = JSON.stringify(value);
                    const saved = await db.write({ expectedRevision: original.revision, payload });
                    const loaded = await db.read();
                    if (loaded.payload !== payload) throw new Error('Unicode chunk round-trip mismatch');
                    let conflict = false;
                    try { await db.write({ expectedRevision: original.revision, payload: original.payload }); } catch { conflict = true; }
                    if (!conflict) throw new Error('Stale writer was accepted');
                    let invalid = false;
                    try { await db.write({ expectedRevision: saved.revision, payload: '{invalid' }); } catch { invalid = true; }
                    if (!invalid || (await db.read()).payload !== payload) throw new Error('Invalid write changed the database');
                    if ((await db.check()).result !== 'ok') throw new Error('SQLite integrity failure');
                    await db.write({ expectedRevision: saved.revision, payload: original.payload });
                    window.__databaseTestResult = 'ok';
                })().catch(error => { window.__databaseTestResult = error.message; });
            """.trimIndent())
            awaitTrue(scenario, "window.__databaseTestResult !== 'pending'")
            assertEquals("ok", JSONTokener(evaluate(scenario, "window.__databaseTestResult")).nextValue())

            evaluate(scenario, "window.location.reload(); true")
            awaitTrue(scenario, "typeof window.__databaseTestResult === 'undefined'")
            awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地 · SQLite'))")
            evaluate(scenario, """
                (() => {
                    const input = document.querySelector('input[aria-label="笔记标题"]');
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Android SQLite 恢复验证');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                })()
            """.trimIndent())
            awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地 · SQLite'))")
            // Verify the persisted data, not only the current DOM value, before recreating Activity.
            evaluate(scenario, "window.__savedTitle = false; (async () => { for(let n=0; n<100; n++) { const record = await window.Capacitor.Plugins.JoplinuDatabase.read(); if(JSON.parse(record.payload).notes.some(note => note.title === 'Android SQLite 恢复验证')) { window.__savedTitle=true; return; } await new Promise(resolve => setTimeout(resolve, 100)); } })(); true")
            awaitTrue(scenario, "window.__savedTitle === true")
            scenario.recreate()
            awaitTrue(scenario, "document.querySelector('input[aria-label=\"笔记标题\"]')?.value === 'Android SQLite 恢复验证'")
            awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地 · SQLite'))")
        }
    }
}
