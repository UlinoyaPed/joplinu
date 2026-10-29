package org.joplinu.app

import android.content.Context
import android.content.pm.ApplicationInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.security.SecureRandom
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Native credentials and requests. No cloud keys are returned to JavaScript. */
@CapacitorPlugin(name = "JoplinuCloud")
class JoplinuCloudPlugin : Plugin() {
    private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(16))
    companion object { @Volatile private var shared: AndroidCloudHost? = null }
    private fun host(): AndroidCloudHost = synchronized(JoplinuCloudPlugin::class.java) { shared ?: AndroidCloudHost(context.applicationContext).also { shared = it } }
    private fun handle(method: String, call: PluginCall) {
        try { executor.execute { call.resolve(host().invoke(method, call.data)) } }
        catch (_: java.util.concurrent.RejectedExecutionException) { call.resolve(JSObject().put("ok", false).put("error", JSObject().put("kind", "conflict"))) }
    }
    @PluginMethod fun info(call: PluginCall) = handle("info", call)
    @PluginMethod fun configure(call: PluginCall) = handle("configure", call)
    @PluginMethod fun probe(call: PluginCall) = handle("probe", call)
    @PluginMethod fun request(call: PluginCall) = handle("request", call)
    @PluginMethod fun clear(call: PluginCall) = handle("clear", call)
    override fun handleOnDestroy() { executor.shutdownNow(); super.handleOnDestroy() }
}

