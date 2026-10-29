import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VaultDatabase } = require('../apps/desktop/database.cjs');
const payload = title => JSON.stringify({ schema: 1, notes: [{ title }], folders: [] });

test('SQLite persists acknowledged data across reopen and rejects stale writers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'joplinu-database-'));
	try {
		const path = join(directory, 'test.sqlite');
		let database = new VaultDatabase(path);
		assert.deepEqual({ revision: database.read().revision, payload: database.read().payload }, { revision: 0, payload: null });
		assert.equal(database.write({ expectedRevision: 0, payload: payload('中文 📝') }).revision, 1);
		database.close(); database = new VaultDatabase(path);
		assert.equal(database.read().payload, payload('中文 📝'));
		assert.throws(() => database.write({ expectedRevision: 0, payload: payload('stale') }), /其他窗口/);
		assert.throws(() => database.write({ expectedRevision: 1, payload: '{bad' }));
		assert.equal(database.read().payload, payload('中文 📝'));
		assert.equal(database.check().result, 'ok'); database.close();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQLite recovers an acknowledged write after SIGKILL without a clean close', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'joplinu-crash-'));
	try {
		const path = join(directory, 'test.sqlite');
		const modulePath = require.resolve('../apps/desktop/database.cjs');
		assert.throws(() => execFileSync(process.execPath, ['-e', "const {VaultDatabase}=require(process.argv[1]); const db=new VaultDatabase(process.argv[2]); db.write({expectedRevision:0,payload:process.argv[3]}); process.kill(process.pid,'SIGKILL');", modulePath, path, payload('已确认的编辑')], { stdio: 'pipe' }));
		const database = new VaultDatabase(path);
		assert.equal(database.read().payload, payload('已确认的编辑'));
		assert.equal(database.check().result, 'ok'); database.close();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQLite rejects oversized and malformed bridge requests without changing the row', () => {
	const database = new VaultDatabase(':memory:');
	try {
		for (const input of [{ expectedRevision: -1, payload: payload('x') }, { expectedRevision: 0, payload: '{}' }, { expectedRevision: 0, payload: 'a'.repeat(40 * 1024 * 1024 + 1) }]) assert.throws(() => database.write(input));
		assert.equal(database.read().revision, 0);
	} finally { database.close(); }
});


test('SQLite v2 replays per-note journal records and retains only the compacted baseline', () => {
	const database = new VaultDatabase(':memory:');
	const one = Buffer.from([1, 2, 3]).toString('base64');
	const two = Buffer.from([4, 5]).toString('base64');
	try {
		assert.equal(database.write({ expectedRevision: 0, payload: payload('first'), journal: { updates: { 'note-one': one }, replace: [], remove: [] } }).revision, 1);
		assert.equal(database.write({ expectedRevision: 1, payload: payload('second'), journal: { updates: { 'note-one': two }, replace: [], remove: [] } }).revision, 2);
		assert.deepEqual(database.read().noteUpdates['note-one'], [one, two]);
		assert.equal(database.write({ expectedRevision: 2, payload: payload('compact'), journal: { updates: { 'note-one': two }, replace: ['note-one'], remove: [] } }).revision, 3);
		assert.deepEqual(database.read().noteUpdates['note-one'], [two]);
		assert.throws(() => database.write({ expectedRevision: 2, payload: payload('conflict'), journal: { updates: { 'note-one': one }, replace: [], remove: [] } }));
		assert.deepEqual(database.read().noteUpdates['note-one'], [two]);
		database.write({ expectedRevision: 3, payload: payload('deleted'), journal: { updates: {}, replace: [], remove: ['note-one'] } });
		assert.equal(database.read().noteUpdates['note-one'], undefined);
	} finally { database.close(); }
});
