import * as Y from 'yjs';
import { NoteDocument, minimalEdit } from '../../document/src/index';
import type { VaultStorage, JournalWrite } from '../../database/src/index';
import { createVault, createNote, decodeDocument, encodeDocument, fromBase64, toBase64, sha256, newId, validateVault, type Vault, type Note } from './model';
import { LibraryReplica, validateSyncState, MissingSyncDependencies, type SyncState, type SyncUpdate } from '../../sync/src/replica';
import type { SyncKeyManifest } from '../../crypto/src/sync';

export class LibraryController {
	private listeners = new Set<() => void>();
	private documents = new Map<string, NoteDocument>();
	private saving = false;
	private generation = 0;
	private contentGeneration = 0;
	private savedGeneration = 0;
	private revision = 0;
	/** State vectors and full encoded states from the last durable transaction. */
	private readonly savedVectors = new Map<string, Uint8Array>();
	private readonly savedStates = new Map<string, string>();
	private readonly journalSize = new Map<string, { count: number; bytes: number }>();
	private version = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private waiters: (() => void)[] = [];
	private replica: LibraryReplica | undefined;
	private applyingRemote = false;
	syncState: SyncState | undefined;
	syncRecoveryNote = '';
	status: 'loading' | 'pending' | 'saving' | 'saved' | 'error' = 'loading';
	error = '';
	vault!: Vault;
	constructor(readonly storage: VaultStorage) {}
	getSnapshot = () => this.version;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	private emit() { this.version++; for (const listener of this.listeners) listener(); }
	async open(initial = '') {
		try {
			const stored = await this.storage.read();
			this.revision = stored.revision;
			if (stored.payload === null && Object.values(stored.noteUpdates ?? {}).some(updates => updates.length)) {
				throw new Error('本地 Yjs 日志缺少资料库索引；已停止加载');
			}
			const parsed = stored.payload === null ? undefined : JSON.parse(stored.payload) as Record<string, unknown>;
			this.vault = parsed === undefined ? createVault(initial) : validateVault(parsed);
			if (parsed?.sync !== undefined) { this.syncState = validateSyncState(parsed.sync); this.replica = new LibraryReplica(this.syncState.meta); }
			// The v2 index stores metadata only. Every document is reconstructed
			// from its ordered Yjs journal before rendering or allowing writes.
			if (stored.payload !== null) for (const note of this.vault.notes) {
				const updates = stored.noteUpdates?.[note.id];
				if (!updates?.length) throw new Error('笔记缺少持久化 Yjs 日志；已停止加载，避免覆盖数据');
				const document = new NoteDocument();
				try {
					for (const encoded of updates) document.applyRemote(fromBase64(encoded));
					note.state = encodeDocument(document);
					this.savedVectors.set(note.id, Y.encodeStateVector(document.doc));
					this.savedStates.set(note.id, note.state);
					this.journalSize.set(note.id, { count: updates.length, bytes: updates.reduce((size, encoded) => size + encoded.length * 3 / 4, 0) });
				} finally { document.destroy(); }
			}
			for (const note of this.vault.notes) { const document = decodeDocument(note.state); document.destroy(); }
			for (const attachment of this.vault.attachments) if (await sha256(fromBase64(attachment.data)) !== attachment.sha256) throw new Error('本地附件校验失败；请导出原始资料以便恢复');
			this.status = 'saved';
			if (stored.payload === null) this.change(this.vault);
			this.emit();
		} catch (error) { this.status = 'error'; this.error = error instanceof Error ? error.message : '本地数据读取失败'; this.emit(); throw error; }
	}

