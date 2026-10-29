const { DatabaseSync } = require('node:sqlite');

const MAX_BYTES = 40 * 1024 * 1024;
const NOTE_ID = /^[a-zA-Z0-9-]{1,100}$/;
const { createHash } = require('node:crypto');
class VaultDatabase {
	constructor(filename) {
		this.database = new DatabaseSync(filename);
		try { this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT); INSERT OR IGNORE INTO vault VALUES (1, 0, NULL); CREATE TABLE IF NOT EXISTS note_updates (note_id TEXT NOT NULL, revision INTEGER NOT NULL, data BLOB NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(note_id, revision));'); }
		catch (error) { this.database.close(); throw error; }
	}
	read() {
		this.database.exec('BEGIN');
		try {
		const record = this.database.prepare('SELECT revision, payload FROM vault WHERE id=1').get();
		const noteUpdates = Object.create(null);
		for (const row of this.database.prepare('SELECT note_id, data, checksum FROM note_updates ORDER BY note_id, revision').all()) {
			if (!NOTE_ID.test(row.note_id) || createHash('sha256').update(row.data).digest('hex') !== row.checksum) {
				throw new Error('Corrupted Yjs journal; refusing to load');
			}
			(noteUpdates[row.note_id] ??= []).push(Buffer.from(row.data).toString('base64'));
		}
		this.database.exec('COMMIT');
		return { ...record, noteUpdates };
		} catch (error) { this.database.exec('ROLLBACK'); throw error; }
	}
	write({ expectedRevision, payload, journal = { updates: {}, replace: [], remove: [] } }) {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Invalid local save request');
		const parsed = JSON.parse(payload);
		if (parsed.schema !== 1 || !Array.isArray(parsed.notes) || !Array.isArray(parsed.folders)) throw new Error('Invalid vault format');
		if (!journal || !journal.updates || !Array.isArray(journal.replace) || !Array.isArray(journal.remove)) throw new Error('Invalid Yjs journal');
		const replacements = new Set(journal.replace);
		const removals = new Set(journal.remove);
		if (Object.keys(journal.updates).length > 10000 || replacements.size > 10000 || removals.size > 10000) throw new Error('Yjs journal too large');
		const values = [];
		for (const [id, encoded] of Object.entries(journal.updates)) {
			if (!NOTE_ID.test(id) || removals.has(id) || typeof encoded !== 'string' ||
				!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid Yjs update');
			const data = Buffer.from(encoded, 'base64');
			if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('Invalid Yjs update size');
			values.push([id, data, createHash('sha256').update(data).digest('hex')]);
		}
		for (const id of [...replacements, ...removals]) if (!NOTE_ID.test(id)) throw new Error('Invalid journal ID');
		for (const id of replacements) if (!Object.hasOwn(journal.updates, id)) throw new Error('Missing compacted state');
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const result = this.database.prepare('UPDATE vault SET revision=revision+1, payload=? WHERE id=1 AND revision=?').run(payload, expectedRevision);
			if (result.changes !== 1) throw new Error('其他窗口已修改本地资料。请导出当前备份，再重新加载；本窗口不会覆盖其他窗口。');
			const remove = this.database.prepare('DELETE FROM note_updates WHERE note_id=?');
			for (const id of new Set([...replacements, ...removals])) remove.run(id);
			const insert = this.database.prepare('INSERT INTO note_updates(note_id, revision, data, checksum) VALUES(?,?,?,?)');
			for (const [id, data, checksum] of values) insert.run(id, expectedRevision + 1, data, checksum);
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
		return { revision: expectedRevision + 1 };
	}

	check() { return { result: this.database.prepare('PRAGMA quick_check').get().quick_check }; }
	close() { this.database.close(); }
}
module.exports = { VaultDatabase };
