import { EditorState, Selection, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { tableEditing, goToNextCell } from 'prosemirror-tables';
import type { NoteDocument } from '../../document/src/index';
import { projectMarkdown, planRichEdits, richSchema, sourceToRich, richToSource, richSerializer } from './rich-model';

export function createRichEditor(parent: HTMLElement, note: NoteDocument, onError: (message: string, draft: string) => void, onSourceFallback: (offset: number) => void) {
	let projection = projectMarkdown(note.source);
	let local = false;
	const owner = {};
	const selectionFromSource = (doc: typeof projection.doc, position: number) => Selection.near(doc.resolve(Math.min(doc.content.size, Math.max(0, position))));
	const saveSelection = () => note.rememberSelection({
		anchor: richToSource(projection, view.state.selection.anchor),
		head: richToSource(projection, view.state.selection.head),
	});
	const view = new EditorView(parent, {
		attributes: { 'aria-label': '富文本编辑器', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
		state: EditorState.create({
			doc: projection.doc,
			selection: selectionFromSource(projection.doc, sourceToRich(projection, note.restoreSelection().head)),
			plugins: [
				keymap({
					'Mod-z': () => { note.undo.undo(); return true; },
					'Mod-y': () => { note.undo.redo(); return true; },
					'Mod-Shift-z': () => { note.undo.redo(); return true; },
					'Mod-b': toggleMark(richSchema.marks.strong!),
					'Mod-i': toggleMark(richSchema.marks.em!),
					Enter: splitListItem(richSchema.nodes.list_item!),
					Tab: (state, dispatch, editor) => goToNextCell(1)(state, dispatch, editor) || sinkListItem(richSchema.nodes.list_item!)(state, dispatch, editor),
					'Shift-Tab': (state, dispatch, editor) => goToNextCell(-1)(state, dispatch, editor) || liftListItem(richSchema.nodes.list_item!)(state, dispatch, editor),
				}),
				keymap(baseKeymap), tableEditing(),
			],
		}),
		dispatchTransaction(transaction) {
			const next = view.state.apply(transaction);
			if (transaction.docChanged) {
				try {
					const edits = planRichEdits(projection, next.doc);
					if (edits.length) {
						let candidate = projection.source;
						for (const edit of [...edits].reverse()) candidate = candidate.slice(0, edit.from) + edit.insert + candidate.slice(edit.to);
						const projected = projectMarkdown(candidate);
						if (!projected.doc.eq(next.doc)) throw new Error('此修改无法无损转换为 Markdown。已保留原文，并提供待恢复草稿；请使用源码编辑。');
						local = true;
						try { note.edit(edits, projection.source); } finally { local = false; }
						projection = projected;
					}
				} catch (error) {
					onError(error instanceof Error ? error.message : '富文本转换失败', richSerializer.serialize(next.doc));
					return;
				}
			}
			view.updateState(next);
			saveSelection();
		},
		handleDOMEvents: {
			compositionstart() { note.beginComposition(owner); return false; },
			compositionend() { setTimeout(() => note.endComposition(owner), 0); return false; },
			beforeinput(_view, event) {
				const input = event as InputEvent;
				if (input.inputType !== 'historyUndo' && input.inputType !== 'historyRedo') return false;
				input.preventDefault();
				if (input.inputType === 'historyUndo') note.undo.undo(); else note.undo.redo();
				return true;
			},
			dblclick(_view, event) {
				const element = (event.target as HTMLElement).closest('[data-source-fallback], [data-math]');
				if (!element) return false;
				const position = view.posAtDOM(element, 0);
				onSourceFallback(richToSource(projection, position));
				return true;
			},
		},
	});
	const unsubscribe = note.onChange(() => {
		if (local) return;
		const next = projectMarkdown(note.source);
		const sourceSelection = note.restoreSelection();
		const transaction = view.state.tr;
		const start = view.state.doc.content.findDiffStart(next.doc.content);
		if (start !== null) {
			const end = view.state.doc.content.findDiffEnd(next.doc.content)!;
			const overlap = start - Math.min(end.a, end.b);
			transaction.replace(start, end.a + Math.max(0, overlap), next.doc.slice(start, end.b + Math.max(0, overlap)));
		}
		const anchor = sourceToRich(next, sourceSelection.anchor);
		const head = sourceToRich(next, sourceSelection.head);
		const anchorSelection = selectionFromSource(next.doc, anchor);
		const headSelection = selectionFromSource(next.doc, head);
		transaction.setSelection(anchorSelection instanceof TextSelection && headSelection instanceof TextSelection ? TextSelection.create(transaction.doc, anchorSelection.head, headSelection.head) : headSelection);
		projection = next;
		view.updateState(view.state.apply(transaction));
	});
	return {
		view,
		command(command: Command) { command(view.state, view.dispatch, view); view.focus(); },
		bold: toggleMark(richSchema.marks.strong!),
		italic: toggleMark(richSchema.marks.em!),
		heading: setBlockType(richSchema.nodes.heading!, { level: 2 }),
		paragraph: setBlockType(richSchema.nodes.paragraph!),
		list: wrapInList(richSchema.nodes.bullet_list!),
		quote: wrapIn(richSchema.nodes.blockquote!),
		destroy() { saveSelection(); unsubscribe(); view.destroy(); note.endComposition(owner); },
	};
}
