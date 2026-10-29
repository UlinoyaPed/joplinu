package org.joplinu.app

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import org.json.JSONArray
import android.util.Base64
import java.security.MessageDigest

/** No arbitrary SQL, file paths or credentials cross the WebView boundary. */
@CapacitorPlugin(name = "JoplinuDatabase")
class JoplinuDatabasePlugin : Plugin() {
    private val lock = Any()
    private val helperDelegate = lazy {
        object : SQLiteOpenHelper(context, "joplinu-v2.sqlite", null, 1) {
            override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)")
                db.execSQL("INSERT INTO vault VALUES (1,0)")
                db.execSQL("CREATE TABLE chunks (ordinal INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
                db.execSQL("CREATE TABLE note_updates (note_id TEXT NOT NULL, revision INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(note_id,revision))")
                db.execSQL("CREATE TABLE note_update_chunks (note_id TEXT NOT NULL, revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(note_id,revision,ordinal))")
            }
            override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { throw IllegalStateException("Unsupported database migration") }
        }.also { it.setWriteAheadLoggingEnabled(true) }
    }
    private val helper get() = helperDelegate.value

    private val noteId = Regex("[a-zA-Z0-9-]{1,100}")
    private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    @PluginMethod
    fun read(call: PluginCall) = synchronized(lock) {
        try {
            val db = helper.writableDatabase
            db.beginTransaction()
            var revision = 0L
            val payload = StringBuilder()
            val journals = JSONObject()
            try {
                db.rawQuery("SELECT revision FROM vault WHERE id=1", null).use { cursor -> check(cursor.moveToFirst()); revision = cursor.getLong(0) }
                // Keep individual rows below Android's CursorWindow limit, including CJK text.
                db.rawQuery("SELECT payload FROM chunks ORDER BY ordinal", null).use { cursor -> while (cursor.moveToNext()) payload.append(cursor.getString(0)) }
	            db.rawQuery("SELECT note_id, revision, checksum FROM note_updates ORDER BY note_id,revision", null).use { cursor ->
                    while (cursor.moveToNext()) {
                        val id = cursor.getString(0)
                        val updateRevision = cursor.getLong(1)
                        val expected = cursor.getString(2)
                        val output = java.io.ByteArrayOutputStream()
                        db.rawQuery("SELECT data FROM note_update_chunks WHERE note_id=? AND revision=? ORDER BY ordinal", arrayOf(id, updateRevision.toString())).use { chunks ->
                            while (chunks.moveToNext()) {
                                val bytes = chunks.getBlob(0)
                                require(output.size() + bytes.size <= 8 * 1024 * 1024) { "Yjs journal too large" }
                                output.write(bytes)
                            }
                        }
                        val data = output.toByteArray()
                        check(data.isNotEmpty() && digest(data) == expected) { "Yjs journal checksum mismatch" }
                        val list = journals.optJSONArray(id) ?: JSONArray().also { journals.put(id, it) }
                        list.put(Base64.encodeToString(data, Base64.NO_WRAP))
                    }
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve(JSObject().put("revision", revision).put("payload", if (revision == 0L) JSONObject.NULL else payload.toString()).put("noteUpdates", journals))
        } catch (_: Exception) { call.reject("无法读取本地 SQLite；原数据未重置") }
    }

    @PluginMethod
    fun write(call: PluginCall) = synchronized(lock) {
        // Capacitor getLong only accepts java.lang.Long; JSON stores small values as Integer.
        val rawRevision = call.data.opt("expectedRevision") as? Number
        val revision = rawRevision?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it < 9007199254740991.0 && it % 1.0 == 0.0 }?.toLong()
        val payload = call.getString("payload")
        val journal = call.data.optJSONObject("journal") ?: JSONObject().put("updates", JSONObject()).put("replace", JSONArray()).put("remove", JSONArray())
        if (revision == null || revision < 0 || payload == null || payload.toByteArray(Charsets.UTF_8).size > 40 * 1024 * 1024) {
            call.reject("Invalid local save request"); return@synchronized
        }
        try {
            val changed = journal.getJSONObject("updates")
            val replace = journal.getJSONArray("replace")
            val remove = journal.getJSONArray("remove")
            require(changed.length() <= 10000 && replace.length() <= 10000 && remove.length() <= 10000)
            val updateValues = mutableListOf<Triple<String, ByteArray, String>>()
            for (id in changed.keys()) {
                require(noteId.matches(id))
                val encoded = changed.getString(id)
                require(encoded.length <= (8 * 1024 * 1024 / 3 + 2) * 4)
                val data = Base64.decode(encoded, Base64.DEFAULT)
                require(data.isNotEmpty() && data.size <= 8 * 1024 * 1024)
                updateValues.add(Triple(id, data, digest(data)))
            }
            val dropIds = mutableSetOf<String>()
            for (i in 0 until replace.length()) {
                val id = replace.getString(i)
                require(noteId.matches(id) && changed.has(id))
                dropIds.add(id)
            }
            for (i in 0 until remove.length()) {
                val id = remove.getString(i)
                require(noteId.matches(id) && !changed.has(id))
                dropIds.add(id)
            }
            val parsed = JSONObject(payload)
            require(parsed.getInt("schema") == 1)
            parsed.getJSONArray("notes"); parsed.getJSONArray("folders")
            val db = helper.writableDatabase
            db.beginTransaction()
            try {
                val statement = db.compileStatement("UPDATE vault SET revision=revision+1 WHERE id=1 AND revision=?")
                val changed = statement.use { it.bindLong(1, revision); it.executeUpdateDelete() }
                if (changed != 1) throw IllegalStateException("Revision conflict")
                db.execSQL("DELETE FROM chunks")
                db.compileStatement("INSERT INTO chunks (ordinal,payload) VALUES (?,?)").use { insert ->
                    var offset = 0
                    var ordinal = 0L
                    while (offset < payload.length) {
                        var end = minOf(offset + 128 * 1024, payload.length)
                        if (end < payload.length && Character.isHighSurrogate(payload[end - 1])) end--
                        insert.bindLong(1, ordinal++)
                        insert.bindString(2, payload.substring(offset, end))
                        insert.executeInsert()
                        offset = end
                    }
                }
                val removeChunks = db.compileStatement("DELETE FROM note_update_chunks WHERE note_id=?")
                removeChunks.use { statement ->
                    for (id in dropIds) { statement.clearBindings(); statement.bindString(1, id); statement.executeUpdateDelete() }
                }
                val delete = db.compileStatement("DELETE FROM note_updates WHERE note_id=?")
                delete.use { statement ->
                    for (id in dropIds) { statement.clearBindings(); statement.bindString(1, id); statement.executeUpdateDelete() }
                }
                val insertUpdate = db.compileStatement("INSERT INTO note_updates (note_id,revision,checksum) VALUES (?,?,?)")
                val insertChunk = db.compileStatement("INSERT INTO note_update_chunks (note_id,revision,ordinal,data) VALUES (?,?,?,?)")
                insertUpdate.use { header ->
                    insertChunk.use { chunk ->
                        for ((id, data, hash) in updateValues) {
                            header.clearBindings()
                            header.bindString(1, id)
                            header.bindLong(2, revision + 1)
                            header.bindString(3, hash)
                            header.executeInsert()
                            var offset = 0
                            var ordinal = 0L
                            while (offset < data.size) {
                                val next = minOf(offset + 64 * 1024, data.size)
                                chunk.clearBindings()
                                chunk.bindString(1, id)
                                chunk.bindLong(2, revision + 1)
                                chunk.bindLong(3, ordinal++)
                                chunk.bindBlob(4, data.copyOfRange(offset, next))
                                chunk.executeInsert()
                                offset = next
                            }
                        }
                    }
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve(JSObject().put("revision", revision + 1))
        } catch (_: Exception) { call.reject("保存未提交；可能存在其他窗口修改或存储故障。请导出备份后重试。") }
    }

    @PluginMethod
    fun check(call: PluginCall) = synchronized(lock) {
        try {
            helper.readableDatabase.rawQuery("PRAGMA quick_check", null).use { cursor ->
                check(cursor.moveToFirst())
                call.resolve(JSObject().put("result", cursor.getString(0)))
            }
        } catch (_: Exception) { call.reject("SQLite 完整性检查失败") }
    }

    override fun handleOnDestroy() { synchronized(lock) { if (helperDelegate.isInitialized()) helper.close() }; super.handleOnDestroy() }
}
