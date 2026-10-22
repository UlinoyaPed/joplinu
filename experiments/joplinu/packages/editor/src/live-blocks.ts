import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { NoteDocument } from '../../document/src/index';
import { MarkdownRenderer } from '../../markdown/src/index';
import { enhancePreview, type MarkdownFeatures } from '../../markdown/src/enhance';

export interface LiveResources {
	features: MarkdownFeatures;
	assets: Map<string, { url: string; mime: string }>;
	openNote?(id: string): void;
	openAttachment?(id: string): void;
}
export const refreshLiveBlocks = StateEffect.define<void>();
const renderer = new MarkdownRenderer();

class BlockPreview extends WidgetType {
	private cleanup = new WeakMap<HTMLElement, () => void>();
	constructor(readonly raw: string, readonly from: number, readonly to: number, readonly version: number, readonly resources: LiveResources) { super(); }
	eq(other: BlockPreview) { return this.raw === other.raw && this.from === other.from && this.to === other.to && this.version === other.version; }
	get estimatedHeight() { return Math.min(350, Math.max(60, this.raw.split('\n').length * 23)); }
	toDOM(view: EditorView) {
		const dom = document.createElement('div'); dom.className = 'markdown live-block-preview'; dom.contentEditable = 'false'; dom.tabIndex = 0; dom.setAttribute('aria-label', 'Markdown 块预览，双击编辑源码');
		const original = document.createElement('pre'); original.textContent = this.raw; dom.append(original);
		dom.addEventListener('dblclick', event => { event.preventDefault(); view.dispatch({ selection: { anchor: Math.min(this.from + 1, view.state.doc.length) } }); view.focus(); });
		dom.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); view.dispatch({ selection: { anchor: this.from } }); view.focus(); } });
		dom.addEventListener('click', event => {
			const element = event.target instanceof Element ? event.target : null;
			const note = element?.closest<HTMLElement>('[data-note]'); const attachment = element?.closest<HTMLElement>('[data-attachment]');
			if (note) { event.preventDefault(); this.resources.openNote?.(note.dataset.note!); }
			else if (attachment?.tagName === 'A') { event.preventDefault(); this.resources.openAttachment?.(attachment.dataset.attachment!); }
			else if (element?.closest('a')) event.preventDefault();
		});
		void renderer.render(this.raw, { math: this.resources.features.math }).then(html => {
			if (!dom.isConnected) return;
			dom.innerHTML = html;
			this.cleanup.set(dom, enhancePreview(dom, this.resources.features, this.resources.assets));
			view.requestMeasure();
		}).catch(() => { /* Preserve the original text if rendering fails. */ });
		return dom;
	}
	ignoreEvent() { return true; }
	destroy(dom: HTMLElement) { this.cleanup.get(dom)?.(); }
}

/** Layout-changing replacements must come from a StateField, never a viewport ViewPlugin. */
export function liveBlockField(note: NoteDocument, getResources: () => LiveResources, getVersion: () => number) {
	const build = (state: EditorState) => {
		if (note.isComposing) return Decoration.none;
		const ranges: { from: number; to: number; raw: string }[] = [];
		// Lezer maintains this syntax tree incrementally; unified only renders individual block slices.
		syntaxTree(state).iterate({ enter(node) {
			const block = ['FencedCode', 'Table', 'Paragraph'].includes(node.name);
			if (!block) return;
			const raw = state.doc.sliceString(node.from, node.to);
			if (node.name === 'Paragraph' && !(/^\$\$\s*\n[\s\S]*\n\$\$\s*$/.test(raw) && getResources().features.math || /^!\[[^\n]*\]\(attachment:[a-zA-Z0-9-]+\)\s*$/.test(raw))) return;
			if (state.selection.ranges.some(range => range.from <= node.to && range.to >= node.from) || raw.length > 50000) return false;
			// A block widget must occupy complete lines. Nested list/table nodes stay as editable source.
			if (state.doc.lineAt(node.from).from !== node.from || state.doc.lineAt(node.to).to !== node.to) return false;
			ranges.push({ from: node.from, to: node.to, raw }); return false;
		} });
		return Decoration.set(ranges.map(range => Decoration.replace({ block: true, widget: new BlockPreview(range.raw, range.from, range.to, getVersion(), getResources()) }).range(range.from, range.to)), true);
	};
	return StateField.define<DecorationSet>({
		create: build,
		update(value, transaction) {
			return transaction.docChanged || transaction.selection || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) || transaction.effects.some(effect => effect.is(refreshLiveBlocks)) ? build(transaction.state) : value;
		},
		provide: field => EditorView.decorations.from(field),
	});
}
