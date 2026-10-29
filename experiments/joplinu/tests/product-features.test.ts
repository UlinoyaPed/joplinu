import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { markdownCommand, type MarkdownCommand } from '../packages/editor/src/markdown-commands';
import { createNote, createVault, validateVault } from '../packages/library/src/model';
import { LibraryController } from '../packages/library/src/controller';
import { createBackup, readBackup, mergeBackup, searchableNotes } from '../packages/library/src/transfer';
import { compileSearch, matchesSearch } from '../packages/library/src/search';
import type { StoredVault, VaultStorage } from '../packages/database/src/index';

function apply(source: string, from: number, to: number, name: MarkdownCommand) {
	const result = markdownCommand(source, { anchor: from, head: to }, name);
	return { ...result, source: ChangeSet.of(result.edits, source.length).apply(Text.of(source.split('\n'))).toString() };
}
function database(): VaultStorage {
	let record: StoredVault = { revision: 0, payload: null, noteUpdates: {} };
	return { kind: 'test', read: async () => structuredClone(record), check: async () => 'ok', write: async (revision, payload, journal = { updates: {}, replace: [], remove: [] }) => {
		if (revision !== record.revision) throw new Error('stale'); const noteUpdates = structuredClone(record.noteUpdates ?? {});
		for (const id of [...journal.replace, ...journal.remove]) delete noteUpdates[id];
		for (const [id, update] of Object.entries(journal.updates)) (noteUpdates[id] ??= []).push(update);
		record = { revision: revision + 1, payload, noteUpdates }; return record.revision;
	} };
}

describe('Markdown editing commands', () => {
	it.each([['bold', '**'], ['italic', '*'], ['strike', '~~']] as const)('%s wraps and toggles just the selection, preserving CRLF, emoji and unknown blocks', (name, marker) => {
		const source = '# 前文  \r\n\r\n😀文字\r\n\r\n:::custom\r\n不动\r\n:::\r\n'; const from = source.indexOf('😀');
		const result = apply(source, from, from + 4, name); expect(result.source).toBe(source.replace('😀文字', `${marker}😀文字${marker}`));
		expect(result.source.slice(result.selection.anchor, result.selection.head)).toBe('😀文字');
		expect(apply(result.source, result.selection.anchor, result.selection.head, name).source).toBe(source);
	});
	it('inserts into an empty selection with a caret inside the delimiters', () => {
		const result = apply('', 0, 0, 'bold'); expect(result.source).toBe('****'); expect(result.selection).toEqual({ anchor: 2, head: 2 });
	});
	it('formats selected lines without rewriting neighboring fences and toggles prefixes', () => {
		const source = '~~~js\r\nlet x = 1;\r\n~~~\r\n\r\n甲\r\n  乙\r\n\r\n末尾  ';
		const from = source.indexOf('甲'); const to = source.indexOf('乙') + 1;
		const result = apply(source, from, to, 'task'); expect(result.source).toBe(source.replace('甲\r\n  乙', '- [ ] 甲\r\n  - [ ] 乙'));
		expect(apply(result.source, result.selection.anchor, result.selection.head, 'task').source).toBe(source);
	});
	it('selects whole lines for fences and chooses a delimiter longer than nested backticks', () => {
		const source = '前文\n\n```js\n文字\n```\n\n后文'; const from = source.indexOf('```'); const to = source.lastIndexOf('```') + 3;
		expect(apply(source, from, to, 'code').source).toBe('前文\n\n````\n```js\n文字\n```\n````\n\n后文');
		expect(apply('`中间`', 0, 4, 'inlineCode').source).toBe('`` `中间` ``');
	});
	it('escapes link labels, selects the URL and rejects invalid offsets', () => {
		const result = apply('前文 [名称] 后文', 3, 7, 'link'); expect(result.source).toBe('前文 [\\[名称\\]](https://) 后文');
		expect(result.source.slice(result.selection.anchor, result.selection.head)).toBe('https://');
		expect(() => apply('文', -1, 1, 'bold')).toThrow(RangeError);
	});
});

