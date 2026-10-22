package org.joplinu.app

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.MessageDigest

@CapacitorPlugin(name = "JoplinuStorage")
class JoplinuStoragePlugin : Plugin() {
    private val idPattern = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    private val maxUpdate = 8 * 1024 * 1024
    private val helper by lazy {
        object : SQLiteOpenHelper(context, "joplinu-notes.sqlite", null, 1) {
            override fun onConfigure(db: SQLiteDatabase) {
                db.enableWriteAheadLogging()
                db.execSQL("PRAGMA synchronous=FULL")
            }
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE note_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, data BLOB NOT NULL, checksum TEXT NOT NULL)")
                db.execSQL("CREATE INDEX note_updates_by_note ON note_updates(note_id, seq)")
            }
            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
                throw IllegalStateException("No destructive database migrations")
            }
        }
    }
    private fun requireId(call: PluginCall): String {
        val id = call.getString("noteId") ?: throw IllegalArgumentException("Missing noteId")
        require(idPattern.matches(id)) { "Invalid document identifier" }
        return id
    }
    private fun checksum(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    @PluginMethod
    fun read(call: PluginCall) {
        try {
            val id = requireId(call)
            val updates = JSArray()
            helper.readableDatabase.rawQuery(
                "SELECT data, checksum FROM note_updates WHERE note_id = ? ORDER BY seq", arrayOf(id)
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val data = cursor.getBlob(0)
                    check(checksum(data) == cursor.getString(1)) { "Local update checksum mismatch" }
                    updates.put(Base64.encodeToString(data, Base64.NO_WRAP))
                }
            }
            val result = JSObject()
            result.put("updates", updates)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject("Local document recovery failed: " + error.message)
        }
    }
    @PluginMethod
    fun append(call: PluginCall) {
        try {
            val id = requireId(call)
            val encoded = call.getString("update") ?: throw IllegalArgumentException("Missing update")
            require(encoded.length <= (maxUpdate / 3 + 2) * 4) { "Update too large" }
            val data = Base64.decode(encoded, Base64.DEFAULT)
            require(data.isNotEmpty() && data.size <= maxUpdate) { "Invalid update size" }
            val db = helper.writableDatabase
            db.beginTransaction()
            try {
                val values = android.content.ContentValues().apply {
                    put("note_id", id)
                    put("data", data)
                    put("checksum", checksum(data))
                }
                check(db.insertOrThrow("note_updates", null, values) != -1L)
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve()
        } catch (error: Exception) {
            call.reject("Local document save failed: " + error.message)
        }
    }
}
