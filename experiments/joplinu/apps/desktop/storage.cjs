const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_UPDATE = 8 * 1024 * 1024;
let database;

function openDatabase() {
	if (database) return database;
	const db = new DatabaseSync(join(app.getPath('userData'), 'notes.sqlite'), { timeout: 5000 });
	try {
		db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
		db.exec('CREATE TABLE IF NOT EXISTS note_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, data BLOB NOT NULL, checksum TEXT NOT NULL); CREATE INDEX IF NOT EXISTS note_updates_by_note ON note_updates(note_id, seq);');
		database = db;
		return db;
	} catch (error) { db.close(); throw error; }
}
function checkId(id) {
	if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid document identifier');
}
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
function read(noteId) {
	checkId(noteId);
	const result = [];
	for (const row of openDatabase().prepare('SELECT data, checksum FROM note_updates WHERE note_id = ? ORDER BY seq').all(noteId)) {
		if (digest(row.data) !== row.checksum) throw new Error('Local update checksum mismatch; refusing recovery.');
		result.push(row.data.toString('base64'));
	}
	return { updates: result };
}
function append(noteId, encoded) {
	checkId(noteId);
	if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_UPDATE / 3) * 4 + 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new Error('Invalid update payload');
	}
	const data = Buffer.from(encoded, 'base64');
	if (!data.length || data.length > MAX_UPDATE) throw new Error('Invalid update size');
	const db = openDatabase();
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('INSERT INTO note_updates(note_id, data, checksum) VALUES(?, ?, ?)').run(noteId, data, digest(data));
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
function closeDatabase() { database?.close(); database = undefined; }
module.exports = { read, append, closeDatabase, checkId };
