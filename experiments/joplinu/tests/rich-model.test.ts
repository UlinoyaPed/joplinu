import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import * as Y from 'yjs';
import { NoteDocument } from '../packages/document/src/index';
import { projectMarkdown, planRichEdits, richSchema, richToSource, sourceToRich } from '../packages/editor/src/rich-model';

const fixture = '# 标题  \n\n正文 **粗体** 和 *斜体* ~~删除~~ [链接](https://example.org)\n\n| a | b |\n|:---|---:|\n| 一 | 二 |\n\n$$\nx^2\n$$\n\n~~~ts\nconst a = 1;\n~~~\n\n![附件](attachment:abc)\n\n:::unknown\n保留\n:::\n\n[ref]: https://example.org\n';

function applyRich(note: NoteDocument, change: (state: EditorState) => EditorState) {
	const projection = projectMarkdown(note.source);
	const next = change(EditorState.create({ doc: projection.doc }));
	const edits = planRichEdits(projection, next.doc);
	if (edits.length) note.edit(edits, projection.source);
	return { next, edits };
}

describe('source-preserving ProseMirror projection', () => {
	it('projects headings, marks, GFM tables, tasks, math, code, attachments and opaque extensions', () => {
		const projection = projectMarkdown(fixture);
		expect(projection.doc.child(0).type.name).toBe('heading');
		expect(projection.blocks.map(block => block.pm.type.name)).toEqual(['heading', 'paragraph', 'table', 'math_block', 'code_block', 'paragraph', 'opaque', 'opaque']);
		expect(projection.doc.textContent).toContain('粗体');
		expect(projectMarkdown('- [x] 完成\n- [ ] 待办').doc.firstChild?.firstChild?.attrs.checked).toBe(true);
	});

	it('opening and switching modes generates no Markdown patch', () => {
		const projection = projectMarkdown(fixture);
		expect(planRichEdits(projection, projection.doc)).toEqual([]);
		expect(projection.source).toBe(fixture);
	});

	it('changes only the edited text and retains every other byte', () => {
		const note = new NoteDocument(fixture);
		const result = applyRich(note, state => state.apply(state.tr.insertText('新', 2)));
		expect(result.edits).toEqual([{ from: 3, to: 3, insert: '新' }]);
		expect(note.source).toBe(fixture.slice(0, 3) + '新' + fixture.slice(3));
		expect(projectMarkdown(note.source).doc.eq(result.next.doc)).toBe(true);
	});

	it('formats one paragraph without reserializing the table, code fence or references', () => {
		const note = new NoteDocument(fixture);
		applyRich(note, state => {
			const start = sourceToRich(projectMarkdown(note.source), fixture.indexOf('正文'));
			state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start, start + 2)));
			toggleMark(richSchema.marks.strong!)(state, transaction => { state = state.apply(transaction); });
			return state;
		});
		expect(note.source).toContain('**正文**');
		expect(note.source.slice(note.source.indexOf('| a |'))).toBe(fixture.slice(fixture.indexOf('| a |')));
	});

	it.each(['[ref][id]\n\n[id]: https://example.org', ':::custom\nvalue\n:::', '<script>alert(1)</script>', '[[笔记#标题]]', '{{ extension }}'])('preserves unknown or reference syntax: %s', source => {
		const projection = projectMarkdown(source);
		expect(projection.blocks[0]?.pm.type.name).toBe('opaque');
		expect(planRichEdits(projection, projection.doc)).toEqual([]);
	});

	it('edits table cells without changing math, fenced code or attachments', () => {
		const note = new NoteDocument(fixture);
		const projection = projectMarkdown(fixture);
		const position = sourceToRich(projection, fixture.indexOf('一'));
		const result = applyRich(note, state => state.apply(state.tr.insertText('新', position)));
		expect(note.source).toContain('新一');
		expect(note.source.slice(note.source.indexOf('$$'))).toBe(fixture.slice(fixture.indexOf('$$')));
		expect(projectMarkdown(note.source).doc.eq(result.next.doc)).toBe(true);
	});

	it('maps plain-text selection between source and rich positions', () => {
		const projection = projectMarkdown('# 中文标题\n\n原文 **加粗** 和代码 `const x`');
		for (const text of ['中文标题', '原文', '加粗', 'const x']) {
			const sourceOffset = projection.source.indexOf(text) + 1;
			expect(richToSource(projection, sourceToRich(projection, sourceOffset))).toBe(sourceOffset);
		}
	});

	it('merges adjacent rich and source edits from independently initialized replicas', () => {
		const a = new NoteDocument('相邻文字');
		const b = new NoteDocument();
		b.applyRemote(Y.encodeStateAsUpdate(a.doc));
		applyRich(a, state => state.apply(state.tr.insertText('甲', 3)));
		b.edit([{ from: 2, to: 2, insert: '乙' }]);
		const aUpdate = Y.encodeStateAsUpdate(a.doc);
		const bUpdate = Y.encodeStateAsUpdate(b.doc);
		a.applyRemote(bUpdate); b.applyRemote(aUpdate);
		expect(a.source).toBe(b.source);
		expect(a.source).toContain('甲'); expect(a.source).toContain('乙');
	});

	it('keeps concurrent text between two edits in the same rich transaction', () => {
		const a = new NoteDocument('alpha middle omega');
		const b = new NoteDocument();
		b.applyRemote(Y.encodeStateAsUpdate(a.doc));
		const result = applyRich(a, state => state.apply(state.tr.insertText('A', 1).insertText('Z', state.doc.content.size)));
		expect(result.edits).toHaveLength(2);
		b.edit([{ from: 8, to: 8, insert: '并发' }]);
		const updateA = Y.encodeStateAsUpdate(a.doc);
		a.applyRemote(Y.encodeStateAsUpdate(b.doc)); b.applyRemote(updateA);
		expect(a.source).toBe(b.source);
		expect(a.source).toContain('并发');
		expect(a.source.replace('并发', '')).toBe('Aalpha middle omegaZ');
	});

	it('preserves a linked attachment when editing nearby text', () => {
		const note = new NoteDocument('前文 [![附件](attachment:abc)](https://example.org) 后文');
		const result = applyRich(note, state => state.apply(state.tr.insertText('新', 2)));
		expect(note.source).toBe('前新文 [![附件](attachment:abc)](https://example.org) 后文');
		expect(projectMarkdown(note.source).doc.eq(result.next.doc)).toBe(true);
	});

	it.each(['', '\n\n', '首段\n\n\n\n次段\n\n\n\n', '# 标题\r\n\r\n正文\r\n'])('round-trips blank lines and CRLF without any mode-switch patch: %j', source => {
		const projection = projectMarkdown(source);
		expect(planRichEdits(projection, projection.doc)).toEqual([]);
		expect(projection.source).toBe(source);
	});

	it('maps fenced code content separately from a matching language name', () => {
		const note = new NoteDocument('```a\na\n```');
		const result = applyRich(note, state => state.apply(state.tr.insertText('b', 1, 2)));
		expect(note.source).toBe('```a\nb\n```');
		expect(projectMarkdown(note.source).doc.eq(result.next.doc)).toBe(true);
	});
});
