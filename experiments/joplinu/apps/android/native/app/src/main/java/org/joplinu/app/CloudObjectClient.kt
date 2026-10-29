package org.joplinu.app

import android.util.Base64
import android.util.Xml
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.net.HttpURLConnection
import java.net.URI
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLException

internal class CloudFailure(val kind: String, val operation: String = "head", val retryable: Boolean = false, val status: Int? = null) : Exception(kind)

/** Small foreground transport: SigV4 / OSS V4, standard HTTPS, no WebView CORS or credentials. */
internal class CloudObjectClient(val config: JSONObject, private val credentials: JSONObject) {
    private val kind = config.getString("kind")
    private val endpoint = URI(config.getString("endpoint"))
    private val bucket = config.getString("bucket")
    private val prefix = config.getString("prefix").trimEnd('/').let { if (it.isEmpty()) "" else "$it/" }
    private val region = config.getString("region").let { if (kind == "oss") it.removePrefix("oss-") else it }
    private val maxBytes = 64 * 1024 * 1024
    private data class Reply(val body: ByteArray, val headers: Map<String, String>)
    private fun hash(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(Locale.ROOT, it.toInt() and 255) }
    private fun hmac(key: ByteArray, value: String): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(value.toByteArray(Charsets.UTF_8)) }
    private fun encode(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val code = byte.toInt() and 255
            if (code in 65..90 || code in 97..122 || code in 48..57 || code == 45 || code == 46 || code == 95 || code == 126) append(code.toChar())
            else { append('%'); append("0123456789ABCDEF"[code ushr 4]); append("0123456789ABCDEF"[code and 15]) }
        }
    }
    private fun path(value: String) = value.split('/').joinToString("/") { encode(it) }
    private fun key(value: String, empty: Boolean = false): String {
        if ((!empty && value.isEmpty()) || value.startsWith('/') || value.contains('\\') || value.contains("//") || value.any { it.code < 32 || it.code == 127 } || value.split('/').any { it == "." || it == ".." } || (prefix + value).toByteArray(Charsets.UTF_8).size > 1024) throw CloudFailure("invalid-request")
        return prefix + value
    }
    private fun local(value: String): String {
        if (!value.startsWith(prefix)) throw CloudFailure("integrity", "list")
        val result = value.removePrefix(prefix); key(result); return result
    }
    private fun iso(): String = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    private fun authorization(method: String, canonicalPath: String, query: String, headers: MutableMap<String, String>, bytes: ByteArray): String {
        val timestamp = iso(); val day = timestamp.substring(0, 8)
        val access = credentials.getString("accessKeyId"); val secret = credentials.getString("secretAccessKey")
        val token = credentials.optString("sessionToken", "")
        val service = if (kind == "s3") "s3" else "oss"
        val end = if (kind == "s3") "aws4_request" else "aliyun_v4_request"
        val algorithm = if (kind == "s3") "AWS4-HMAC-SHA256" else "OSS4-HMAC-SHA256"
        val headerPrefix = if (kind == "s3") "x-amz-" else "x-oss-"
        headers[headerPrefix + "date"] = timestamp
        headers[headerPrefix + "content-sha256"] = if (kind == "s3") hash(bytes) else "UNSIGNED-PAYLOAD"
        if (token.isNotEmpty()) headers[headerPrefix + "security-token"] = token
        val signed = headers.keys.filter { if (kind == "s3") it == "host" || it.startsWith("x-amz-") else it == "content-type" || it == "content-md5" || it.startsWith("x-oss-") }.sorted()
        val headerText = signed.joinToString("") { "$it:${headers.getValue(it).trim()}\n" }
        val names = if (kind == "s3") signed.joinToString(";") else ""
        val canonical = listOf(method, canonicalPath, query, headerText, names, headers.getValue(headerPrefix + "content-sha256")).joinToString("\n")
        val scope = "$day/$region/$service/$end"
        val toSign = listOf(algorithm, timestamp, scope, hash(canonical.toByteArray(Charsets.UTF_8))).joinToString("\n")
        var signing = hmac(((if (kind == "s3") "AWS4" else "aliyun_v4") + secret).toByteArray(Charsets.UTF_8), day)
        signing = hmac(signing, region); signing = hmac(signing, service); signing = hmac(signing, end)
        val signature = hmac(signing, toSign).joinToString("") { "%02x".format(Locale.ROOT, it.toInt() and 255) }
        return if (kind == "s3") "$algorithm Credential=$access/$scope, SignedHeaders=$names, Signature=$signature" else "$algorithm Credential=$access/$scope,Signature=$signature"
    }
    private fun fields(xml: String, block: String? = null): Pair<MutableMap<String, String>, MutableList<Map<String, String>>> {
        val parser = Xml.newPullParser(); parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false); parser.setInput(StringReader(xml))
        val values = mutableMapOf<String, String>(); val objects = mutableListOf<Map<String, String>>(); var current: MutableMap<String, String>? = null
        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.DOCDECL || event == XmlPullParser.ENTITY_REF) throw CloudFailure("integrity", "list")
            if (event == XmlPullParser.START_TAG) {
                val name = parser.name
                if (name == block) current = mutableMapOf()
                else if (name in setOf("Key", "Size", "ETag", "LastModified", "NextContinuationToken", "IsTruncated", "Code")) (current ?: values)[name] = parser.nextText()
            } else if (event == XmlPullParser.END_TAG && parser.name == block) { current?.let { objects.add(it) }; current = null }
            event = parser.next()
        }
        return values to objects
    }
    private fun failure(status: Int, body: ByteArray, operation: String): CloudFailure {
        val code = try { fields(body.toString(Charsets.UTF_8)).first["Code"] ?: "" } catch (_: Exception) { "" }
        val kind = when {
            code in setOf("InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidSecurityToken", "SecurityTokenExpired", "ExpiredToken", "InvalidToken", "RequestTimeTooSkewed") || status == 401 -> "authentication"
            code in setOf("NoSuchBucket", "InvalidBucketName", "PermanentRedirect") || status == 301 -> "invalid-config"
            status == 404 -> "not-found"
            status == 403 -> "permission"
            status == 409 || status == 412 -> "conflict"
            status == 429 || code == "SlowDown" -> "throttled"
            status == 408 -> "timeout"
            status == 501 -> "unsupported"
            status >= 500 -> "network"
            else -> "invalid-request"
        }
        return CloudFailure(kind, operation, kind in setOf("network", "timeout", "throttled"), status)
    }
    private fun read(stream: java.io.InputStream?, max: Int): ByteArray {
        if (stream == null) return ByteArray(0)
        stream.use { input -> val out = ByteArrayOutputStream(); val buffer = ByteArray(16384)
            while (true) { val count = input.read(buffer); if (count < 0) break; if (out.size() + count > max) throw CloudFailure("limit-exceeded", "get"); out.write(buffer, 0, count) }
            return out.toByteArray()
        }
    }
    private fun request(operation: String, objectKey: String, queries: Map<String, String> = emptyMap(), body: ByteArray = ByteArray(0)): Reply {
        val method = mapOf("put" to "PUT", "get" to "GET", "head" to "HEAD", "list" to "GET", "delete" to "DELETE")[operation] ?: throw CloudFailure("unsupported")
        val virtual = if (kind == "s3") !config.getBoolean("forcePathStyle") else !config.getBoolean("useCname")
        val hostname = if (virtual) "$bucket.${endpoint.host}" else endpoint.host
        val authority = (if (hostname.contains(':') && !hostname.startsWith('[')) "[$hostname]" else hostname) + if (endpoint.port >= 0) ":${endpoint.port}" else ""
        val actualPath = if (kind == "s3" && !virtual) "/${encode(bucket)}/${path(objectKey)}" else "/${path(objectKey)}"
        val canonicalPath = if (kind == "oss") "/${encode(bucket)}/${path(objectKey)}" else actualPath
        val query = queries.entries.map { encode(it.key) to encode(it.value) }.sortedBy { it.first }.joinToString("&") { "${it.first}=${it.second}" }
        val target = "${endpoint.scheme}://$authority$actualPath${if (query.isEmpty()) "" else "?$query"}"
        for (attempt in 0..2) {
            val connection = java.net.URL(target).openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false; connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 15000
                connection.setRequestProperty("Accept-Encoding", "identity")
                val headers = mutableMapOf("host" to authority)
                if (operation == "put") headers["content-type"] = "application/octet-stream"
                val signed = authorization(method, canonicalPath, query, headers, body)
                for ((name, value) in headers) if (name != "host") connection.setRequestProperty(name, value)
                connection.setRequestProperty("Authorization", signed)
                if (operation == "put") { connection.doOutput = true; connection.setFixedLengthStreamingMode(body.size); connection.outputStream.use { it.write(body) } }
                val status = connection.responseCode
                if (status !in 200..299) throw failure(status, read(connection.errorStream, 65536), operation)
                val data = if (operation == "head" || operation == "delete" || operation == "put") ByteArray(0) else read(connection.inputStream, if (operation == "list") 4 * 1024 * 1024 else maxBytes)
                val length = connection.getHeaderField("Content-Length")?.toLongOrNull()
                if (operation == "get" && length != null && length != data.size.toLong()) throw CloudFailure("integrity", operation)
                val resultHeaders = mutableMapOf<String, String>(); for (name in listOf("Content-Length", "Last-Modified", "ETag", "Content-Type")) connection.getHeaderField(name)?.let { resultHeaders[name] = it }
                return Reply(data, resultHeaders)
            } catch (problem: Exception) {
                val error = when (problem) { is CloudFailure -> problem; is SSLException -> CloudFailure("tls", operation); is SocketTimeoutException -> CloudFailure("timeout", operation, true); else -> CloudFailure("network", operation, true) }
                if (!error.retryable || attempt == 2) throw error
                Thread.sleep((150L shl attempt) + kotlin.random.Random.nextLong(80))
            } finally { connection.disconnect() }
        }
        throw CloudFailure("network", operation)
    }
    fun perform(input: JSONObject): Any {
        val operation = input.getString("operation"); val relative = input.getString("key"); val remote = key(relative, operation == "list")
        return when (operation) {
            "put" -> { val encoded = input.getString("data"); if (encoded.length > 90 * 1024 * 1024) throw CloudFailure("limit-exceeded", operation); val body = Base64.decode(encoded, Base64.DEFAULT); if (body.size > maxBytes || Base64.encodeToString(body, Base64.NO_WRAP) != encoded) throw CloudFailure("invalid-request", operation); request(operation, remote, body = body); JSONObject.NULL }
            "get" -> Base64.encodeToString(request(operation, remote).body, Base64.NO_WRAP)
            "delete" -> { try { request(operation, remote) } catch (error: CloudFailure) { if (error.kind != "not-found") throw error }; JSONObject.NULL }
            "head" -> {
                val response = try { request(operation, remote) } catch (error: CloudFailure) { if (error.kind == "not-found") return JSONObject.NULL; throw error }
                val size = response.headers["Content-Length"]?.toLongOrNull() ?: throw CloudFailure("integrity", operation)
                if (size < 0) throw CloudFailure("integrity", operation)
                JSONObject().put("key", relative).put("size", size).also { value -> response.headers["ETag"]?.let { value.put("etag", it) }; response.headers["Content-Type"]?.let { value.put("contentType", it) } }
            }
            "list" -> {
                val queries = mutableMapOf("list-type" to "2", "prefix" to remote, "max-keys" to "1000")
                if (input.has("cursor")) { val cursor = input.getString("cursor"); if (cursor.length > 10000) throw CloudFailure("invalid-request", operation); queries["continuation-token"] = cursor }
                val parsed = fields(request(operation, "", queries).body.toString(Charsets.UTF_8), "Contents")
                if (parsed.second.size > 1000) throw CloudFailure("integrity", operation)
                val objects = JSONArray(); for (entry in parsed.second) { val name = entry["Key"] ?: throw CloudFailure("integrity", operation); if (!name.startsWith(remote)) throw CloudFailure("integrity", operation); val size = entry["Size"]?.toLongOrNull() ?: throw CloudFailure("integrity", operation); if (size < 0) throw CloudFailure("integrity", operation); objects.put(JSONObject().put("key", local(name)).put("size", size).apply { entry["ETag"]?.let { put("etag", it) } }) }
                JSONObject().put("objects", objects).apply { if (parsed.first["IsTruncated"] == "true") { val cursor = parsed.first["NextContinuationToken"]; if (cursor.isNullOrEmpty()) throw CloudFailure("integrity", operation); put("nextCursor", cursor) } }
            }
            else -> throw CloudFailure("unsupported", operation)
        }
    }
}
