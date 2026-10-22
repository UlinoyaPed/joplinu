import { NoteDocument, minimalEdit } from '../../document/src/index';
import type { VaultStorage } from '../../database/src/index';
import { createVault, decodeDocument, encodeDocument, fromBase64, sha256, newId, validateVault, type Vault, type Note } from './model';

export class LibraryController {
	private listeners = new Set<() => void>();
	private documents = new Map<string, NoteDocument>();
	private saving = false;
	private generation = 0;
	private savedGeneration = 0;
	private revision = 0;
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
			this.vault = stored.payload === null ? createVault(initial) : validateVault(JSON.parse(stored.payload));
			// Detect corrupt CRDT before enabling editing. Never replace a failed load with an empty vault.
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
				validateVault(this.vault);
				const payload = JSON.stringify(this.vault);
				this.status = 'saving'; this.emit();
				this.revision = await this.storage.write(this.revision, payload);
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
