import * as Y from 'yjs';
import { fromBase64, toBase64, sha256 } from '../../core/src/bytes';
import { createSyncKey, unlockSyncKey, encryptSyncObject, decryptSyncObject, validateManifest, matchesSyncManifest, type SyncKeyManifest } from '../../crypto/src/sync';
import type { LibraryController } from '../../library/src/controller';
import type { ObjectStorageProvider } from '../../storage/src/index';
import { manifestPath, rootPath, MissingSyncDependencies, LocalEditingInProgress, type SyncUpdate, type QueuedObject } from './replica';
import { decodeUpdate, writeSnapshot, readSnapshot } from './snapshot';
import { migrateRepository } from './migrate';
import { rekeyRepository } from './rekey';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function recoveryCode(manifest: SyncKeyManifest) { return `${manifest.vault}.${manifest.key}`; }
export type SyncStatus = 'locked' | 'ready' | 'syncing' | 'waiting' | 'error' | 'synced';

/** Foreground document merge engine. Providers see authenticated encrypted immutable objects only. */
export class SyncEngine {
	private key: CryptoKey | undefined;
	private running = false;
	private queuedVersion = -1;
	private stateCache = new Map<string, { state: string; hash: string }>();
	status: SyncStatus = 'locked';
	error = '';
	progress = '';
	pendingRemoteCount = 0;
	private version = 0;
	private listeners = new Set<() => void>();
	constructor(readonly controller: LibraryController) {}
	getSnapshot = () => this.version;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private emit() { this.version++; for (const listener of this.listeners) listener(); }
	get unlocked() { return this.key !== undefined; }
	get busy() { return this.running; }
	get hasPendingLocal() { return this.key !== undefined && this.controller.contentVersion !== this.queuedVersion; }
	private async exclusive<T>(action: () => Promise<T>): Promise<T> {
		if (this.running) throw new Error('同步操作正在进行');
		this.running = true; this.error = ''; this.emit();
		try { return await action(); }
		catch (error) { this.status = error instanceof LocalEditingInProgress ? 'waiting' : 'error'; this.error = error instanceof Error ? error.message : '同步失败'; throw error; }
		finally { this.running = false; this.progress = ''; this.emit(); }
	}
	async create(password: string) {
		await this.exclusive(async () => { const next = await createSyncKey(password); await this.controller.enableSync(next.manifest); this.key = next.key; this.status = 'ready'; });
	}
	async join(provider: ObjectStorageProvider, code: string, password: string) {
		await this.exclusive(async () => {
			if (!new RegExp(`^${uuid}\\.${uuid}$`).test(code)) throw new Error('请完整填写同步库恢复码');
			const [vault, key] = code.split('.') as [string, string];
			const bytes = await provider.getObject(`vaults/${vault}/keys/${key}.json`);
			if (bytes.length > 4096) throw new Error('远端密钥文件过大');
			const manifest = validateManifest(JSON.parse(decoder.decode(bytes)));
			if (manifest.vault !== vault || manifest.key !== key) throw new Error('密钥文件与恢复码不符');
			const unlocked = await unlockSyncKey(manifest, password);
			await this.controller.enableSync(manifest); this.key = unlocked; this.status = 'ready';
		});
	}
	async unlock(password: string) {
		await this.exclusive(async () => { if (!this.controller.syncState) throw new Error('尚未连接同步库'); this.key = await unlockSyncKey(this.controller.syncState.manifest, password); this.status = 'ready'; });
	}
	lock() { if (this.running) throw new Error('同步期间暂不能锁定'); this.key = undefined; this.status = 'locked'; this.error = ''; this.emit(); }
	private async ensureManifest(provider: ObjectStorageProvider) {
		const manifest = this.controller.syncState!.manifest; const path = manifestPath(manifest);
		const content = encoder.encode(JSON.stringify(manifest));
		if (await provider.headObject(path) === null) await provider.putObject(path, content);
		const remote = await provider.getObject(path);
		if (!matchesSyncManifest(remote, manifest)) throw new Error('远端密钥元数据与本机不一致，已停止同步');
	}
	private async listed(provider: ObjectStorageProvider) {
		const prefix = rootPath(this.controller.syncState!) + 'updates/';
		const keys = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
		do {
			const page = await provider.listObjects(prefix, cursor);
			for (const object of page.objects) {
				if (!object.key.startsWith(prefix) || !new RegExp(`^${prefix}${uuid}/${uuid}\\.bin$`).test(object.key) || object.size < 29 || object.size > 49 * 1024 * 1024) throw new Error('远端同步对象格式或大小无效');
				keys.add(object.key); if (keys.size > 100000) throw new Error('同步日志超过当前 100000 对象限制，请保留备份并联系维护者');
			}
			cursor = page.nextCursor;
			if (cursor) { if (cursors.has(cursor)) throw new Error('云存储返回了重复分页游标'); cursors.add(cursor); }
		} while (cursor);
		return keys;
	}
	private async download(provider: ObjectStorageProvider, verifyAll: boolean) {
		const state = this.controller.syncState!;
		const listed = await this.listed(provider);
		if (Object.keys(state.known).some(path => !listed.has(path))) throw new Error('远端历史对象缺失或列表尚未完整可见；已暂停同步，请重试或从独立备份恢复');
		const documents = new Map<string, Y.Doc>(); const sizes = new Map<string, number>();
		const known: Record<string, string> = Object.create(null); let count = 0; let total = 0;
		const accept = (update: SyncUpdate) => {
			let document = documents.get(update.target); if (!document) documents.set(update.target, document = new Y.Doc());
			Y.applyUpdate(document, fromBase64(update.update));
			const size = Y.encodeStateAsUpdate(document).length; total += size - (sizes.get(update.target) ?? 0); sizes.set(update.target, size);
			if (total > 96 * 1024 * 1024) throw new Error('本轮合并状态超过 96 MiB 安全内存限制，请保留独立备份');
		};
		try {
			if (Object.keys(state.known).length === 0) Object.assign(known, await readSnapshot(provider, this.key!, state, listed, accept));
			for (const path of [...listed].sort()) {
			if ((state.known[path] || known[path]) && !verifyAll) continue;
			this.progress = `验证与下载更新 ${++count}`; this.emit();
			const bytes = await provider.getObject(path); const hash = await sha256(bytes);
			const expected = state.known[path] ?? known[path];
			if (expected && expected !== hash) throw new Error('远端已处理对象发生变化，可能损坏或被回滚；已停止同步');
			const plaintext = await decryptSyncObject(this.key!, path, bytes);
			const packet = decodeUpdate(plaintext);
			if (!expected) accept(packet);
			known[path] = hash;
			}
			const apply = () => this.controller.applySyncUpdates([...documents].map(([target, document]) => ({ target, update: toBase64(Y.encodeStateAsUpdate(document)) })), known);
			if (documents.size) this.pendingRemoteCount = Object.keys(known).filter(path => !state.known[path]).length;
			if (documents.size) try { await apply(); this.pendingRemoteCount = 0; } catch (error) {
				if (!(error instanceof MissingSyncDependencies)) throw error;
				// A long-offline device can edit a note removed before a snapshot.
				// Preserve all original logs and recover its missing body dependencies.
				this.progress = '正在补齐离线编辑依赖'; this.emit();
				for (const path of listed) {
					const bytes = await provider.getObject(path); const hash = await sha256(bytes); const expected = state.known[path] ?? known[path];
					if (expected && expected !== hash) throw new Error('恢复依赖时发现历史对象损坏');
					accept(decodeUpdate(await decryptSyncObject(this.key!, path, bytes))); known[path] = hash;
				}
				await apply();
				this.pendingRemoteCount = 0;
			}
		} finally { for (const document of documents.values()) document.destroy(); }
	}
	private async prepare(provider?: ObjectStorageProvider) {
		await this.controller.requireDurable();
		const version = this.controller.contentVersion;
		const state = this.controller.syncState!; const capture = this.controller.syncCapture();
		const entries = [{ id: 'meta', state: capture.meta }, ...capture.notes.map(note => ({ id: `note:${note.id}`, state: note.state }))];
		const present = new Set(entries.map(entry => entry.id)); for (const id of this.stateCache.keys()) if (!present.has(id)) this.stateCache.delete(id);
		for (const entry of entries) {
			const cached = this.stateCache.get(entry.id);
			if (cached?.state === entry.state && this.controller.syncState!.hashes[entry.id] === cached.hash) continue;
			const full = fromBase64(entry.state); const digest = await sha256(full); this.stateCache.set(entry.id, { state: entry.state, hash: digest });
			if (this.controller.syncState!.hashes[entry.id] === digest) continue;
			const document = new Y.Doc();
			try {
				Y.applyUpdate(document, full);
				const current = this.controller.syncState!;
				const before = current.vectors[entry.id] ? fromBase64(current.vectors[entry.id]!) : undefined;
				const delta = Y.encodeStateAsUpdate(document, before);
				// A deletion set can be repeated by Yjs; byte-identical state vectors
				// alone cannot prove there are no new deletes. Track full-state hashes too.
				const path = `${rootPath(state)}updates/${state.device}/${crypto.randomUUID()}.bin`;
				const bytes = await encryptSyncObject(this.key!, path, encoder.encode(JSON.stringify({ format: 'JoplinU update', version: 1, target: entry.id, update: toBase64(delta) })));
				const queued: QueuedObject = { path, ciphertext: toBase64(bytes), hash: await sha256(bytes) };
				await this.controller.saveSyncState({ ...this.controller.syncState!, vectors: { ...this.controller.syncState!.vectors, [entry.id]: toBase64(Y.encodeStateVector(document)) }, hashes: { ...this.controller.syncState!.hashes, [entry.id]: digest }, outbox: [...this.controller.syncState!.outbox, queued] });
				if (provider) await this.upload(provider);
			} finally { document.destroy(); }
		}
		this.queuedVersion = version;
	}
	async queueLocal() {
		await this.exclusive(async () => { if (!this.key || !this.controller.syncState) throw new Error('请先解锁同步密钥'); await this.prepare(); this.status = 'ready'; });
	}
	private async upload(provider: ObjectStorageProvider) {
		while (this.controller.syncState!.outbox.length) {
			const state = this.controller.syncState!; const item = state.outbox[0]!;
			this.progress = `上传加密更新，队列剩余 ${state.outbox.length}`; this.emit();
			const bytes = fromBase64(item.ciphertext); if (await sha256(bytes) !== item.hash) throw new Error('本地上传队列校验失败，保留原始数据');
			if (await provider.headObject(item.path) === null) await provider.putObject(item.path, bytes);
			if (await sha256(await provider.getObject(item.path)) !== item.hash) throw new Error('上传对象校验失败，队列未确认');
			await this.controller.saveSyncState({ ...this.controller.syncState!, outbox: this.controller.syncState!.outbox.filter(q => q.path !== item.path), known: { ...this.controller.syncState!.known, ...(item.path.startsWith(rootPath(state) + 'updates/') ? { [item.path]: item.hash } : {}) } });
		}
	}
	async sync(provider: ObjectStorageProvider, verifyAll = false) {
		await this.exclusive(async () => {
			if (!this.key || !this.controller.syncState) throw new Error('请先输入同步密码解锁');
			this.status = 'syncing'; this.emit();
			await this.controller.requireDurable(); await this.ensureManifest(provider);
			await this.download(provider, verifyAll); await this.upload(provider); await this.prepare(provider);
			await this.download(provider, false);
			await this.controller.saveSyncState({ ...this.controller.syncState!, lastSync: Date.now() });
			this.status = 'synced';
		});
	}
	async snapshot(provider: ObjectStorageProvider) {
		await this.exclusive(async () => {
			if (!this.key || !this.controller.syncState) throw new Error('请先输入同步密码解锁');
			this.status = 'syncing'; this.emit();
			await this.controller.requireDurable(); await this.ensureManifest(provider);
			await this.download(provider, false); await this.upload(provider); await this.prepare(provider);
			await this.controller.requireDurable(); const capture = this.controller.syncCapture();
			this.progress = '正在创建加密恢复快照'; this.emit();
			await writeSnapshot(this.key, this.controller.syncState!, capture, async object => {
				await this.controller.saveSyncState({ ...this.controller.syncState!, outbox: [...this.controller.syncState!.outbox, object] });
				await this.upload(provider);
			});
			this.status = 'ready';
		});
	}
	async migrate(source: ObjectStorageProvider, target: ObjectStorageProvider, afterVerified?: () => Promise<void>): Promise<number> {
		return this.exclusive(async () => {
			if (!this.key || !this.controller.syncState) throw new Error('请先输入同步密码解锁');
			this.status = 'syncing'; this.emit();
			await this.controller.requireDurable(); await this.ensureManifest(source);
			await this.download(source, false); await this.upload(source); await this.prepare(source);
			const count = await migrateRepository(source, target, this.key, this.controller.syncState!, objects => { this.progress = `已复制并验证 ${objects} 个加密对象`; this.emit(); });
			await afterVerified?.(); this.status = 'ready'; return count;
		});
	}
	async changeKey(provider: ObjectStorageProvider, password: string) {
		return this.exclusive(async () => { const next = await createSyncKey(password); await this.adoptKey(provider, next.manifest, next.key); });
	}
	async joinChangedKey(provider: ObjectStorageProvider, code: string, password: string) {
		return this.exclusive(async () => {
			if (!new RegExp(`^${uuid}\\.${uuid}$`).test(code)) throw new Error('请完整填写新同步库恢复码');
			const [vault, keyId] = code.split('.') as [string, string]; const bytes = await provider.getObject(`vaults/${vault}/keys/${keyId}.json`);
			if (bytes.length > 4096) throw new Error('新密钥文件过大');
			const manifest = validateManifest(JSON.parse(decoder.decode(bytes)));
			if (manifest.vault !== vault || manifest.key !== keyId) throw new Error('新恢复码与密钥不符');
			await this.adoptKey(provider, manifest, await unlockSyncKey(manifest, password));
		});
	}
	private async adoptKey(provider: ObjectStorageProvider, manifest: SyncKeyManifest, nextKey: CryptoKey) {
		if (!this.key || !this.controller.syncState) throw new Error('请先解锁当前同步库，保留离线编辑和历史');
		if (manifest.vault === this.controller.syncState.manifest.vault) throw new Error('当前已连接到此同步库');
		this.status = 'syncing'; this.emit();
		await this.controller.requireDurable(); await this.ensureManifest(provider);
		await this.download(provider, false); await this.upload(provider); await this.prepare(provider);
		const previous = this.controller.syncState!;
		const copied = await rekeyRepository(provider, this.key, nextKey, previous, manifest, count => { this.progress = `已使用新密钥验证 ${count} 个历史对象`; this.emit(); });
		const known: Record<string, string> = Object.create(null);
		for (const path of Object.keys(previous.known)) { const entry = copied.get(path); if (!entry) throw new Error('已确认历史未完整重加密，未切换'); known[entry.path] = entry.hash; }
		// After a lost local commit acknowledgement, either identity remains
		// recoverable on disk. The in-memory key must always match its manifest.
		this.key = nextKey;
		await this.controller.saveSyncState({ ...this.controller.syncState!, manifest, device: crypto.randomUUID(), known, outbox: [], lastSync: null });
		await this.download(provider, false); await this.prepare(provider);
		await this.controller.saveSyncState({ ...this.controller.syncState!, lastSync: Date.now() });
		this.status = 'synced';
	}
}

const sessions = new WeakMap<LibraryController, SyncEngine>();
export function syncSession(controller: LibraryController): SyncEngine {
	let engine = sessions.get(controller); if (!engine) sessions.set(controller, engine = new SyncEngine(controller)); return engine;
}
