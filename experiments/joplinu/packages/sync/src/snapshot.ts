import { toBase64, sha256 } from '../../core/src/bytes';
import { encryptSyncObject, decryptSyncObject } from '../../crypto/src/sync';
import { listAll } from '../../storage/src/diagnostics';
import type { ObjectStorageProvider } from '../../storage/src/index';
import { rootPath, isSyncTarget, type SyncState, type SyncUpdate, type QueuedObject } from './replica';

const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = /^[a-f0-9]{64}$/;
interface Index { format: 'JoplinU snapshot'; version: 1; createdAt: number; pieces: { path: string; hash: string }[]; covered: Record<string, string> }
export function decodeUpdate(bytes: Uint8Array): SyncUpdate {
	const packet = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
	if (packet.format !== 'JoplinU update' || packet.version !== 1 || typeof packet.target !== 'string' || !isSyncTarget(packet.target) || typeof packet.update !== 'string' || packet.update.length > 64 * 1024 * 1024) throw new Error('解密后的更新格式无效');
	return { target: packet.target, update: packet.update };
}
export async function writeSnapshot(
	key: CryptoKey, state: SyncState, capture: { meta: string; notes: { id: string; state: string }[] },
	enqueue: (object: QueuedObject) => Promise<void>,
) {
	const prefix = `${rootPath(state)}snapshots/${crypto.randomUUID()}/`;
	const index: Index = { format: 'JoplinU snapshot', version: 1, createdAt: Date.now(), pieces: [], covered: { ...state.known } };
	const entries = [{ target: 'meta', update: capture.meta }, ...capture.notes.map(note => ({ target: `note:${note.id}`, update: note.state }))];
	const put = async (path: string, value: unknown) => { const bytes = await encryptSyncObject(key, path, encoder.encode(JSON.stringify(value))); const hash = await sha256(bytes); await enqueue({ path, hash, ciphertext: toBase64(bytes) }); return hash; };
	for (const entry of entries) { const path = prefix + crypto.randomUUID() + '.bin'; const hash = await put(path, { format: 'JoplinU update', version: 1, ...entry }); index.pieces.push({ path, hash }); }
	// The index is the commit marker. A crash before it leaves harmless orphan
	// pieces; it never makes a partial snapshot visible or permits log deletion.
	await put(prefix + 'index.bin', index);
}
export async function readSnapshot(
	provider: ObjectStorageProvider, key: CryptoKey, state: SyncState, listed: Set<string>,
	accept: (update: SyncUpdate) => void,
): Promise<Record<string, string>> {
	const prefix = rootPath(state) + 'snapshots/'; const candidates: { path: string; value: Index }[] = [];
	for await (const object of listAll(provider, prefix)) {
		if (!object.key.endsWith('/index.bin')) continue;
		if (candidates.length >= 1000 || object.size > 49 * 1024 * 1024) throw new Error('远端快照索引超过安全限制');
		const value = JSON.parse(decoder.decode(await decryptSyncObject(key, object.key, await provider.getObject(object.key)))) as Index;
		const group = object.key.slice(0, -'index.bin'.length);
		if (!new RegExp(`^${prefix}[a-z0-9-]{36}/$`).test(group) || value.format !== 'JoplinU snapshot' || value.version !== 1 || !Number.isFinite(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.pieces) || !value.pieces.length || value.pieces.length > 10001 || !value.covered || typeof value.covered !== 'object') throw new Error('恢复快照索引格式无效');
		const names = new Set<string>();
		for (const piece of value.pieces) { if (!piece || typeof piece.path !== 'string' || !piece.path.startsWith(group) || !new RegExp(`^${group}[a-z0-9-]{36}\\.bin$`).test(piece.path) || names.has(piece.path) || !digest.test(piece.hash)) throw new Error('恢复快照分片索引无效'); names.add(piece.path); }
		for (const [path, hash] of Object.entries(value.covered)) if (!listed.has(path) || typeof hash !== 'string' || !digest.test(hash) || (state.known[path] && state.known[path] !== hash)) throw new Error('快照引用的历史缺失或与本机检查点不符');
		candidates.push({ path: object.key, value });
	}
	const selected = candidates.sort((a, b) => b.value.createdAt - a.value.createdAt || a.path.localeCompare(b.path))[0];
	if (!selected) return Object.create(null) as Record<string, string>;
	const targets = new Set<string>();
	for (const piece of selected.value.pieces) {
		const bytes = await provider.getObject(piece.path); if (await sha256(bytes) !== piece.hash) throw new Error('恢复快照分片摘要不符，已停止恢复');
		const update = decodeUpdate(await decryptSyncObject(key, piece.path, bytes));
		if (targets.has(update.target)) throw new Error('恢复快照包含重复文档'); targets.add(update.target); accept(update);
	}
	if (!targets.has('meta')) throw new Error('恢复快照缺少资料库元数据');
	return selected.value.covered;
}
