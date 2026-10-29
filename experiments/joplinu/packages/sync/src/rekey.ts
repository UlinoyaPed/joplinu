import { sha256 } from '../../core/src/bytes';
import { decryptSyncObject, encryptSyncObject, type SyncKeyManifest } from '../../crypto/src/sync';
import type { ObjectStorageProvider } from '../../storage/src/index';
import { listAll } from '../../storage/src/diagnostics';
import { rootPath, manifestPath, type SyncState } from './replica';
import { decodeUpdate } from './snapshot';

interface Copied { path: string; hash: string; originalHash: string }
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: true });
/** Re-encrypts all immutable history into a new key domain. Existing destination
 * objects must decrypt to exactly the same payload; different content is retained
 * and rejected. Old repositories remain intact for offline-device recovery. */
export async function rekeyRepository(
	provider: ObjectStorageProvider, oldKey: CryptoKey, newKey: CryptoKey,
	state: SyncState, manifest: SyncKeyManifest, progress: (objects: number) => void,
): Promise<Map<string, Copied>> {
	const root = rootPath(state); const destination = `vaults/${manifest.vault}/`; const copied = new Map<string, Copied>();
	const scan = async () => {
		const objects = new Set<string>();
		for await (const object of listAll(provider, root)) {
			if (object.size > 49 * 1024 * 1024 || object.size < 0 || objects.size >= 200000 || !new RegExp(`^${root}(?:keys/[a-z0-9-]{36}\\.json|updates/[a-z0-9-]{36}/[a-z0-9-]{36}\\.bin|snapshots/[a-z0-9-]{36}/(?:[a-z0-9-]{36}|index)\\.bin)$`).test(object.key)) throw new Error('源仓库含不支持的协议对象，未更换密钥');
			objects.add(object.key);
		}
		return objects;
	};
	const envelope = encoder.encode(JSON.stringify(manifest)); const envelopePath = manifestPath(manifest);
	if (await provider.headObject(envelopePath) !== null && await sha256(await provider.getObject(envelopePath)) !== await sha256(envelope)) throw new Error('目标密钥元数据冲突，未覆盖');
	let objects = await scan();
	if (!objects.has(manifestPath(state.manifest)) || Object.keys(state.known).some(path => !objects.has(path))) throw new Error('源仓库历史不完整，无法安全更换密钥');
	const copy = async (oldPath: string, plaintext: Uint8Array, originalHash: string) => {
		const path = destination + oldPath.slice(root.length); const contentHash = await sha256(plaintext);
		let bytes: Uint8Array;
		if (await provider.headObject(path) !== null) {
			bytes = await provider.getObject(path);
			if (await sha256(await decryptSyncObject(newKey, path, bytes)) !== contentHash) throw new Error('新密钥库已有不同内容，未覆盖或切换');
		} else { bytes = await encryptSyncObject(newKey, path, plaintext); await provider.putObject(path, bytes); }
		const hash = await sha256(bytes); if (await sha256(await provider.getObject(path)) !== hash) throw new Error('新密钥密文回读校验失败');
		copied.set(oldPath, { path, hash, originalHash }); progress(copied.size);
	};
	for (let pass = 0; pass < 3; pass++) {
		const paths = [...objects].filter(path => path.endsWith('.bin')).sort((a, b) => Number(a.endsWith('/index.bin')) - Number(b.endsWith('/index.bin')) || a.localeCompare(b));
		for (const path of paths) {
			if (copied.has(path)) continue;
			const bytes = await provider.getObject(path); const hash = await sha256(bytes);
			if (state.known[path] && state.known[path] !== hash) throw new Error('旧密文历史被更改，已停止更换密钥');
			const plaintext = await decryptSyncObject(oldKey, path, bytes);
			if (!path.endsWith('/index.bin')) { decodeUpdate(plaintext); await copy(path, plaintext, hash); continue; }
			const index = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
			if (index.format !== 'JoplinU snapshot' || index.version !== 1 || typeof index.createdAt !== 'number' || !Number.isFinite(index.createdAt) || index.createdAt < 0 || !Array.isArray(index.pieces) || !index.pieces.length || index.pieces.length > 10001 || !index.covered || typeof index.covered !== 'object') throw new Error('旧恢复快照索引无效');
			const names = new Set<string>(); const group = path.slice(0, -'index.bin'.length);
			const pieces = (index.pieces as { path: string; hash: string }[]).map(piece => { if (!piece || typeof piece.path !== 'string' || !new RegExp(`^${group}[a-z0-9-]{36}\\.bin$`).test(piece.path) || names.has(piece.path)) throw new Error('旧快照分片路径无效'); names.add(piece.path); const replacement = copied.get(piece.path); if (!replacement || replacement.originalHash !== piece.hash) throw new Error('旧快照缺少完整分片'); return { path: replacement.path, hash: replacement.hash }; });
			const covered: Record<string, string> = Object.create(null);
			for (const [oldPath, oldHash] of Object.entries(index.covered)) { const replacement = copied.get(oldPath); if (!replacement || replacement.originalHash !== oldHash || !oldPath.startsWith(root + 'updates/')) throw new Error('旧快照覆盖历史不完整'); covered[replacement.path] = replacement.hash; }
			await copy(path, encoder.encode(JSON.stringify({ ...index, pieces, covered })), hash);
		}
		const latest = await scan();
		if ([...objects].some(path => !latest.has(path))) throw new Error('旧仓库在轮换期间发生删除，请重试');
		if (latest.size === objects.size) {
			// Publish the new password-wrapped master key only after all history and
			// rewritten snapshot references have been verified. No mutable head.
			if (await provider.headObject(envelopePath) === null) await provider.putObject(envelopePath, envelope);
			if (await sha256(await provider.getObject(envelopePath)) !== await sha256(envelope)) throw new Error('新密钥元数据校验失败');
			const visible = new Set<string>(); for await (const object of listAll(provider, destination)) { visible.add(object.key); if (visible.size > 200000) throw new Error('新密钥库对象超出当前限制'); }
			if (!visible.has(envelopePath) || [...copied.values()].some(entry => !visible.has(entry.path))) throw new Error('新密钥库列表尚未完整可见，未切换，请重试');
			return copied;
		}
		objects = latest;
	}
	throw new Error('旧仓库持续增加更新，请暂停其他设备同步后重试；旧数据仍保留');
}
