import { EditorState, Selection, TextSelection, type Command } from 'prosemirror-state';
import { EditorView, type NodeViewConstructor } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { tableEditing, goToNextCell, addRowAfter, addColumnAfter, deleteRow, deleteColumn } from 'prosemirror-tables';
import katex from 'katex';
import { visit } from 'unist-util-visit';
import { parseMarkdown } from '../../markdown/src/index';
import type { NoteDocument } from '../../document/src/index';
import { projectMarkdown, planRichEdits, richSchema, sourceToRich, richToSource, richSerializer } from './rich-model';

function commandWithDomSelection(view: EditorView, command: Command) {
	const selection = view.dom.ownerDocument.getSelection();
	if (selection?.anchorNode && selection.focusNode && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) {
		const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
		const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
		const next = TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head));
		// Native selectionchange can arrive after a toolbar or keyboard command.
		if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next));
	}
	return command(view.state, view.dispatch, view);
}

const selectBoundary = (end: boolean): Command => (state, dispatch) => {
	dispatch?.(state.tr.setSelection(end ? Selection.atEnd(state.doc) : Selection.atStart(state.doc)).scrollIntoView());
	return true;
};

export interface MathEdit { value: string; from: number; to: number; display: boolean; baseline: string }
export interface RichResources {
	math?: boolean;
	attachment?(id: string): { url: string; mime: string } | undefined;
	openNote?(id: string): void;
	openAttachment?(id: string): void;
	editMath?(edit: MathEdit): void;
}
export function createRichEditor(parent: HTMLElement, note: NoteDocument, onError: (message: string, draft: string) => void, onSourceFallback: (offset: number) => void, initialResources: RichResources = {}) {
	let resources = initialResources;
	let projection = projectMarkdown(note.source);
	let local = false;
	const owner = {};
	const selectionFromSource = (doc: typeof projection.doc, position: number) => Selection.near(doc.resolve(Math.min(doc.content.size, Math.max(0, position))));
	const saveSelection = () => note.rememberSelection({
		anchor: richToSource(projection, view.state.selection.anchor),
		head: richToSource(projection, view.state.selection.head),
	});
	const nodeViews = (): Record<string, NodeViewConstructor> => {
		const mathView: NodeViewConstructor = (node, _editor, getPos) => {
			const display = node.type.name === 'math_block';
			const dom = document.createElement(display ? 'div' : 'span'); dom.className = 'math-source'; dom.dataset.math = display ? 'block' : 'inline'; dom.contentEditable = 'false';
			try { if (resources.math !== false) dom.innerHTML = katex.renderToString(String(node.attrs.value), { displayMode: display, trust: false, throwOnError: true, maxExpand: 100, maxSize: 20 }); else dom.textContent = String(node.attrs.value); }
			catch { dom.textContent = String(node.attrs.value); dom.title = '公式有误，双击编辑'; }
			dom.addEventListener('dblclick', event => {
				if (!resources.editMath || note.isComposing) return;
				event.preventDefault(); event.stopPropagation();
				const pos = getPos(); if (pos === undefined) return;
				const sourceOffset = richToSource(projection, pos);
				visit(parseMarkdown(note.source), candidate => {
					if ((candidate.type !== 'math' && candidate.type !== 'inlineMath') || !candidate.position) return;
					const from = candidate.position.start.offset!; const to = candidate.position.end.offset!;
					if (sourceOffset >= from && sourceOffset <= to) resources.editMath!({ value: candidate.value, from, to, display: candidate.type === 'math', baseline: note.source });
				});
			});
			return { dom, ignoreMutation: () => true };
		};
		return {
			math_block: mathView, inline_math: mathView,
			image(node) {
				const dom = document.createElement('span'); dom.className = 'rich-image'; dom.contentEditable = 'false';
				const id = /^attachment:([a-zA-Z0-9-]+)$/.exec(String(node.attrs.src))?.[1]; const asset = id ? resources.attachment?.(id) : undefined;
				if (asset && /^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mime)) { const image = document.createElement('img'); image.src = asset.url; image.alt = String(node.attrs.alt ?? '图片'); dom.append(image); }
				else { dom.className = 'image-placeholder'; dom.textContent = `▧ ${String(node.attrs.alt || '图片 / 附件')}`; }
				if (id) dom.addEventListener('dblclick', event => { event.preventDefault(); resources.openAttachment?.(id); });
				return { dom, ignoreMutation: () => true };
			},
			list_item(node, editor, getPos) {
				const dom = document.createElement('li'); const contentDOM = document.createElement('div');
				if (node.attrs.checked !== null) {
					dom.dataset.checked = String(node.attrs.checked); dom.className = 'rich-task';
					const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(node.attrs.checked); checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label', '切换任务完成状态');
					checkbox.addEventListener('change', () => { const pos = getPos(); if (pos !== undefined && !note.isComposing) editor.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: checkbox.checked })); });
					dom.append(checkbox);
				}
				dom.append(contentDOM); return { dom, contentDOM };
			},
		};
	};
	const view = new EditorView(parent, {
		nodeViews: nodeViews(),
		attributes: { 'aria-label': '富文本编辑器', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
		state: EditorState.create({
			doc: projection.doc,
			selection: selectionFromSource(projection.doc, sourceToRich(projection, note.restoreSelection().head)),
			plugins: [
				keymap({
					'Mod-z': () => { note.undo.undo(); return true; },
					'Mod-y': () => { note.undo.redo(); return true; },
					'Mod-Shift-z': () => { note.undo.redo(); return true; },
					'Mod-b': (_state, _dispatch, editor) => !!editor && commandWithDomSelection(editor, toggleMark(richSchema.marks.strong!)),
					'Mod-i': (_state, _dispatch, editor) => !!editor && commandWithDomSelection(editor, toggleMark(richSchema.marks.em!)),
					'Mod-Home': (_state, _dispatch, editor) => !!editor && commandWithDomSelection(editor, selectBoundary(false)),
					'Mod-End': (_state, _dispatch, editor) => !!editor && commandWithDomSelection(editor, selectBoundary(true)),
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
			click(_view, event) {
				const target = event.target as HTMLElement;
				const noteLink = target.closest<HTMLElement>('[data-note]'); const attachment = target.closest<HTMLElement>('a[data-attachment]');
				if (noteLink) { event.preventDefault(); resources.openNote?.(noteLink.dataset.note!); return true; }
				if (attachment) { event.preventDefault(); resources.openAttachment?.(attachment.dataset.attachment!); return true; }
				return false;
			},
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
		setResources(next: RichResources) { resources = next; view.setProps({ nodeViews: nodeViews() }); },
		command(command: Command) { commandWithDomSelection(view, command); view.focus(); },
		bold: toggleMark(richSchema.marks.strong!),
		italic: toggleMark(richSchema.marks.em!),
		strike: toggleMark(richSchema.marks.strike!),
		heading: setBlockType(richSchema.nodes.heading!, { level: 2 }),
		paragraph: setBlockType(richSchema.nodes.paragraph!),
		list: wrapInList(richSchema.nodes.bullet_list!, { tight: true }),
		quote: wrapIn(richSchema.nodes.blockquote!),
		code: setBlockType(richSchema.nodes.code_block!, { params: '' }),
		task: ((state, dispatch) => {
			const paragraph = richSchema.nodes.paragraph!.create(null, richSchema.text('任务'));
			const list = richSchema.nodes.bullet_list!.create({ tight: true }, richSchema.nodes.list_item!.create({ checked: false }, paragraph));
			dispatch?.(state.tr.replaceSelectionWith(list).scrollIntoView()); return true;
		}) as Command,
		table: ((state, dispatch) => {
			const cell = (header: boolean, text: string) => richSchema.nodes[header ? 'table_header' : 'table_cell']!.create(null, richSchema.nodes.paragraph!.create(null, richSchema.text(text)));
			const row = (header: boolean) => richSchema.nodes.table_row!.create(null, [cell(header, header ? '标题一' : '内容'), cell(header, header ? '标题二' : '内容')]);
			dispatch?.(state.tr.replaceSelectionWith(richSchema.nodes.table!.create(null, [row(true), row(false)])).scrollIntoView()); return true;
		}) as Command,
		addRow: addRowAfter, addColumn: addColumnAfter, deleteRow, deleteColumn,
		destroy() { saveSelection(); unsubscribe(); view.destroy(); note.endComposition(owner); },
	};
}
