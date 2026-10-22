import { expect, it } from 'vitest';
import { Selection, EditorState, TextSelection } from 'prosemirror-state';
import { addRowAfter } from 'prosemirror-tables';
import { projectMarkdown, planRichEdits, richSchema } from '../packages/editor/src/rich-model';

it('can replace a trailing virtual paragraph with a newly inserted GFM table', () => {
	const before = projectMarkdown('前言\n\n');
	const state = EditorState.create({ doc: before.doc, selection: Selection.atEnd(before.doc) });
	const cell = (header: boolean, text: string) => richSchema.nodes[header ? 'table_header' : 'table_cell']!.create(null, richSchema.nodes.paragraph!.create(null, richSchema.text(text)));
	const row = (header: boolean) => richSchema.nodes.table_row!.create(null, [cell(header, header ? '标题一' : '内容'), cell(header, header ? '标题二' : '内容')]);
	const next = state.tr.replaceSelectionWith(richSchema.nodes.table!.create(null, [row(true), row(false)])).doc;
	let source = before.source;
	for (const edit of planRichEdits(before, next).reverse()) source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
	expect(projectMarkdown(source).doc.toJSON(), source).toEqual(next.toJSON());
});

it('serializes a newly added empty table row without inventing paragraphs', () => {
	const before = projectMarkdown('前言\n\n| 标题一 | 标题二 |\n| --- | --- |\n| 内容 | 内容 |\n');
	let position = 0; before.doc.descendants((node, pos) => { if (node.type.name === 'table_cell') position = pos + 2; });
	const state = EditorState.create({ doc: before.doc, selection: TextSelection.create(before.doc, position) });
	let next = state.doc; expect(addRowAfter(state, transaction => { next = transaction.doc; })).toBe(true);
	let source = before.source;
	for (const edit of planRichEdits(before, next).reverse()) source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
	expect(projectMarkdown(source).doc.toJSON(), source).toEqual(next.toJSON());
});
