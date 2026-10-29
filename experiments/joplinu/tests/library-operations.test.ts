import { describe, expect, it } from 'vitest';
import { LibraryController } from '../packages/library/src/controller';
import { createNote, createVault, defaultPreferences, dissolveFolder, folderPath, newId, validatePreferences, validateVault } from '../packages/library/src/model';
import { createBackup, readBackup, searchableNotes } from '../packages/library/src/transfer';
import type { StoredVault, VaultStorage } from '../packages/database/src/index';

function storage(): VaultStorage {
	let record: StoredVault = { revision: 0, payload: null, noteUpdates: {} };
	return {
		kind: 'operation-test',
		read: async () => structuredClone(record),
		check: async () => 'ok',
		write: async (revision, payload, journal = { updates: {}, replace: [], remove: [] }) => {
			if (record.revision !== revision) throw new Error('stale revision');
			const noteUpdates = structuredClone(record.noteUpdates ?? {});
			for (const id of [...journal.replace, ...journal.remove]) delete noteUpdates[id];
			for (const [id, update] of Object.entries(journal.updates)) (noteUpdates[id] ??= []).push(update);
			record = { revision: revision + 1, payload, noteUpdates };
			return record.revision;
		},
	};
}

describe('library organization and older backups', () => {
	it('opens old preferences without layout fields, preserves explicit hidden panes and rejects invalid widths', () => {
		const legacy: Record<string, unknown> = { ...defaultPreferences };
		for (const key of ['sidebarWidth', 'noteListWidth', 'showSidebar', 'showNoteList']) delete legacy[key];
		expect(validatePreferences(legacy)).toEqual(defaultPreferences);
		expect(validatePreferences({ ...legacy, showSidebar: false, showNoteList: false })).toMatchObject({ showSidebar: false, showNoteList: false });
		for (const fields of [{ sidebarWidth: 0 }, { noteListWidth: 900 }, { showSidebar: 'false' }]) expect(() => validatePreferences({ ...legacy, ...fields })).toThrow();
	});
	it('dissolves only one folder, retaining child identities, deleted notes, raw content and history through backup', async () => {
		const vault = createVault('父目录原文'); const parent = vault.folders[0]!;
		const folder = { id: newId(), name: '移除这一层', parentId: parent.id, createdAt: 1 };
		const child = { id: newId(), name: '子目录', parentId: folder.id, createdAt: 2 };
		const note = { ...createNote('直接笔记', folder.id, '~~~ts\r\nlet x = 1;\r\n~~~'), history: [{ id: newId(), source: '历史内容', createdAt: 1, reason: '手动' }] };
		const deleted = { ...createNote('已删除', folder.id, '可恢复的内容'), deletedAt: 1 };
		vault.folders.push(folder, child); vault.notes.push(note, deleted, createNote('子笔记', child.id));
		const next = validateVault(dissolveFolder(vault, folder.id));
		expect(next.notes.find(item => item.id === note.id)).toEqual({ ...note, folderId: parent.id });
		expect(next.notes.find(item => item.id === deleted.id)).toEqual({ ...deleted, folderId: parent.id });
		expect(folderPath(next, child.id)).toEqual([parent.name, child.name]);
		expect(next.notes.map(item => item.id)).toEqual(vault.notes.map(item => item.id));
		expect((await readBackup(await createBackup(next))).notes).toEqual(next.notes);
		expect(vault.folders).toContain(folder); expect(() => dissolveFolder(vault, 'missing')).toThrow();
	});
	it('creates an independent CRDT copy with tags and attachment links, without changing original history', async () => {
		const database = storage(); const controller = new LibraryController(database);
		const source = '\ufeff# 原文  \r\n\r\n![图](attachment:resource)\r\n:::unknown\r\n';
		await controller.open(source); const original = controller.vault.notes[0]!;
		controller.updateNote(original.id, { tags: ['重要'], location: { latitude: 31, longitude: 121 } }); controller.checkpoint(original.id);
		const before = controller.vault.notes[0]!; const copy = controller.duplicateNote(original.id);
		expect(copy).toMatchObject({ tags: ['重要'], location: before.location, history: [], folderId: original.folderId }); expect(copy.id).not.toBe(original.id);
		expect(controller.document(copy.id).source).toBe(source); controller.document(copy.id).edit([{ from: 0, to: 0, insert: '副本修改' }]);
		expect(controller.document(original.id).source).toBe(source); expect(controller.vault.notes[0]).toBe(before);
		await controller.flush(); const reopened = new LibraryController(database); await reopened.open();
		expect(reopened.document(original.id).source).toBe(source); expect(reopened.document(copy.id).source).toBe('副本修改' + source);
		controller.dispose(); reopened.dispose();
	});
	it('rejects a complete batch during composition or invalid moves and retains restorable history after bulk trash', async () => {
		const database = storage(); const controller = new LibraryController(database); await controller.open('第一篇');
		const first = controller.vault.notes[0]!; const second = createNote('第二篇', null, '第二篇');
		controller.change({ ...controller.vault, notes: [...controller.vault.notes, second] }); const ids = [first.id, second.id];
		const document = controller.document(second.id); const owner = {}; document.beginComposition(owner); const baseline = controller.vault;
		expect(() => controller.trashNotes(ids, true)).toThrow('中文输入'); expect(() => controller.moveNotes(ids, first.folderId)).toThrow('中文输入'); expect(controller.vault).toBe(baseline);
		document.endComposition(owner); expect(() => controller.moveNotes(ids, 'missing')).toThrow(); expect(controller.vault).toBe(baseline);
		expect(() => controller.trashNotes([first.id, 'missing'], true)).toThrow(); expect(controller.vault).toBe(baseline);
		controller.moveNotes(ids, null); controller.trashNotes(ids, true); await controller.flush();
		const reopened = new LibraryController(database); await reopened.open();
		for (const note of reopened.vault.notes) { expect(note.folderId).toBeNull(); expect(note.deletedAt).toBeTruthy(); expect(note.history[0]?.source).toBe(reopened.document(note.id).source); }
		reopened.trashNotes(ids, false); expect(reopened.vault.notes.every(note => note.deletedAt === null)).toBe(true); expect(reopened.document(first.id).source).toBe('第一篇');
		controller.dispose(); reopened.dispose();
	});
	it('filters exact tags together with text search and excludes trash without treating body text as a tag', () => {
		const vault = createVault('重要 项目内容'); const tagged = { ...createNote('项目', null, '共同内容'), tags: ['重要'] };
		vault.notes.push(tagged, { ...createNote('回收站', null, '共同内容'), tags: ['重要'], deletedAt: 1 });
		expect(searchableNotes(vault, '', null, false, '重要').map(note => note.id)).toEqual([tagged.id]);
		expect(searchableNotes(vault, '共同', null, false, '重要').map(note => note.id)).toEqual([tagged.id]);
		expect(searchableNotes(vault, '不存在', null, false, '重要')).toEqual([]);
	});
});
