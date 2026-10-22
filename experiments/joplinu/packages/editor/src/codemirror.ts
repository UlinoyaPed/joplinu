import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxTree, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { NoteDocument } from '../../document/src/index';

function decorate(view: EditorView) {
	const ranges: { from: number; to: number; decoration: Decoration }[] = [];
	const selection = view.state.selection;
	for (const visible of view.visibleRanges) {
		syntaxTree(view.state).iterate({ from: visible.from, to: visible.to, enter(node) {
			const { from, to, name } = node;
			const active = selection.ranges.some(range => range.from <= to && range.to >= from);
			const parent = node.node.parent;
			const activeParent = parent && selection.ranges.some(range => range.from <= parent.to && range.to >= parent.from);
			if (/^(HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|QuoteMark|LinkMark)$/.test(name) && !active && !activeParent && !view.composing) {
				ranges.push({ from, to, decoration: Decoration.replace({}) });
			}
			const className = /^ATXHeading/.test(name) ? `live-heading live-${name.at(-1)}` : ({ StrongEmphasis: 'live-strong', Emphasis: 'live-em', Strikethrough: 'live-strike', InlineCode: 'live-code', Link: 'live-link', Blockquote: 'live-quote' } as Record<string, string>)[name];
			if (className && from < to) ranges.push({ from, to, decoration: Decoration.mark({ class: className }) });
		} });
	}
	ranges.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
	return Decoration.set(ranges.map(range => range.decoration.range(range.from, range.to)), true);
}

const livePreview = ViewPlugin.fromClass(class {
	decorations: DecorationSet;
	constructor(view: EditorView) { this.decorations = decorate(view); }
	update(update: import('@codemirror/view').ViewUpdate) {
		if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length) this.decorations = decorate(update.view);
	}
}, { decorations: plugin => plugin.decorations });

export function createSourceEditor(parent: HTMLElement, note: NoteDocument, live: boolean, onPosition?: (offset: number) => void) {
	const mode = new Compartment();
	const owner = {};
	const selection = note.restoreSelection();
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: note.source,
			selection,
			extensions: [
				markdown({ extensions: [GFM] }),
				syntaxHighlighting(defaultHighlightStyle), bracketMatching(), indentOnInput(), highlightSelectionMatches(),
				yCollab(note.text, undefined, { undoManager: note.undo }),
				Prec.highest(keymap.of(yUndoManagerKeymap)), keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', spellcheck: 'false', autocapitalize: 'off' }),
				mode.of(live ? livePreview : []),
				EditorView.updateListener.of(update => {
					if (update.selectionSet || update.docChanged) note.rememberSelection(update.state.selection.main);
				}),
				EditorView.domEventHandlers({
					compositionstart() { note.beginComposition(owner); },
					compositionend() { queueMicrotask(() => note.endComposition(owner)); },
					scroll(_event, editor) {
						const block = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);
						onPosition?.(block.from);
					},
				}),
			],
		}),
	});
	return {
		view,
		setLive(value: boolean) { view.dispatch({ effects: mode.reconfigure(value ? livePreview : []) }); },
		focusSource(offset: number) {
			const position = Math.max(0, Math.min(offset, view.state.doc.length));
			view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) });
			view.focus();
		},
		scrollToSource(offset: number) { view.dispatch({ effects: EditorView.scrollIntoView(Math.min(offset, view.state.doc.length), { y: 'start' }) }); },
		destroy() {
			note.rememberSelection(view.state.selection.main);
			view.destroy();
			note.endComposition(owner);
		},
	};
}
