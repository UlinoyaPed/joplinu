import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3CompatibleProvider } from '../../packages/storage-s3/src/index';
import { listAll, probeStorage } from '../../packages/storage/src/diagnostics';
import type { StorageCredentials } from '../../packages/storage/src/index';
import { RealS3Server } from './server';
import { FaultProxy } from './fault-proxy';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryController } from '../../packages/library/src/controller';
import { SyncEngine, recoveryCode } from '../../packages/sync/src/engine';
import { createNote } from '../../packages/library/src/model';
import type { StoredVault, JournalWrite, VaultStorage } from '../../packages/database/src/index';

describe('real SeaweedFS S3 API with AWS SDK v3', () => {
	const server = new RealS3Server();
	const instances: S3CompatibleProvider[] = [];
	const prefix = `integration/${crypto.randomUUID()}`;
	const provider = (extra: Partial<ConstructorParameters<typeof S3CompatibleProvider>[0]> = {}, readonly = false) => {
		const result = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, pageSize: 2, allowInsecureLocalhost: true, retryDelayMs: 5, timeoutMs: 5000, ...extra }, readonly ? server.readerCredentials : server.credentials); instances.push(result); return result;
	};
	beforeAll(async () => { try { await server.start(); } catch (error) { await server.close(); throw error; } }, 90000);
	afterAll(async () => { for (const instance of instances) instance.close(); await server.close(); });

	it('uploads/downloads binary and empty objects with UTF-8 keys and real metadata', async () => {
		const storage = provider(); const bytes = new Uint8Array([0, 255, 128, 13, 10, 0]);
		await storage.putObject('updates/中文 &?.bin', bytes); expect(await storage.getObject('updates/中文 &?.bin')).toEqual(bytes);
		expect(await storage.headObject('updates/中文 &?.bin')).toMatchObject({ key: 'updates/中文 &?.bin', size: bytes.length });
		await storage.putObject('updates/empty.bin', new Uint8Array()); expect(await storage.getObject('updates/empty.bin')).toEqual(new Uint8Array());
	});
	it('walks all list pages without escaping the configured namespace', async () => {
		const storage = provider();
		await server.admin.send(new PutObjectCommand({ Bucket: server.bucket, Key: 'outside/preserved.bin', Body: 'outside' }));
		for (let i = 0; i < 7; i++) await storage.putObject(`pages/${i}.bin`, new Uint8Array([i]));
		const first = await storage.listObjects('pages/'); expect(first.objects).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
		const objects = []; for await (const object of listAll(storage, 'pages/')) objects.push(object);
		expect(objects.map(object => object.key).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `pages/${i}.bin`));
		await expect(storage.deleteObject('../outside/preserved.bin')).rejects.toMatchObject({ kind: 'invalid-request' });
		const untouched = await server.admin.send(new GetObjectCommand({ Bucket: server.bucket, Key: 'outside/preserved.bin' })); expect(await untouched.Body!.transformToString()).toBe('outside');
	});
	it('distinguishes missing objects from denied writes, and deletion is idempotent', async () => {
		const storage = provider(); expect(await storage.headObject('missing.bin')).toBeNull(); await expect(storage.getObject('missing.bin')).rejects.toMatchObject({ kind: 'not-found', retryable: false });
		await storage.deleteObject('missing.bin'); await storage.putObject('delete.bin', new Uint8Array([1])); await storage.deleteObject('delete.bin'); expect(await storage.headObject('delete.bin')).toBeNull();
		const reader = provider({}, true); await expect(reader.putObject('denied.bin', new Uint8Array([1]))).rejects.toMatchObject({ kind: 'permission', retryable: false });
	});
	it('rejects a real SigV4 request signed with the wrong secret', async () => {
		const invalid = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, allowInsecureLocalhost: true }, { accessKeyId: server.credentials.accessKeyId, secretAccessKey: crypto.randomUUID() }); instances.push(invalid);
		await expect(invalid.getObject('updates/empty.bin')).rejects.toMatchObject({ kind: 'authentication', retryable: false });
	});
	it('refreshes a dynamic credential source after its secret changes', async () => {
		let current: StorageCredentials = { ...server.credentials, secretAccessKey: crypto.randomUUID() };
		const changing = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, allowInsecureLocalhost: true }, async () => current); instances.push(changing);
		await expect(changing.getObject('updates/empty.bin')).rejects.toMatchObject({ kind: 'authentication' });
		current = { ...server.credentials }; expect(await changing.getObject('updates/empty.bin')).toEqual(new Uint8Array());
	});
	it('retries a committed upload whose response was lost using the original byte snapshot', async () => {
		const proxy = new FaultProxy(server.endpoint); await proxy.start();
		try {
			const storage = provider({ endpoint: proxy.endpoint }); const original = new Uint8Array([1, 2, 3, 4]); proxy.fault = 'lost-put-response';
			const upload = storage.putObject('retry/committed.bin', original); original.fill(99); await upload;
			expect(proxy.committedBeforeDisconnect).toBe(1); expect(proxy.puts).toBe(2); expect(await storage.getObject('retry/committed.bin')).toEqual(new Uint8Array([1, 2, 3, 4]));
		} finally { await proxy.close(); }
	});
	it('recovers from timeout and server throttling without infinite retries', async () => {
		const proxy = new FaultProxy(server.endpoint); await proxy.start();
		try {
			const storage = provider({ endpoint: proxy.endpoint, timeoutMs: 500 }); proxy.fault = 'throttle-put'; await storage.putObject('retry/throttle.bin', new Uint8Array([8])); expect(proxy.puts).toBe(2);
			proxy.fault = 'timeout-get'; expect(await storage.getObject('retry/throttle.bin')).toEqual(new Uint8Array([8])); expect(proxy.gets).toBe(2);
		} finally { await proxy.close(); }
	});
	it('honors cancellation and download limits, and cleans only its connection-test objects', async () => {
		const storage = provider({ maxObjectBytes: 2 }); await expect(storage.getObject('retry/committed.bin')).rejects.toMatchObject({ kind: 'limit-exceeded', retryable: false });
		const controller = new AbortController(); controller.abort(); await expect(storage.listObjects('', undefined, { signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
		const probe = await probeStorage(provider()); expect(probe.ok).toBe(true); expect(probe.cleanup).toBe('ok'); expect(probe.leftoverKeys).toEqual([]);
		const leftovers = []; for await (const object of listAll(provider(), '__joplinu_connection_test/')) leftovers.push(object); expect(leftovers).toEqual([]);
		expect(await provider().getObject('retry/committed.bin')).toEqual(new Uint8Array([1, 2, 3, 4]));
	});
	it('preserves acknowledged objects after the actual service restarts', async () => {
		const storage = provider(); await storage.putObject('recovery/persistent.bin', new Uint8Array([7, 8, 9])); await server.restart(); expect(await storage.getObject('recovery/persistent.bin')).toEqual(new Uint8Array([7, 8, 9]));
	}, 90000);
	it('merges offline encrypted replicas with durable SQLite retry, new-device recovery and tamper rejection', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'joplinu-sync-'));
		type Database = { read(): StoredVault; write(input: { expectedRevision: number; payload: string; journal?: JournalWrite }): { revision: number }; close(): void };
		const { VaultDatabase } = createRequire(import.meta.url)('../../apps/desktop/database.cjs') as { VaultDatabase: new (path: string) => Database };
		const devices: { controller: LibraryController; database: Database; engine: SyncEngine }[] = [];
		const device = async (name: string, source = '') => {
			const database = new VaultDatabase(join(directory, name + '.sqlite'));
			const storage: VaultStorage = { kind: 'SQLite', read: async () => database.read(), write: async (expectedRevision, payload, journal) => database.write({ expectedRevision, payload, ...(journal ? { journal } : {}) }).revision, check: async () => 'ok' };
			const controller = new LibraryController(storage); await controller.open(source);
			const entry = { controller, database, engine: new SyncEngine(controller) }; devices.push(entry); return entry;
		};
		const storage = provider({ prefix: `sync/${crypto.randomUUID()}` });
		const password = 'integration-only-' + crypto.randomUUID(); const marker = '私密正文-SENTINEL-' + crypto.randomUUID();
		try {
			const a = await device('a', marker); await a.engine.create(password); await a.engine.sync(storage);
			const noteId = a.controller.vault.notes[0]!.id;
			const b = await device('b'); b.controller.change({ ...b.controller.vault, notes: [], folders: [] }); await b.controller.requireDurable();
			await b.engine.join(storage, recoveryCode(a.controller.syncState!.manifest), password); await b.engine.sync(storage);
			expect(b.controller.document(noteId).source).toBe(marker);
			a.controller.document(noteId).edit([{ from: 2, to: 2, insert: '甲' }]); b.controller.document(noteId).edit([{ from: 2, to: 2, insert: '乙' }]);
			a.controller.updateNote(noteId, { title: '离线改名' }); b.controller.updateNote(noteId, { pinned: true, tags: ['离线标签'] });
			await a.engine.sync(storage); await b.engine.sync(storage); await a.engine.sync(storage);
			const merged = a.controller.document(noteId).source; expect(merged).toContain('甲'); expect(merged).toContain('乙'); expect(b.controller.document(noteId).source).toBe(merged);
			expect(a.controller.vault.notes[0]).toMatchObject({ title: '离线改名', pinned: true, tags: ['离线标签'] });
			for await (const object of listAll(storage, `vaults/${a.controller.syncState!.manifest.vault}/updates/`)) expect(Buffer.from(await storage.getObject(object.key)).includes(Buffer.from(marker))).toBe(false);
			// The real server commits the update; the simulated lost acknowledgement
			// reaches the engine after the durable ciphertext queue has been written.
			const put = storage.putObject.bind(storage); let lose = true;
			storage.putObject = async (key, data, options) => { await put(key, data, options); if (lose && key.includes('/updates/')) { lose = false; throw new Error('lost acknowledgement'); } };
			a.controller.document(noteId).edit([{ from: merged.length, to: merged.length, insert: '恢复队列' }]);
			await expect(a.engine.sync(storage)).rejects.toThrow('lost acknowledgement'); expect(a.controller.syncState!.outbox.length).toBeGreaterThan(0);
			const queued = a.controller.syncState!.outbox[0]!.path;
			a.controller.dispose(); a.database.close(); devices.splice(devices.indexOf(a), 1);
			storage.putObject = put;
			const reopened = await device('a'); await expect(reopened.engine.unlock('wrong-password-value')).rejects.toThrow(); await reopened.engine.unlock(password); await reopened.engine.sync(storage);
			expect(reopened.controller.syncState!.outbox).toHaveLength(0); expect(reopened.controller.syncState!.known[queued]).toBeTruthy();
			await reopened.engine.snapshot(storage);
			const historical = new Set(Object.keys(reopened.controller.syncState!.known));
			const snapshots = []; for await (const object of listAll(storage, `vaults/${reopened.controller.syncState!.manifest.vault}/snapshots/`)) snapshots.push(object.key);
			const piece = snapshots.find(path => !path.endsWith('/index.bin'))!; expect(piece).toBeTruthy();
			const snapshotBytes = await storage.getObject(piece); const badPiece = snapshotBytes.slice(); badPiece[badPiece.length - 1] = badPiece[badPiece.length - 1]! ^ 1; await storage.putObject(piece, badPiece);
			const fresh = await device('fresh'); fresh.controller.change({ ...fresh.controller.vault, notes: [], folders: [] });
			await fresh.engine.join(storage, recoveryCode(reopened.controller.syncState!.manifest), password);
			await expect(fresh.engine.sync(storage)).rejects.toThrow(/快照|认证/); expect(fresh.controller.vault.notes).toHaveLength(0);
			await storage.putObject(piece, snapshotBytes);
			const get = storage.getObject.bind(storage); let historicalReads = 0;
			storage.getObject = async (key, options) => { if (historical.has(key)) historicalReads++; return get(key, options); };
			await fresh.engine.sync(storage); expect(historicalReads).toBe(0); storage.getObject = get;
			expect(fresh.controller.document(noteId).source).toBe(merged + '恢复队列');
			// Permanent deletion versus an offline pure deletion must retain the edit,
			// including on a device bootstrapped from a snapshot without that old body.
			const conflict = createNote('删除后的离线修改', null, '保留正文');
			reopened.controller.change({ ...reopened.controller.vault, notes: [...reopened.controller.vault.notes, conflict] }); await reopened.engine.sync(storage); await b.engine.sync(storage);
			b.controller.change({ ...b.controller.vault, preferences: { ...b.controller.vault.preferences, history: false } });
			b.controller.document(conflict.id).edit([{ from: 0, to: 1, insert: '' }]);
			reopened.controller.trashNotes([conflict.id], true); reopened.controller.change({ ...reopened.controller.vault, notes: reopened.controller.vault.notes.filter(note => note.id !== conflict.id) });
			await reopened.engine.snapshot(storage); await b.engine.sync(storage);
			expect(b.controller.document(conflict.id).source).toBe('留正文'); expect(b.controller.vault.notes.find(note => note.id === conflict.id)!.deletedAt).not.toBeNull();
			const recovery = await device('late-recovery'); recovery.controller.change({ ...recovery.controller.vault, notes: [], folders: [] });
			await recovery.engine.join(storage, recoveryCode(reopened.controller.syncState!.manifest), password); await recovery.engine.sync(storage);
			expect(recovery.controller.document(conflict.id).source).toBe('留正文'); expect(recovery.controller.syncRecoveryNote).toContain('回收站');
			recovery.controller.change({ ...recovery.controller.vault, notes: recovery.controller.vault.notes.filter(note => note.id !== conflict.id) }); await recovery.engine.sync(storage);
			expect(recovery.controller.vault.notes.some(note => note.id === conflict.id)).toBe(false);
			const original = await storage.getObject(queued); const corrupt = original.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; await storage.putObject(queued, corrupt);
			await expect(fresh.engine.sync(storage, true)).rejects.toThrow(/变化|认证/); expect(fresh.controller.document(noteId).source).toBe(merged + '恢复队列');
			await storage.putObject(queued, original); await storage.deleteObject(queued); await expect(fresh.engine.sync(storage)).rejects.toThrow(/缺失/);
		} finally { for (const device of devices) { device.controller.dispose(); device.database.close(); } await rm(directory, { recursive: true, force: true }); }
	}, 90000);
});
