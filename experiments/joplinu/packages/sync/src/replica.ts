import * as Y from 'yjs';
import { fromBase64, toBase64 } from '../../core/src/bytes';
import { validateManifest, type SyncKeyManifest } from '../../crypto/src/sync';
import { validateVault, type Vault, type Note, type Folder, type Attachment } from '../../library/src/model';

export interface QueuedObject { path: string; ciphertext: string; hash: string }
export interface SyncState {
	version: 1; manifest: SyncKeyManifest; device: string; meta: string;
	vectors: Record<string, string>; hashes: Record<string, string>; outbox: QueuedObject[]; known: Record<string, string>;
	lastSync: number | null;
	autoSync: boolean;
}
export interface SyncUpdate { target: string; update: string }
const id = /^[a-zA-Z0-9-]{1,100}$/;
export const isSyncTarget = (value: string) => /^(?:meta|note:[a-zA-Z0-9-]{1,100})$/.test(value);
export const rootPath = (state: SyncState) => `vaults/${state.manifest.vault}/`;
export const manifestPath = (manifest: SyncKeyManifest) => `vaults/${manifest.vault}/keys/${manifest.key}.json`;
export function validateSyncState(value: unknown): SyncState {
	if (!value || typeof value !== 'object') throw new Error('同步状态损坏');
	const s = value as SyncState; const manifest = validateManifest(s.manifest);
	if (s.version !== 1 || !id.test(s.device) || typeof s.meta !== 'string' || !Array.isArray(s.outbox) || s.outbox.length > 20000 || !s.known || !s.vectors || !s.hashes || (s.lastSync !== null && (!Number.isFinite(s.lastSync) || s.lastSync < 0))) throw new Error('同步状态格式无效');
	const doc = new Y.Doc(); try { Y.applyUpdate(doc, fromBase64(s.meta)); } finally { doc.destroy(); }
	const vectors: Record<string, string> = Object.create(null); const known: Record<string, string> = Object.create(null); const hashes: Record<string, string> = Object.create(null);
	for (const [target, value] of Object.entries(s.vectors)) { if (!isSyncTarget(target) || typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw new Error('同步向量损坏'); Y.decodeStateVector(fromBase64(value)); vectors[target] = value; }
	for (const [target, hash] of Object.entries(s.hashes)) { if (!isSyncTarget(target) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('同步摘要损坏'); hashes[target] = hash; }
	const validPath = (path: string, snapshots = false) => typeof path === 'string' && path.startsWith(`vaults/${manifest.vault}/`) && (/^vaults\/[a-z0-9-]+\/updates\/[a-zA-Z0-9-]+\/[a-z0-9-]+\.bin$/.test(path) || (snapshots && /^vaults\/[a-z0-9-]+\/snapshots\/[a-z0-9-]+\/(?:[a-z0-9-]+|index)\.bin$/.test(path)));
	for (const [path, hash] of Object.entries(s.known)) { if (!validPath(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('同步检查点损坏'); known[path] = hash; }
	const paths = new Set<string>();
	const outbox = s.outbox.map(q => { if (!q || !validPath(q.path, true) || paths.has(q.path) || typeof q.ciphertext !== 'string' || q.ciphertext.length > 66 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(q.hash)) throw new Error('上传队列损坏'); paths.add(q.path); fromBase64(q.ciphertext); return { path: q.path, ciphertext: q.ciphertext, hash: q.hash }; });
	if (typeof s.autoSync !== 'boolean') throw new Error('同步设置损坏');
	return { version: 1, manifest, device: s.device, meta: s.meta, vectors, hashes, known, outbox, lastSync: s.lastSync, autoSync: s.autoSync };
}

/** Per-field CRDT metadata. Bodies retain their independent authoritative Y.Text documents. */
export class LibraryReplica {
	readonly doc = new Y.Doc();
	private readonly fields = this.doc.getMap<unknown>('fields');
	constructor(state?: string) { if (state) Y.applyUpdate(this.doc, fromBase64(state)); }
	encode() { return toBase64(Y.encodeStateAsUpdate(this.doc)); }
	destroy() { this.doc.destroy(); }
	apply(update: string) { Y.applyUpdate(this.doc, fromBase64(update)); }
	update(before: Vault | undefined, after: Vault) {
		this.doc.transact(() => {
			const collection = <T extends { id: string }>(kind: string, previous: T[], current: T[], ignored: string[] = []) => {
				const old = new Map(previous.map(v => [v.id, v])); const present = new Set(current.map(v => v.id));
				for (const entry of previous) if (!present.has(entry.id)) this.fields.set(`${kind}/${entry.id}/removed`, true);
				for (const entry of current) {
					const prior = old.get(entry.id);
					if (!prior) this.fields.set(`${kind}/${entry.id}/removed`, false);
					for (const [field, value] of Object.entries(entry)) if (field !== 'id' && !ignored.includes(field) && (!prior || JSON.stringify(value) !== JSON.stringify((prior as Record<string, unknown>)[field]))) this.fields.set(`${kind}/${entry.id}/${field}`, value);
				}
			};
			collection('folder', before?.folders ?? [], after.folders);
			collection('note', before?.notes ?? [], after.notes, ['state', 'history', 'tags']);
			collection('attachment', before?.attachments ?? [], after.attachments);
			for (const note of after.notes) {
				const prior = before?.notes.find(n => n.id === note.id);
				for (const tag of new Set([...(prior?.tags ?? []), ...note.tags])) if (!prior || prior.tags.includes(tag) !== note.tags.includes(tag)) this.fields.set(`tag/${note.id}/${encodeURIComponent(tag)}`, note.tags.includes(tag));
				collection(`history-${note.id}`, prior?.history ?? [], note.history);
			}
		});
	}
	project(local: Vault, states: Map<string, string>): Vault {
		const groups = new Map<string, Map<string, Record<string, unknown>>>();
		for (const [key, value] of this.fields) {
			const [kind, entryId, field, ...extra] = key.split('/');
			if (!kind || !entryId || !id.test(entryId) || !field || extra.length) throw new Error('同步元数据字段无效');
			let group = groups.get(kind); if (!group) groups.set(kind, group = new Map());
			let record = group.get(entryId); if (!record) { record = Object.create(null) as Record<string, unknown>; record.id = entryId; group.set(entryId, record); }
			record[field] = value;
		}
		const rows = (kind: string) => [...groups.get(kind)?.values() ?? []].filter(r => r.removed !== true).map(({ removed: _removed, ...rest }) => rest);
		const folders = rows('folder') as unknown as Folder[]; const folderIds = new Set(folders.map(f => f.id));
		// Two valid offline moves may form a cycle when merged. Break each cycle
		// deterministically at its lexicographically smallest ID without deleting contents.
		for (const folder of folders) if (folder.parentId !== null && !folderIds.has(folder.parentId)) folder.parentId = null;
		const byId = new Map(folders.map(f => [f.id, f]));
		for (const folder of folders) {
			const seen: string[] = []; let cursor: Folder | undefined = folder;
			while (cursor && !seen.includes(cursor.id)) { seen.push(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
			if (cursor) byId.get(seen.slice(seen.indexOf(cursor.id)).sort()[0]!)!.parentId = null;
		}
		const notes = rows('note').map(record => {
			const noteId = String(record.id); const state = states.get(noteId);
			if (!state) throw new Error('远端笔记更新尚不完整，请稍后重试；本地资料未替换');
			const tags = Object.entries(groups.get('tag')?.get(noteId) ?? {}).filter(([k, v]) => k !== 'id' && v === true).map(([k]) => decodeURIComponent(k));
			const history = rows(`history-${noteId}`).sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || String(a.id).localeCompare(String(b.id))).slice(0, 1000);
			return { ...record, state, tags, history, folderId: folderIds.has(String(record.folderId)) ? record.folderId : null, completedAt: record.kind === 'note' ? null : record.completedAt };
		}) as unknown as Note[];
		const attachments = rows('attachment') as unknown as Attachment[];
		return validateVault({ ...local, folders, notes, attachments });
	}
}