	document(id: string): NoteDocument {
		const existing = this.documents.get(id);
		if (existing) return existing;
		const note = this.vault.notes.find(item => item.id === id);
		if (!note) throw new Error('笔记不存在');
		const document = decodeDocument(note.state);
		this.documents.set(id, document);
		document.onChange(() => {
			if (this.applyingRemote) return;
			const current = this.vault.notes.find(item => item.id === id);
			if (!current) return;
			let history = current.history;
			if (this.vault.preferences.history && (!history.length || Date.now() - history[0]!.createdAt > 60000)) {
				const previous = decodeDocument(current.state);
				try { history = this.addHistory(current, previous.source, '自动保存前版本'); } finally { previous.destroy(); }
			}
			this.updateNote(id, { state: encodeDocument(document), history, updatedAt: Date.now() });
		});
		return document;
	}
	change(vault: Vault) {
		if (vault.notes !== this.vault.notes || vault.folders !== this.vault.folders || vault.attachments !== this.vault.attachments) this.contentGeneration++;
		if (this.replica && !this.applyingRemote) this.replica.update(this.vault, vault);
		this.vault = vault;
		this.generation++;
		if (this.status !== 'error') this.status = 'pending';
		this.emit();
		clearTimeout(this.timer);
		if (this.status !== 'error') this.timer = setTimeout(() => { void this.flush(); }, 120);
	}
	updateNote(id: string, fields: Partial<Omit<Note, 'id'>>) {
		this.change({ ...this.vault, notes: this.vault.notes.map(note => note.id === id ? { ...note, ...fields } : note) });
	}
	duplicateNote(id: string): Note {
		const original = this.vault.notes.find(note => note.id === id && !note.deletedAt);
		if (!original) throw new Error('笔记不存在或已在回收站中');
		const document = this.document(id);
		if (document.isComposing) throw new Error('请先结束中文输入');
		const copy = { ...createNote(`${original.title.slice(0, 493)}（副本）`, original.folderId, document.source), kind: original.kind, tags: [...original.tags], location: original.location ? { ...original.location } : null };
		this.change({ ...this.vault, notes: [...this.vault.notes, copy] }); return copy;
	}
	setKind(id: string, kind: Note['kind']) {
		if (kind !== 'note' && kind !== 'todo') throw new Error('不支持的笔记类型');
		this.editableNote(id); this.updateNote(id, { kind, completedAt: null, updatedAt: Date.now() });
	}
	toggleTodo(id: string) {
		const note = this.editableNote(id); if (note.kind !== 'todo') throw new Error('这篇笔记不是待办');
		this.updateNote(id, { completedAt: note.completedAt === null ? Date.now() : null, updatedAt: Date.now() });
	}
	togglePin(id: string) { const note = this.editableNote(id); this.updateNote(id, { pinned: !note.pinned }); }
	renameTag(name: string, replacement: string) {
		const next = replacement.trim();
		if (!next || next.length > 100 || /[\r\n,，]/.test(next)) throw new Error('标签名称须为 1–100 个字符，且不包含逗号或换行');
		if (!this.vault.notes.some(note => note.tags.includes(name))) throw new Error('标签不存在');
		this.change({ ...this.vault, notes: this.vault.notes.map(note => note.tags.includes(name) ? { ...note, tags: [...new Set(note.tags.map(tag => tag === name ? next : tag))] } : note) });
	}
	removeTag(name: string) {
		this.change({ ...this.vault, notes: this.vault.notes.map(note => note.tags.includes(name) ? { ...note, tags: note.tags.filter(tag => tag !== name) } : note) });
	}
	private editableNote(id: string): Note {
		const note = this.vault.notes.find(note => note.id === id && !note.deletedAt);
		if (!note) throw new Error('笔记不存在或已在回收站中'); return note;
	}
	moveNotes(ids: string[], folderId: string | null) {
		const selected = this.requireNotes(ids);
		if (folderId !== null && !this.vault.folders.some(folder => folder.id === folderId)) throw new Error('目标文件夹不存在');
		this.change({ ...this.vault, notes: this.vault.notes.map(note => selected.has(note.id) ? { ...note, folderId } : note) });
	}
	trashNotes(ids: string[], deleted: boolean) {
		const selected = this.requireNotes(ids); const now = Date.now();
		this.change({ ...this.vault, notes: this.vault.notes.map(note => selected.has(note.id) && !!note.deletedAt !== deleted ? { ...note,
			history: deleted ? this.addHistory(note, this.document(note.id).source, '移入回收站前') : note.history, deletedAt: deleted ? now : null } : note) });
	}
	private requireNotes(ids: string[]): Set<string> {
		const selected = new Set(ids);
		const present = new Set(this.vault.notes.map(note => note.id));
		if (!selected.size || [...selected].some(id => !present.has(id))) throw new Error('请选择仍存在的笔记');
		if ([...selected].some(id => this.documents.get(id)?.isComposing)) throw new Error('请先结束中文输入');
		return selected;
	}
	private addHistory(note: Note, source: string, reason: string) {
		const cutoff = Date.now() - this.vault.preferences.historyDays * 86400000;
		return [{ id: newId(), source, createdAt: Date.now(), reason }, ...note.history.filter(entry => entry.createdAt >= cutoff)].slice(0, 1000);
	}
	checkpoint(id: string, reason = '手动快照') {
		const note = this.vault.notes.find(item => item.id === id);
		if (note) this.updateNote(id, { history: this.addHistory(note, this.document(id).source, reason) });
	}
	restore(id: string, source: string) {
		const document = this.document(id);
		if (document.isComposing) throw new Error('请结束中文输入后恢复版本');
		this.checkpoint(id, '恢复前版本');
		const edit = minimalEdit(document.source, source);
		if (edit) { document.undo.stopCapturing(); document.edit([edit], document.source); }
	}
	async flush(): Promise<void> {
		clearTimeout(this.timer);
		if (this.saving) return new Promise(resolve => this.waiters.push(resolve));
		if (this.savedGeneration === this.generation) return;
		this.saving = true;
		try {
			while (this.savedGeneration < this.generation) {
				const generation = this.generation;
				const snapshot = this.vault;
				validateVault(snapshot);
				const journal: JournalWrite = { updates: {}, replace: [], remove: [] };
				const committed = new Map<string, { vector: Uint8Array; state: string; count: number; bytes: number }>();
				const ids = new Set(snapshot.notes.map(note => note.id));
				for (const id of this.savedStates.keys()) if (!ids.has(id)) journal.remove.push(id);
				for (const note of snapshot.notes) {
					if (note.state === this.savedStates.get(note.id)) continue;
					const document = decodeDocument(note.state);
					try {
						const previous = this.savedVectors.get(note.id);
						const current = Y.encodeStateVector(document.doc);
						const delta = Y.encodeStateAsUpdate(document.doc, previous);
						const history = this.journalSize.get(note.id) ?? { count: 0, bytes: 0 };
						// Bound startup replay and native bridge overhead. Replacing
						// a journal with one full state is atomic with index changes.
						const compact = history.count >= 32 || history.bytes + delta.byteLength > 8 * 1024 * 1024;
						const bytes = compact ? Y.encodeStateAsUpdate(document.doc) : delta;
						journal.updates[note.id] = toBase64(bytes);
						if (compact) journal.replace.push(note.id);
						committed.set(note.id, {
							vector: current, state: note.state,
							count: compact ? 1 : history.count + 1,
							bytes: compact ? bytes.byteLength : history.bytes + bytes.byteLength,
						});
					} finally { document.destroy(); }
				}
				// No CRDT payload is duplicated in the metadata snapshot. New notes,
				// restored notes and incremental edits enter the same SQLite/IDB
				// transaction as folder, history, settings and attachment changes.
				const payload = JSON.stringify({ ...snapshot, notes: snapshot.notes.map(note => ({ ...note, state: '' })), ...(this.syncState ? { sync: { ...this.syncState, meta: this.replica!.encode() } } : {}) });
				this.status = 'saving'; this.emit();
				const revision = await this.storage.write(this.revision, payload, journal);
				this.revision = revision;
				for (const id of journal.remove) {
					this.savedStates.delete(id); this.savedVectors.delete(id); this.journalSize.delete(id);
				}
				for (const [id, entry] of committed) {
					this.savedStates.set(id, entry.state);
					this.savedVectors.set(id, entry.vector);
					this.journalSize.set(id, { count: entry.count, bytes: entry.bytes });
				}
				this.savedGeneration = generation;
			}
			this.error = ''; this.status = 'saved';
		} catch (error) {
			this.status = 'error'; this.error = error instanceof Error ? error.message : '本地保存失败，请导出备份';
		} finally { this.saving = false; this.emit(); for (const resolve of this.waiters.splice(0)) resolve(); }
	}

