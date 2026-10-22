import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NoteDocument } from '../packages/document/src/index';
import { PersistedNote, type DocumentUpdateStore } from '../packages/storage/src/index';

class MemoryUpdateStore implements DocumentUpdateStore {
	readonly updates: Uint8Array[] = [];
	fail = false;
	async load() { return this.updates.map(update => update.slice()); }
	async append(_noteId: string, update: Uint8Array) {
		if (this.fail) throw new Error('Simulated disk full');
		this.updates.push(update.slice());
	}
}

describe('durable update queue boundary', () => {
	it('writes the initial snapshot only once and replays exact Markdown across restart', async () => {
		const store = new MemoryUpdateStore();
		const seed = '# 中😀文  \r\n\r\n:::x\n原样\n:::\n';
		const first = await PersistedNote.open(store, 'primary', seed);
		expect(store.updates).toHaveLength(1);
		first.note.edit([{ from: seed.length, to: seed.length, insert: '结束' }]);
		await first.flush();
		const expected = first.note.source;
		first.destroy();
		const restarted = await PersistedNote.open(store, 'primary', 'must-not-overwrite');
		expect(restarted.note.source).toBe(expected);
		expect(store.updates).toHaveLength(2);
		expect(restarted.note.undo.undoStack).toHaveLength(0);
		restarted.destroy();
	});

	it('persists local undo, redo and merged Yjs remote updates without touching projections', async () => {
		const store = new MemoryUpdateStore();
		const primary = await PersistedNote.open(store, 'primary', 'abc');
		primary.note.edit([{ from: 1, to: 1, insert: '甲' }]);
		primary.note.undo.undo();
		primary.note.undo.redo();
		const peer = new NoteDocument();
		peer.applyRemote(Y.encodeStateAsUpdate(primary.note.doc));
		peer.edit([{ from: peer.source.length, to: peer.source.length, insert: '乙' }]);
		primary.note.applyRemote(Y.encodeStateAsUpdate(peer.doc));
		await primary.flush();
		const source = primary.note.source;
		primary.destroy();
		const restarted = await PersistedNote.open(store, 'primary', 'irrelevant');
		expect(restarted.note.source).toBe(source);
		expect(source).toContain('甲');
		expect(source).toContain('乙');
		restarted.destroy();
		peer.destroy();
	});

	it('never drops updates when storage fails, including edits after a failure', async () => {
		const store = new MemoryUpdateStore();
		const doc = await PersistedNote.open(store, 'primary', 'base');
		store.fail = true;
		doc.note.edit([{ from: 4, to: 4, insert: 'A' }]);
		await expect(doc.flush()).rejects.toThrow('Simulated disk full');
		expect(doc.status).toBe('error');
		doc.note.edit([{ from: 5, to: 5, insert: 'B' }]);
		expect(doc.unsavedCount).toBe(2);
		store.fail = false;
		await doc.retry();
		expect(doc.status).toBe('saved');
		expect(doc.unsavedCount).toBe(0);
		doc.destroy();
		const restored = await PersistedNote.open(store, 'primary', 'bad-seed');
		expect(restored.note.source).toBe('baseAB');
		restored.destroy();
	});

	it('refuses to silently seed a new document if recovery fails', async () => {
		const store: DocumentUpdateStore = {
			load: async () => { throw new Error('Corrupt database'); },
			append: async () => { throw new Error('Must not append'); },
		};
		await expect(PersistedNote.open(store, 'primary', 'sample')).rejects.toThrow('Corrupt database');
	});

	it('rejects unsafe ids before the storage bridge is called', async () => {
		const store = new MemoryUpdateStore();
		await expect(PersistedNote.open(store, '../escape', 'seed')).rejects.toThrow('identifier');
		expect(store.updates).toHaveLength(0);
	});
});