describe('to-do notes, pinning and search', () => {
	it('persists completion and pin state, copies as a new pending task and retains them through backup and trash', async () => {
		const storage = database(); const controller = new LibraryController(storage); await controller.open('正文任务 - [ ] 不自动修改'); const id = controller.vault.notes[0]!.id;
		controller.setKind(id, 'todo'); controller.toggleTodo(id); controller.togglePin(id); const source = controller.document(id).source;
		await controller.flush(); const reopened = new LibraryController(storage); await reopened.open();
		expect(reopened.vault.notes[0]).toMatchObject({ kind: 'todo', pinned: true }); expect(reopened.vault.notes[0]!.completedAt).not.toBeNull();
		const copy = reopened.duplicateNote(id); expect(copy).toMatchObject({ kind: 'todo', completedAt: null, pinned: false });
		reopened.trashNotes([id], true); reopened.trashNotes([id], false); expect(reopened.document(id).source).toBe(source);
		const restored = mergeBackup(createVault(), await readBackup(await createBackup(reopened.vault)), false);
		expect(restored.notes.find(note => note.pinned)).toMatchObject({ kind: 'todo' });
		reopened.setKind(id, 'note'); expect(reopened.vault.notes.find(note => note.id === id)?.completedAt).toBeNull();
		reopened.trashNotes([id], true); expect(() => reopened.toggleTodo(id)).toThrow(); expect(() => reopened.togglePin(id)).toThrow(); controller.dispose(); reopened.dispose();
	});
	it('defaults missing new fields and rejects impossible task states without discarding content', () => {
		const vault = createVault('保留'); const old = JSON.parse(JSON.stringify(vault)); delete old.notes[0].kind; delete old.notes[0].pinned; delete old.notes[0].completedAt;
		expect(validateVault(old).notes[0]).toEqual(vault.notes[0]);
		for (const patch of [{ pinned: 'true' }, { kind: 'unknown' }, { completedAt: 1 }]) expect(() => validateVault({ ...vault, notes: [{ ...vault.notes[0], ...patch }] })).toThrow();
	});
	it('combines phrases, exact tags, negation, notebook and typed filters; pins sort ahead of recent notes', () => {
		const vault = createVault('不匹配'); const parent = vault.folders[0]!.id;
		const task = { ...createNote('发布 项目', parent, 'coffee tea'), kind: 'todo' as const, tags: ['重要 项目'], pinned: true };
		vault.notes.push(task, { ...createNote('发布', null, 'coffee'), tags: ['归档'] });
		const ids = (query: string) => searchableNotes(vault, query, null, false).map(note => note.id);
		expect(ids('type:todo is:uncompleted tag:"重要 项目" title:"发布 项目" -body:取消 notebook:我的笔记')).toEqual([task.id]);
		expect(ids('any:1 tea coffee -tag:归档')).toEqual([task.id]); expect(ids('is:completed')).toEqual([]); expect(ids('')).toHaveProperty('0', task.id);
		expect(ids('https://example.com')).toEqual([]); expect(ids('is:unknown')).toEqual([]);
		expect(compileSearch('title:"未结束的短语')).toMatchObject({ terms: [{ value: '未结束的短语' }] });
	});
	it('metadata-only filters do not decode document bodies and negative clauses still apply in OR mode', () => {
		const note = { ...createNote('计划', null), kind: 'todo' as const, tags: ['归档'], pinned: true };
		const body = () => { throw new Error('must stay lazy'); };
		expect(matchesSearch(note, [], body, compileSearch('type:todo is:pinned'), 'zh-CN')).toBe(true);
		expect(matchesSearch(note, [], body, compileSearch('any:1 title:计划 is:pinned -tag:归档'), 'zh-CN')).toBe(false);
	});
});