internal class AndroidCloudHost(context: Context) {
    private data class Profile(val config: JSONObject, val credentials: JSONObject)
    private val file = AtomicFile(File(context.filesDir, "cloud-settings-v1.enc"))
    private val alias = "joplinu.cloud.credentials.v1"
    private val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    private var active: Profile? = null
    private var loaded = false
    private var error: String? = null
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) throw IllegalStateException("No credential key")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build()); generateKey()
        }
    }
    private fun secure(): Boolean = try { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }; true } catch (_: Exception) { false }
    private fun encrypt(profile: Profile) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true))
        check(cipher.iv.size == 12)
        val plain = JSONObject().put("config", profile.config).put("credentials", profile.credentials).toString().toByteArray(Charsets.UTF_8)
        val value = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
        val stream = file.startWrite()
        try { stream.write(value); file.finishWrite(stream) } catch (problem: Exception) { file.failWrite(stream); throw problem }
    }
    private fun load() {
        if (loaded) return; loaded = true
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return
        try {
            if (file.baseFile.length() > 128 * 1024) throw IllegalStateException("Invalid credential file")
            val bytes = file.readFully(); require(bytes.size >= 30 && bytes[0] == 1.toByte())
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
            active = profile(JSONObject(cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8)))
        } catch (_: Exception) { error = "无法解锁已保管的云配置，文件保持原样。可重新配置或清除云配置。" }
    }
    private fun profile(input: JSONObject): Profile {
        val raw = input.optJSONObject("config") ?: throw CloudFailure("invalid-config")
        val kind = raw.optString("kind"); if (kind !in setOf("s3", "oss")) throw CloudFailure("invalid-config")
        val rawEndpoint = raw.optString("endpoint").trim(); if (rawEndpoint.length > 2048) throw CloudFailure("invalid-config")
        val uri = try { URI(if (rawEndpoint.contains("://")) rawEndpoint else "https://$rawEndpoint") } catch (_: Exception) { throw CloudFailure("invalid-config") }
        val host = uri.host?.lowercase() ?: throw CloudFailure("invalid-config")
        val loopback = host.trim('[', ']') in setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")
        if ((uri.scheme != "https" && !(debuggable && uri.scheme == "http" && loopback)) || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null || uri.path !in setOf("", "/") || uri.port !in -1..65535 || uri.port == 0) throw CloudFailure("invalid-config")
        val defaultPort = uri.port < 0 || (uri.scheme == "https" && uri.port == 443) || (uri.scheme == "http" && uri.port == 80)
        val endpoint = "${uri.scheme}://${if (host.contains(':') && !host.startsWith('[')) "[$host]" else host}${if (defaultPort) "" else ":${uri.port}"}"
        val bucket = raw.optString("bucket"); if (!Regex("[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}").matches(bucket)) throw CloudFailure("invalid-config")
        val prefix = raw.optString("prefix"); if (prefix.startsWith('/') || prefix.contains('\\') || prefix.contains("//") || prefix.any { it.code < 32 || it.code == 127 } || prefix.split('/').any { it == "." || it == ".." } || prefix.toByteArray(Charsets.UTF_8).size > 800) throw CloudFailure("invalid-config")
        var region = raw.optString("region").trim()
        if (kind == "oss" && region.isEmpty()) region = Regex("^oss-([a-z0-9-]+?)(?:-internal)?\\.aliyuncs\\.com$").find(host)?.groupValues?.get(1) ?: ""
        if (region.isEmpty() || !Regex("[a-zA-Z0-9_-]{1,128}").matches(region) || (kind == "oss" && region.startsWith("accelerate"))) throw CloudFailure("invalid-config")
        if (raw.opt("forcePathStyle") !is Boolean || raw.opt("useCname") !is Boolean) throw CloudFailure("invalid-config")
        val config = JSONObject().put("kind", kind).put("endpoint", endpoint).put("region", region).put("bucket", bucket).put("prefix", prefix.trimEnd('/')).put("forcePathStyle", raw.getBoolean("forcePathStyle")).put("useCname", raw.getBoolean("useCname"))
        val previous = active?.takeIf { it.config.getString("kind") == kind && it.config.getString("endpoint") == endpoint }?.credentials
        val rawKeys = input.optJSONObject("credentials") ?: previous ?: throw CloudFailure("credentials-unavailable")
        val keys = JSONObject()
        for (field in listOf("accessKeyId", "secretAccessKey")) {
            val value = rawKeys.optString(field); if (value.isEmpty() || value.length > 4096 || value.any { it.code < 32 || it.code == 127 }) throw CloudFailure("invalid-config"); keys.put(field, value)
        }
        if (rawKeys.has("sessionToken")) { val token = rawKeys.getString("sessionToken"); if (token.isEmpty() || token.length > 16384 || token.any { it.code < 32 || it.code == 127 }) throw CloudFailure("invalid-config"); keys.put("sessionToken", token) }
        return Profile(config, keys)
    }
    private fun info(): JSONObject = JSONObject().put("supported", true).put("configured", active != null).put("secureStorage", secure()).put("persisted", file.baseFile.exists()).apply { active?.let { put("config", it.config) }; error?.let { put("error", it) } }
    @Synchronized fun invoke(method: String, input: JSONObject): JSObject {
        try {
            load()
            val result: Any = when (method) {
                "info" -> info()
                "configure" -> { if (input.opt("persist") !is Boolean) throw CloudFailure("invalid-config"); val next = profile(input); if (input.getBoolean("persist")) { if (!secure()) throw CloudFailure("secure-storage-unavailable"); encrypt(next) }; active = next; error = null; info() }
                "clear" -> { file.delete(); active = null; error = null; info() }
                "request" -> { val value = active ?: throw CloudFailure("not-configured"); CloudObjectClient(value.config, value.credentials).perform(input) }
                "probe" -> { val value = active ?: throw CloudFailure("not-configured"); probe(CloudObjectClient(value.config, value.credentials)) }
                else -> throw CloudFailure("unsupported")
            }
            return JSObject().put("ok", true).put("value", result)
        } catch (problem: Exception) {
            val failure = problem as? CloudFailure ?: CloudFailure("operation-failed")
            return JSObject().put("ok", false).put("error", JSONObject().put("kind", failure.kind).put("operation", failure.operation).put("retryable", failure.retryable).apply { failure.status?.let { put("status", it) } })
        }
    }
    private fun probe(client: CloudObjectClient): JSONObject {
        val namespace = "__joplinu_connection_test/${java.util.UUID.randomUUID()}/"; val name = namespace + "probe.bin"
        val bytes = ByteArray(128).also { SecureRandom().nextBytes(it) }; val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val steps = JSONArray(); var success = true
        fun attempt(operation: String, action: () -> Unit): Boolean {
            try { action(); steps.put(JSONObject().put("operation", operation).put("status", "ok")); return true }
            catch (problem: Exception) { success = false; steps.put(JSONObject().put("operation", operation).put("status", "failed").put("error", (problem as? CloudFailure)?.kind ?: "network")); return false }
        }
        fun call(operation: String, key: String = name): Any = client.perform(JSONObject().put("operation", operation).put("key", key))
        attempt("list") { call("list", namespace) }
        var clean = false
        try {
            val written = attempt("put") { client.perform(JSONObject().put("operation", "put").put("key", name).put("data", encoded)) }
            if (written) {
                attempt("head") { if ((call("head") as? JSONObject)?.optLong("size") != 128L) throw CloudFailure("integrity", "head") }
                attempt("get") { if (call("get") != encoded) throw CloudFailure("integrity", "get") }
                attempt("list") { val objects = (call("list", namespace) as JSONObject).getJSONArray("objects"); if (!(0 until objects.length()).any { objects.getJSONObject(it).getString("key") == name }) throw CloudFailure("integrity", "list") }
            } else for (operation in listOf("head", "get")) steps.put(JSONObject().put("operation", operation).put("status", "not-tested"))
        } finally { clean = attempt("delete") { call("delete"); if (call("head") != JSONObject.NULL) throw CloudFailure("integrity", "delete") } }
        return JSONObject().put("ok", success).put("steps", steps).put("cleanup", if (clean) "ok" else "failed").put("leftoverKeys", JSONArray().apply { if (!clean) put(name) })
    }
}
