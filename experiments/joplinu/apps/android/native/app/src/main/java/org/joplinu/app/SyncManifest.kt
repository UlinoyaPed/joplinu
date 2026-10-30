package org.joplinu.app

import android.util.Base64
import android.util.JsonWriter
import org.json.JSONObject
import java.io.StringWriter

/** Stable wire JSON shared with JavaScript. JSONObject.toString escapes '/',
 * which made random base64 key envelopes fail byte comparisons intermittently. */
internal object SyncManifest {
    fun encode(value: JSONObject): ByteArray {
        for (field in listOf("format", "vault", "key", "kdf", "salt", "iv", "wrapped")) require(value.get(field) is String)
        require(value.getString("format") == "JoplinU sync key" && value.get("version") == 1)
        require(value.getString("kdf") == "PBKDF2-SHA256" && value.get("iterations") == 600000)
        for (field in listOf("vault", "key")) require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(value.getString(field)))
        for ((field, size) in listOf("salt" to 16, "iv" to 12, "wrapped" to 48)) {
            val encoded = value.getString(field)
            require(encoded.length <= 64 && Regex("[A-Za-z0-9+/]*={0,2}").matches(encoded) && Base64.decode(encoded, Base64.DEFAULT).size == size)
        }
        val text = StringWriter()
        JsonWriter(text).use { writer ->
            writer.beginObject()
            writer.name("format").value(value.getString("format")); writer.name("version").value(1L)
            for (field in listOf("vault", "key", "kdf")) writer.name(field).value(value.getString(field))
            writer.name("iterations").value(600000L)
            for (field in listOf("salt", "iv", "wrapped")) writer.name(field).value(value.getString(field))
            writer.endObject()
        }
        return text.toString().toByteArray(Charsets.UTF_8)
    }
    /** Formatting equivalence never permits a different wrapped key or KDF. */
    fun matches(bytes: ByteArray, expected: JSONObject): Boolean = bytes.size <= 4096 && runCatching {
        encode(JSONObject(bytes.toString(Charsets.UTF_8))).contentEquals(encode(expected))
    }.getOrDefault(false)
}
