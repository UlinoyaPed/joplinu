package org.joplinu.app

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/** No arbitrary SQL, file paths or credentials cross the WebView boundary. */
@CapacitorPlugin(name = "JoplinuDatabase")
class JoplinuDatabasePlugin : Plugin() {
    private val lock = Any()
    private val helper by lazy {
        object : SQLiteOpenHelper(context, "joplinu.sqlite", null, 1) {
            override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)")
                db.execSQL("INSERT INTO vault VALUES (1,0)")
                db.execSQL("CREATE TABLE chunks (ordinal INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
            }
            override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { throw IllegalStateException("Unsupported database migration") }
        }.also { it.setWriteAheadLoggingEnabled(true) }
    }

    @PluginMethod
    fun read(call: PluginCall) = synchronized(lock) {
        try {
            val db = helper.writableDatabase
            db.beginTransaction()
            var revision = 0L
            val payload = StringBuilder()
            try {
                db.rawQuery("SELECT revision FROM vault WHERE id=1", null).use { cursor -> check(cursor.moveToFirst()); revision = cursor.getLong(0) }
                // Keep individual rows below Android's CursorWindow limit, including CJK text.
                db.rawQuery("SELECT payload FROM chunks ORDER BY ordinal", null).use { cursor -> while (cursor.moveToNext()) payload.append(cursor.getString(0)) }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            call.resolve(JSObject().put("revision", revision).put("payload", if (revision == 0L) JSONObject.NULL else payload.toString()))
        } catch (_: Exception) { call.reject("无法读取本地 SQLite；原数据未重置") }
    }

    @PluginMethod
    fun write(call: PluginCall) = synchronized(lock) {
        val revision = call.getLong("expectedRevision")
        val payload = call.getString("payload")
        if (revision == null || revision < 0 || payload == null || payload.toByteArray(Charsets.UTF_8).size > 40 * 1024 * 1024) {
            call.reject("Invalid local save request"); return@synchronized
        }
        try {
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

    override fun handleOnDestroy() { synchronized(lock) { helper.close() } }
}
