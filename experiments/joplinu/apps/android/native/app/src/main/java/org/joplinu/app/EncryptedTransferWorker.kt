package org.joplinu.app

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseLockedException
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.util.Base64
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Only transfers already-encrypted durable bytes. Never decrypts notes, runs a
 * Yjs engine, changes the vault revision or acknowledges the foreground queue. */
class EncryptedTransferWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    companion object {
        private const val PERIODIC = "joplinu-encrypted-periodic"
        private const val ONCE = "joplinu-encrypted-once"
        private const val PREFS = "joplinu-encrypted-transfer"
        // A private S3/OSS endpoint may be reachable on Wi-Fi/VPN even when
        // Android cannot validate public Internet access against its probes.
        private fun constraints() = Constraints.Builder().setRequiredNetworkRequest(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), NetworkType.CONNECTED).build()
        fun schedule(context: Context, config: JSONObject, periodic: Boolean) {
            val data = Data.Builder().putString("config", config.toString()).build()
            val manager = WorkManager.getInstance(context)
            if (periodic) manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<EncryptedTransferWorker>(15, TimeUnit.MINUTES).setConstraints(constraints()).setInputData(data).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
            else {
                val request = OneTimeWorkRequestBuilder<EncryptedTransferWorker>().setConstraints(constraints()).setInputData(data).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                if (Build.VERSION.SDK_INT >= 31) request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                manager.enqueueUniqueWork(ONCE, ExistingWorkPolicy.KEEP, request.build())
            }
        }
        fun cancel(context: Context) { WorkManager.getInstance(context).apply { cancelUniqueWork(PERIODIC); cancelUniqueWork(ONCE) }; context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() }
        fun info(context: Context, available: Boolean): JSONObject {
            val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return JSONObject().put("supported", true).put("available", available).apply {
                if (preferences.contains("lastTransfer")) put("lastTransfer", preferences.getLong("lastTransfer", 0))
                if (preferences.contains("objects")) put("objects", preferences.getInt("objects", 0))
                preferences.getString("error", null)?.let { put("error", it) }
            }
        }
    }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun payload(): JSONObject? {
        val path = applicationContext.getDatabasePath("joplinu-v2.sqlite"); if (!path.isFile) return null
        SQLiteDatabase.openDatabase(path.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
            // A consistent read of metadata chunks; the worker never reads or
            // rewrites note journal BLOBs. The foreground remains the sole writer.
            if (Build.VERSION.SDK_INT >= 35) database.beginTransactionReadOnly() else database.beginTransactionNonExclusive()
            try {
                val text = StringBuilder()
                database.rawQuery("SELECT ordinal,payload FROM chunks ORDER BY ordinal", null).use { cursor ->
                    var ordinal = 0
                    while (cursor.moveToNext()) { require(cursor.getInt(0) == ordinal++); text.append(cursor.getString(1)); require(text.length <= 40 * 1024 * 1024) }
                }
                database.setTransactionSuccessful(); return if (text.isEmpty()) null else JSONObject(text.toString()).optJSONObject("sync")
            } finally { database.endTransaction() }
        }
    }
    override fun doWork(): Result {
        val preferences = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        try {
            val expected = JSONObject(inputData.getString("config") ?: return Result.success())
            val host = AndroidCloudHost(applicationContext, false)
            val info = host.invoke("info", JSONObject()).getJSONObject("value")
            if (!info.getBoolean("configured") || !info.getJSONObject("background").getBoolean("available")) return Result.success()
            val current = info.getJSONObject("config")
            for (field in current.keys()) if (current.get(field) != expected.opt(field)) return Result.success()
            val state = payload() ?: return Result.success()
            if (!state.optBoolean("autoSync", false)) return Result.success()
            require(state.getInt("version") == 1)
            val queue = state.getJSONArray("outbox"); require(queue.length() <= 20000)
            if (queue.length() == 0) return Result.success()
            val manifest = state.getJSONObject("manifest"); val vault = manifest.getString("vault"); val key = manifest.getString("key")
            require(Regex("[a-f0-9-]{36}").matches(vault) && Regex("[a-f0-9-]{36}").matches(key) && manifest.getInt("version") == 1 && manifest.getString("format") == "JoplinU sync key")
            val root = "vaults/$vault/"
            fun call(operation: String, path: String, data: String? = null): Any {
                val request = JSONObject().put("operation", operation).put("key", path).put("expectedConfig", expected); if (data != null) request.put("data", data)
                val response = host.invoke("request", request)
                if (!response.getBoolean("ok")) { val failure = response.getJSONObject("error"); throw CloudFailure(failure.getString("kind"), operation, failure.optBoolean("retryable")) }
                return response.get("value")
            }
            val manifestPath = root + "keys/$key.json"
            val manifestBytes = manifest.toString().toByteArray(Charsets.UTF_8)
            if (call("head", manifestPath) == JSONObject.NULL) call("put", manifestPath, Base64.encodeToString(manifestBytes, Base64.NO_WRAP))
            if (digest(Base64.decode(call("get", manifestPath) as String, Base64.DEFAULT)) != digest(manifestBytes)) throw CloudFailure("integrity", "get")
            val scope = digest((current.toString() + root).toByteArray(Charsets.UTF_8))
            val previous = if (preferences.getString("scope", null) == scope) JSONObject(preferences.getString("completed", "{}") ?: "{}") else JSONObject()
            val completed = JSONObject(); val valid = mutableSetOf<String>()
            for (index in 0 until queue.length()) valid.add(queue.getJSONObject(index).getString("path"))
            for (path in previous.keys()) if (path in valid) completed.put(path, previous.getString(path))
            var count = 0; val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(8)
            for (index in 0 until queue.length()) {
                if (isStopped || System.nanoTime() > deadline) return Result.retry()
                val item = queue.getJSONObject(index); val path = item.getString("path"); val hash = item.getString("hash")
                require(path.startsWith(root + "updates/") || path.startsWith(root + "snapshots/")); require(Regex("[a-f0-9]{64}").matches(hash))
                if (completed.optString(path) == hash) continue
                val encoded = item.getString("ciphertext"); require(encoded.length <= 66 * 1024 * 1024)
                val bytes = Base64.decode(encoded, Base64.DEFAULT); if (digest(bytes) != hash) throw CloudFailure("integrity", "put")
                if (call("head", path) == JSONObject.NULL) call("put", path, encoded)
                if (digest(Base64.decode(call("get", path) as String, Base64.DEFAULT)) != hash) throw CloudFailure("integrity", "get")
                completed.put(path, hash); count++
                // Separate transport checkpoint only. The immutable ciphertext
                // remains in SQLite until the foreground validates/acknowledges.
                check(preferences.edit().putString("scope", scope).putString("completed", completed.toString()).putLong("lastTransfer", System.currentTimeMillis()).putInt("objects", count).remove("error").commit())
            }
            return Result.success()
        } catch (problem: Exception) {
            val failure = if (problem is SQLiteDatabaseLockedException) CloudFailure("local-database-busy", retryable = true) else problem as? CloudFailure
            preferences.edit().putString("error", failure?.kind ?: "operation-failed").commit()
            return if (failure?.retryable == true || failure?.kind in setOf("network", "timeout", "throttled")) Result.retry() else Result.failure()
        }
    }
}
