package org.joplinu.app

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
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
            } finally { call(scenario, "clear") }
        }
    }
}