	log(message: string, level: 'info' | 'error' = 'info') {
		this.change({ ...this.vault, logs: [{ at: Date.now(), level, message }, ...this.vault.logs].slice(0, 200) });
	}
	get hasUnsavedChanges() { return this.generation !== this.savedGeneration; }
	get contentVersion() { return this.contentGeneration; }
	dismissSyncRecovery() { this.syncRecoveryNote = ''; this.emit(); }
	/** Creates a new metadata replica; joining merges rather than discarding this device's notes. */
	async enableSync(manifest: SyncKeyManifest) {
		if (this.syncState) throw new Error('当前资料库已连接同步库，请先锁定或使用现有同步库');
		await this.flush(); if (this.status === 'error' || this.hasUnsavedChanges) throw new Error(this.error || '请先保存本地资料');
		this.replica = new LibraryReplica(); this.replica.update(undefined, this.vault);
		this.syncState = { version: 1, manifest, device: newId(), meta: this.replica.encode(), vectors: {}, hashes: {}, outbox: [], known: {}, lastSync: null, autoSync: true };
		this.change(this.vault); await this.requireDurable();
	}
	async requireDurable() { await this.flush(); if (this.status === 'error' || this.hasUnsavedChanges) throw new Error(this.error || '本地保存尚未完成，暂停云操作'); }
	/** The caller persists ciphertext and its vectors before any upload. */
	async saveSyncState(state: SyncState) { this.syncState = state; this.change(this.vault); await this.requireDurable(); }
	syncCapture() {
		if (!this.syncState || !this.replica) throw new Error('请先创建或加入加密同步库');
		return { meta: this.replica.encode(), notes: this.vault.notes.map(note => ({ id: note.id, state: note.state })) };
	}
	async applySyncUpdates(updates: SyncUpdate[], known: Record<string, string>) {
		if (!this.syncState || !this.replica) throw new Error('同步库未连接');
		if ([...this.documents.values()].some(document => document.isComposing)) throw new Error('请先结束输入法组合输入，再应用远端更新');
		const generation = this.generation;
		const candidate = new LibraryReplica(this.replica.encode());
		const bodies = new Map<string, NoteDocument>();
		try {
			for (const note of this.vault.notes) bodies.set(note.id, decodeDocument(note.state));
			for (const update of updates) {
				if (update.target === 'meta') candidate.apply(update.update);
				else { const id = update.target.slice(5); let body = bodies.get(id); if (!body) bodies.set(id, body = new NoteDocument()); body.applyRemote(fromBase64(update.update)); }
			}
			if (candidate.doc.store.pendingStructs || candidate.doc.store.pendingDs || [...bodies.values()].some(body => body.doc.store.pendingStructs || body.doc.store.pendingDs)) throw new MissingSyncDependencies();
			const states = new Map([...bodies].map(([id, document]) => [id, encodeDocument(document)]));
			const vault = candidate.project(this.vault, states);
			const recovered = [...candidate.recovered].filter(id => !this.vault.notes.some(note => note.id === id && note.deletedAt !== null));
			if (recovered.length) vault.logs = [{ at: Date.now(), level: 'info' as const, message: `检测到删除后的离线编辑，${recovered.length} 篇笔记已保留到回收站` }, ...vault.logs].slice(0, 200);
			for (const attachment of vault.attachments) if (!this.vault.attachments.some(old => old.id === attachment.id && old.data === attachment.data && old.sha256 === attachment.sha256) && await sha256(fromBase64(attachment.data)) !== attachment.sha256) throw new Error('远端附件校验失败，已停止合并');
			if (generation !== this.generation || [...this.documents.values()].some(document => document.isComposing)) throw new Error('本地正在编辑，请稍后重试同步；修改均已保留');
			this.applyingRemote = true;
			try {
				for (const note of vault.notes) this.documents.get(note.id)?.applyRemote(fromBase64(note.state));
				for (const [id, document] of this.documents) if (!vault.notes.some(note => note.id === id)) { document.destroy(); this.documents.delete(id); }
				this.replica.destroy(); this.replica = candidate;
				this.syncState = { ...this.syncState, meta: candidate.encode(), known: { ...this.syncState.known, ...known } };
				if (recovered.length) this.syncRecoveryNote = `检测到删除后的离线编辑，已将 ${recovered.length} 篇笔记保留到回收站。`;
				this.change(vault);
			} finally { this.applyingRemote = false; }
			await this.requireDurable();
		} finally { if (candidate !== this.replica) candidate.destroy(); for (const body of bodies.values()) body.destroy(); }
	}
	dispose() { clearTimeout(this.timer); for (const document of this.documents.values()) document.destroy(); this.documents.clear(); this.replica?.destroy(); this.listeners.clear(); }
}
