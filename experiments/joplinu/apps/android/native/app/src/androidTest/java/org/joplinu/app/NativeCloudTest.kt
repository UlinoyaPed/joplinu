package org.joplinu.app

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.lifecycle.Lifecycle
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import android.app.job.JobScheduler
import android.os.Build
import android.os.ParcelFileDescriptor
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.WorkManager
import android.database.sqlite.SQLiteDatabase

/** One native connection scenario against a real ephemeral S3 service, not a mock API. */
@RunWith(AndroidJUnit4::class)
class NativeCloudTest {
    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1); val result = AtomicReference<String>()
        scenario.onActivity { activity -> activity.bridge.webView.evaluateJavascript(script) { result.set(it); latch.countDown() } }
        assertTrue("Cloud JavaScript callback timed out", latch.await(15, TimeUnit.SECONDS)); return result.get()
    }
    private fun call(scenario: ActivityScenario<MainActivity>, method: String, input: JSONObject = JSONObject()): JSONObject {
        evaluate(scenario, "window.__cloudResult=null;window.Capacitor.Plugins.JoplinuCloud.$method(${input}).then(value=>window.__cloudResult=JSON.stringify(value)).catch(()=>window.__cloudResult=JSON.stringify({ok:false,error:{kind:'bridge'}}));true")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (System.nanoTime() < deadline) {
            val value = evaluate(scenario, "window.__cloudResult")
            if (value != "null") return JSONObject(JSONTokener(value).nextValue() as String)
            Thread.sleep(100)
        }
        throw AssertionError("Native cloud operation timed out")
    }
    private fun awaitTrue(scenario: ActivityScenario<MainActivity>, script: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
        while (System.nanoTime() < deadline) { if (evaluate(scenario, script) == "true") return; Thread.sleep(100) }
        val state = evaluate(scenario, "JSON.stringify({error:document.querySelector('[role=alert]')?.textContent,status:document.querySelector('footer')?.textContent})")
        throw AssertionError("Native sync UI timed out: $state")
    }
    @Test fun nativeKeystoreAndSigV4RoundTrip() {
        val connection = URL("http://10.0.2.2:10081/config").openConnection() as HttpURLConnection
        connection.connectTimeout = 10000; connection.readTimeout = 10000
        val setup = try { connection.inputStream.bufferedReader().use { JSONObject(it.readText()) } } finally { connection.disconnect() }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
            while (evaluate(scenario, "Boolean(window.Capacitor?.Plugins?.JoplinuCloud)") != "true") { assertTrue("Cloud bridge did not load", System.nanoTime() < deadline); Thread.sleep(100) }
            try {
                assertTrue(call(scenario, "configure", setup).getBoolean("ok"))
                val report = call(scenario, "probe"); assertTrue("S3 connection checks failed: $report", report.getBoolean("ok") && report.getJSONObject("value").getBoolean("ok"))
                val key = "原生/中文.bin"
                assertTrue(call(scenario, "request", JSONObject().put("operation", "put").put("key", key).put("data", "AP+A")).getBoolean("ok"))
                assertEquals("AP+A", call(scenario, "request", JSONObject().put("operation", "get").put("key", key)).getString("value"))
                assertEquals(3L, call(scenario, "request", JSONObject().put("operation", "head").put("key", key)).getJSONObject("value").getLong("size"))
                val objects = call(scenario, "request", JSONObject().put("operation", "list").put("key", "原生/")).getJSONObject("value").getJSONArray("objects")
                assertTrue((0 until objects.length()).any { objects.getJSONObject(it).getString("key") == key })
                assertTrue(call(scenario, "request", JSONObject().put("operation", "delete").put("key", key)).getBoolean("ok"))
                assertTrue(call(scenario, "request", JSONObject().put("operation", "head").put("key", key)).isNull("value"))
                val secret = setup.getJSONObject("credentials").getString("secretAccessKey")
                val publicInfo = call(scenario, "info"); assertFalse(publicInfo.toString().contains(secret))
                val encrypted = java.io.File(context.filesDir, "cloud-settings-v1.enc").readBytes(); assertFalse(encrypted.toString(Charsets.UTF_8).contains(secret))
                val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }; assertNull(store.getKey("joplinu.cloud.credentials.v1", null).encoded)
                val reopened = AndroidCloudHost(context.applicationContext).invoke("info", JSONObject()); assertTrue("Keystore restore failed", reopened.getJSONObject("value").getBoolean("configured"))
                val targetSetup = JSONObject(setup.toString()); targetSetup.getJSONObject("config").put("prefix", "target/" + java.util.UUID.randomUUID())
                val target = call(scenario, "openTarget", targetSetup).getJSONObject("value"); val handle = target.getString("handle")
                try {
                    val request = JSONObject().put("target", handle).put("expectedConfig", target.getJSONObject("config")).put("key", "migration.bin")
                    assertTrue(call(scenario, "request", JSONObject(request.toString()).put("operation", "put").put("data", "AP+A")).getBoolean("ok"))
                    assertEquals("AP+A", call(scenario, "request", JSONObject(request.toString()).put("operation", "get")).getString("value"))
                    assertEquals(setup.getJSONObject("config").getString("prefix"), call(scenario, "info").getJSONObject("value").getJSONObject("config").getString("prefix"))
                } finally { assertTrue(call(scenario, "closeTarget", JSONObject().put("handle", handle)).getBoolean("ok")) }
                // Extend this same native scenario through the real React UI,
                // Web Crypto, SQLite outbox and native transport. No mocked sync.
                awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地'))")
                evaluate(scenario, "document.querySelector('button[aria-label=\"打开设置\"]').click(); true")
                awaitTrue(scenario, "Boolean(document.querySelector('.settings-nav'))")
                evaluate(scenario, "[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent.includes('同步')).click(); true")
                awaitTrue(scenario, "Boolean(document.querySelector('.sync-settings form'))")
                val password = JSONObject.quote("native-sync-" + java.util.UUID.randomUUID())
                evaluate(scenario, "document.querySelectorAll('.sync-settings input[type=password]').forEach(input=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,$password);input.dispatchEvent(new Event('input',{bubbles:true}));}); true")
                evaluate(scenario, "document.querySelector('.sync-settings form button').click(); true")
                awaitTrue(scenario, "Boolean(document.querySelector('.sync-settings')?.textContent.includes('同步库已连接，本轮同步完成'))")
                val remote = call(scenario, "request", JSONObject().put("operation", "list").put("key", "vaults/")).getJSONObject("value").getJSONArray("objects")
                assertTrue("No encrypted update uploaded", (0 until remote.length()).any { remote.getJSONObject(it).getString("key").contains("/updates/") })
                evaluate(scenario, "document.querySelector('button[aria-label=\"关闭对话框\"]').click(); true")
                evaluate(scenario, "(()=>{const input=document.querySelector('input[aria-label=\"笔记标题\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'后台密文队列验证');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()")
                evaluate(scenario, "window.__cipherQueued=false;(async()=>{for(let n=0;n<200;n++){const record=await window.Capacitor.Plugins.JoplinuDatabase.read();if(JSON.parse(record.payload).sync?.outbox.length){window.__cipherQueued=true;return;}await new Promise(resolve=>setTimeout(resolve,100));}})();true")
                awaitTrue(scenario, "window.__cipherQueued === true")
                assertTrue(call(scenario, "scheduleTransfer").getJSONObject("value").getBoolean("available"))
                scenario.onActivity { activity -> activity.bridge.webView.pauseTimers() }
                scenario.moveToState(Lifecycle.State.CREATED)
                val backgroundState = context.getSharedPreferences("joplinu-encrypted-transfer", android.content.Context.MODE_PRIVATE)
                // Android may defer a background Job indefinitely. Trigger its
                // real system JobService deterministically; do not mock Worker,
                // network, SQLite or credentials and do not use background JS.
                val defaultScheduler = context.getSystemService(JobScheduler::class.java)
                val scheduler = if (Build.VERSION.SDK_INT >= 34) defaultScheduler.forNamespace("androidx.work.systemjobscheduler") else defaultScheduler
                val scheduledDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (scheduler.allPendingJobs.isEmpty() && backgroundState.getInt("objects", 0) == 0 && System.nanoTime() < scheduledDeadline) Thread.sleep(100)
                if (backgroundState.getInt("objects", 0) == 0) for (job in scheduler.allPendingJobs) {
                    val namespace = if (Build.VERSION.SDK_INT >= 34) "-n androidx.work.systemjobscheduler " else ""
                    val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cmd jobscheduler run -f ${namespace}${context.packageName} ${job.id}")
                    ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
                }
                val backgroundDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
                while (backgroundState.getInt("objects", 0) == 0) {
                    if (System.nanoTime() >= backgroundDeadline) {
                        val states = WorkManager.getInstance(context).getWorkInfosForUniqueWork("joplinu-encrypted-once").get(10, TimeUnit.SECONDS).map { "${it.state}/${it.runAttemptCount}" }
                        val connectivity = context.getSystemService(ConnectivityManager::class.java); val network = connectivity.activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
                        throw AssertionError("WorkManager upload timeout; error=${backgroundState.getString("error", "none")}; states=$states; internet=${network?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)}; validated=${network?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)}")
                    }
                    Thread.sleep(200)
                }
                // A background transfer does not change the foreground revision
                // or silently acknowledge the CRDT queue.
                SQLiteDatabase.openDatabase(context.getDatabasePath("joplinu-v2.sqlite").path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
                    val payload = StringBuilder(); database.rawQuery("SELECT payload FROM chunks ORDER BY ordinal", null).use { cursor -> while (cursor.moveToNext()) payload.append(cursor.getString(0)) }
                    assertTrue("Background upload acknowledged the foreground queue", JSONObject(payload.toString()).getJSONObject("sync").getJSONArray("outbox").length() > 0)
                }
                scenario.moveToState(Lifecycle.State.RESUMED)
                scenario.onActivity { activity -> activity.bridge.webView.resumeTimers() }
                scenario.recreate()
                awaitTrue(scenario, "Boolean(document.querySelector('footer')?.textContent.includes('已保存到本地'))")
                evaluate(scenario, "document.querySelector('button[aria-label=\"打开设置\"]').click(); true")
                awaitTrue(scenario, "Boolean(document.querySelector('.settings-nav'))")
                evaluate(scenario, "[...document.querySelectorAll('.settings-nav button')].find(button=>button.textContent.includes('同步')).click(); true")
                awaitTrue(scenario, "Boolean(document.querySelector('.sync-settings')?.textContent.includes('解锁同步密码'))")
                scenario.onActivity { activity -> activity.onBackPressedDispatcher.onBackPressed() }
                awaitTrue(scenario, "!document.querySelector('dialog[open]')")
                scenario.onActivity { activity -> activity.onBackPressedDispatcher.onBackPressed() }
                awaitTrue(scenario, "Boolean(document.querySelector('.library-shell')?.classList.contains('mobile-notes'))")
            } finally { scenario.onActivity { activity -> activity.bridge.webView.resumeTimers() }; call(scenario, "clear") }
        }
    }
}
