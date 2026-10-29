import * as Y from 'yjs';
import { NoteDocument, minimalEdit } from '../../document/src/index';
import type { VaultStorage, JournalWrite } from '../../database/src/index';
import { createVault, createNote, decodeDocument, encodeDocument, fromBase64, toBase64, sha256, newId, validateVault, type Vault, type Note } from './model';

export class LibraryController {
	private listeners = new Set<() => void>();
	private documents = new Map<string, NoteDocument>();
	private saving = false;
	private generation = 0;
	private savedGeneration = 0;
	private revision = 0;
	/** State vectors and full encoded states from the last durable transaction. */
	private readonly savedVectors = new Map<string, Uint8Array>();
	private readonly savedStates = new Map<string, string>();
	private readonly journalSize = new Map<string, { count: number; bytes: number }>();
	private version = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private waiters: (() => void)[] = [];
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
			this.vault = stored.payload === null ? createVault(initial) : validateVault(JSON.parse(stored.payload));
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
		const copy = { ...createNote(`${original.title.slice(0, 493)}（副本）`, original.folderId, document.source), tags: [...original.tags], location: original.location ? { ...original.location } : null };
		this.change({ ...this.vault, notes: [...this.vault.notes, copy] }); return copy;
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
				const payload = JSON.stringify({ ...snapshot, notes: snapshot.notes.map(note => ({ ...note, state: '' })) });
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
	dispose() { clearTimeout(this.timer); for (const document of this.documents.values()) document.destroy(); this.documents.clear(); this.listeners.clear(); }
}
