const { DatabaseSync } = require('node:sqlite');

const MAX_BYTES = 40 * 1024 * 1024;
class VaultDatabase {
	constructor(filename) {
		this.database = new DatabaseSync(filename);
		try { this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT); INSERT OR IGNORE INTO vault VALUES (1, 0, NULL);'); }
		catch (error) { this.database.close(); throw error; }
	}
	read() { return this.database.prepare('SELECT revision, payload FROM vault WHERE id=1').get(); }
	write({ expectedRevision, payload }) {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Invalid local save request');
		const parsed = JSON.parse(payload);
		if (parsed.schema !== 1 || !Array.isArray(parsed.notes) || !Array.isArray(parsed.folders)) throw new Error('Invalid vault format');
		const result = this.database.prepare('UPDATE vault SET revision=revision+1, payload=? WHERE id=1 AND revision=?').run(payload, expectedRevision);
		if (result.changes !== 1) throw new Error('其他窗口已修改本地资料。请导出当前备份，再重新加载；本窗口不会覆盖其他窗口。');
		return { revision: expectedRevision + 1 };
	}
	check() { return { result: this.database.prepare('PRAGMA quick_check').get().quick_check }; }
	close() { this.database.close(); }
}
module.exports = { VaultDatabase };
