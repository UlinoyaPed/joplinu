import { sha256 } from '../../core/src/bytes';
import { decryptSyncObject, matchesSyncManifest } from '../../crypto/src/sync';
import type { ObjectStorageProvider } from '../../storage/src/index';
import { listAll } from '../../storage/src/diagnostics';
import { rootPath, manifestPath, type SyncState } from './replica';

/** Copy the entire encrypted repository. Never deletes source/target objects or
 * overwrites a target whose bytes differ. Only bounded per-object buffers. */
export async function migrateRepository(
	source: ObjectStorageProvider, target: ObjectStorageProvider, key: CryptoKey, state: SyncState,
	progress: (objects: number) => void,
): Promise<number> {
	const root = rootPath(state); const copied = new Map<string, string>();
	const scan = async (provider: ObjectStorageProvider) => {
		const objects = new Set<string>();
		for await (const object of listAll(provider, root)) {
			if (!object.key.startsWith(root) || object.key.split('/').some(part => !part || part === '.' || part === '..') || object.key.includes('\\') || object.size > 49 * 1024 * 1024 || object.size < 0 || objects.size >= 200000) throw new Error('迁移对象范围或大小超出限制');
			objects.add(object.key);
		}
		return objects;
	};
	let objects = await scan(source);
	if (!objects.has(manifestPath(state.manifest)) || Object.keys(state.known).some(path => !objects.has(path))) throw new Error('源同步仓库缺少密钥或已确认历史，已停止迁移');
	for (let pass = 0; pass < 3; pass++) {
		const order = (path: string) => path.includes('/keys/') ? 2 : path.endsWith('/index.bin') ? 1 : 0;
		for (const path of [...objects].sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
			if (copied.has(path)) continue;
			const bytes = await source.getObject(path); const hash = await sha256(bytes);
			if (state.known[path] && state.known[path] !== hash) throw new Error('源历史对象校验失败，未切换存储');
			if (path === manifestPath(state.manifest) && !matchesSyncManifest(bytes, state.manifest)) throw new Error('源密钥元数据与当前同步库不符');
			if (path.endsWith('.bin')) await decryptSyncObject(key, path, bytes);
			if (await target.headObject(path) === null) await target.putObject(path, bytes);
			if (await sha256(await target.getObject(path)) !== hash) throw new Error('目标存在不同内容或回读校验失败；未覆盖目标，未切换存储');
			copied.set(path, hash); progress(copied.size);
		}
		const latest = await scan(source);
		if ([...objects].some(path => !latest.has(path))) throw new Error('迁移期间源对象被删除，已停止切换');
		if (latest.size === objects.size) {
			const destination = await scan(target);
			if ([...latest].some(path => !destination.has(path))) throw new Error('目标列表尚未完整可见，请重试迁移');
			return copied.size;
		}
		objects = latest;
	}
	throw new Error('源仓库持续增加更新，请暂停其他设备同步后重试；已复制对象保持原样');
}
