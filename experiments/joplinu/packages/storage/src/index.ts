import * as Y from 'yjs';
import { NoteDocument } from '../../document/src/index';

/** Append is acknowledged only after a durable, atomic local commit. */
export interface DocumentUpdateStore {
	load(noteId: string): Promise<Uint8Array[]>;
	append(noteId: string, update: Uint8Array): Promise<void>;
}

export type SaveStatus = 'saved' | 'saving' | 'error';

export function checkNoteId(noteId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(noteId)) {
		throw new Error('Invalid document identifier');
	}
}

/**
 * All Yjs updates, including undo/redo and merged remote edits, enter one
 * ordered queue. A failed append remains at the head until explicitly retried.
 * Never acknowledge an update before the underlying store commits it.
 */
export class PersistedNote {
	readonly note: NoteDocument;
	private readonly store: DocumentUpdateStore;
	private readonly noteId: string;
	private readonly pending: Uint8Array[] = [];
	private readonly listeners = new Set<() => void>();
	private running: Promise<void> | undefined;
	private failure: unknown;
	private currentStatus: SaveStatus = 'saved';
	private readonly observer: (update: Uint8Array) => void;

	private constructor(store: DocumentUpdateStore, noteId: string, note: NoteDocument) {
		this.store = store;
		this.noteId = noteId;
		this.note = note;
		this.observer = update => {
			this.pending.push(update.slice());
			this.setStatus(this.failure ? 'error' : 'saving');
			void this.flush().catch(() => { /* Error remains visible and queued. */ });
		};
		note.doc.on('update', this.observer);
	}

	static async open(store: DocumentUpdateStore, noteId: string, initial: string): Promise<PersistedNote> {
		checkNoteId(noteId);
		// Failure is fatal to initialization: do not open a sample document over
		// an unreadable/corrupt database or present an editor until hydration ends.
		const log = await store.load(noteId);
		if (log.length === 0) {
			const note = new NoteDocument(initial);
			try {
				// Also persist an empty initial document, so an intentional empty
				// note cannot be confused with a missing note on the next launch.
				await store.append(noteId, Y.encodeStateAsUpdate(note.doc));
				return new PersistedNote(store, noteId, note);
			} catch (error) {
				note.destroy();
				throw error;
			}
		}
		const doc = new Y.Doc();
		try {
			for (const update of log) Y.applyUpdate(doc, update, 'restore');
			// UndoManager starts AFTER replay. Historical changes must never
			// accidentally become undoable local edits of this session.
			return new PersistedNote(store, noteId, new NoteDocument('', doc));
		} catch (error) {
			doc.destroy();
			throw new Error('本地更新日志无法恢复；已停止打开编辑器，避免覆盖数据。', { cause: error });
		}
	}

	get status(): SaveStatus { return this.currentStatus; }
	get unsavedCount(): number { return this.pending.length; }

	onStatus(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private setStatus(next: SaveStatus): void {
		if (this.currentStatus === next) return;
		this.currentStatus = next;
		for (const listener of this.listeners) listener();
	}

	flush(): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.running) return this.running;
		if (this.pending.length === 0) {
			this.setStatus('saved');
			return Promise.resolve();
		}
		this.setStatus('saving');
		const task = (async () => {
			while (this.pending.length > 0) {
				await this.store.append(this.noteId, this.pending[0]!);
				this.pending.shift();
			}
		})();
		this.running = task;
		void task.then(() => {
			this.running = undefined;
			if (this.pending.length > 0) {
				void this.flush().catch(() => {});
			} else this.setStatus('saved');
		}, error => {
			this.running = undefined;
			this.failure = error;
			this.setStatus('error');
		});
		return task;
	}

	/** Retains every failed and subsequent update; replay is Yjs-idempotent. */
	retry(): Promise<void> {
		if (this.running) return this.running;
		this.failure = undefined;
		return this.flush();
	}

	destroy(): void {
		this.note.doc.off('update', this.observer);
		this.listeners.clear();
		this.note.destroy();
	}
}
