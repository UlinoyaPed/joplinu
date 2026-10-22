import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NoteDocument, minimalEdit } from '../packages/document/src/index';

function pair(source = '# 共同笔记\n\nabc') {
	const a = new NoteDocument(source);
	const b = new NoteDocument();
	b.applyRemote(Y.encodeStateAsUpdate(a.doc));
	return { a, b };
}

describe('authoritative Markdown Y.Text', () => {
	it('merges adjacent offline insertions and duplicate / out-of-order updates', () => {
		const { a, b } = pair();
		const updates: Uint8Array[] = [];
		a.doc.on('update', (update: Uint8Array) => updates.push(update));
		a.edit([{ from: a.source.length - 1, to: a.source.length - 1, insert: '甲' }]);
		a.edit([{ from: a.source.length, to: a.source.length, insert: '尾' }]);
		b.edit([{ from: b.source.length - 1, to: b.source.length - 1, insert: '乙' }]);
		const updateB = Y.encodeStateAsUpdate(b.doc);
		for (const update of [...updates].reverse()) { b.applyRemote(update); b.applyRemote(update); }
		a.applyRemote(updateB);
		expect(a.source).toBe(b.source);
		expect(a.source).toContain('甲');
		expect(a.source).toContain('乙');
		expect(a.source.endsWith('尾')).toBe(true);
	});

	it('undoes only local edits after merging a remote update', () => {
		const { a, b } = pair('abc');
		a.edit([{ from: 1, to: 1, insert: '甲' }]);
		b.edit([{ from: 2, to: 2, insert: '乙' }]);
		a.applyRemote(Y.encodeStateAsUpdate(b.doc));
		a.undo.undo();
		expect(a.source).toBe('ab乙c');
		a.undo.redo();
		expect(a.source).toContain('甲');
	});

	it('defers incoming updates until composition ends and keeps relative selection', () => {
		const { a, b } = pair('中文');
		const owner = {};
		a.beginComposition(owner);
		a.rememberSelection({ anchor: 1, head: 1 });
		b.edit([{ from: 0, to: 0, insert: '远程' }]);
		a.applyRemote(Y.encodeStateAsUpdate(b.doc));
		expect(a.pendingRemoteCount).toBe(1);
		expect(a.source).toBe('中文');
		a.edit([{ from: 1, to: 1, insert: '输入' }]);
		a.endComposition(owner);
		expect(a.source).toBe('远程中输入文');
		expect(a.restoreSelection().head).toBe(5);
	});

	it('rejects stale, overlapping or invalid edits atomically', () => {
		const a = new NoteDocument('abc');
		expect(() => a.edit([{ from: 0, to: 1, insert: 'x' }], 'old')).toThrow('过期');
		expect(() => a.edit([{ from: 0, to: 2, insert: 'x' }, { from: 1, to: 3, insert: 'y' }])).toThrow(RangeError);
		expect(a.source).toBe('abc');
	});

	it.each([['a😀b', 'a😃b'], ['a😀b', 'ab'], ['中文', '中式文'], ['abc', 'abc']])('makes a minimal UTF-16 patch for %s → %s', (before, after) => {
		const edit = minimalEdit(before, after);
		const note = new NoteDocument(before);
		if (edit) note.edit([edit]);
		expect(note.source).toBe(after);
		expect(note.source).not.toContain('�');
	});
});
