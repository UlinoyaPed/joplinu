import * as Y from 'yjs';

export interface TextEdit { from: number; to: number; insert: string }
export interface SourceSelection { anchor: number; head: number }

export function minimalEdit(before: string, after: string): TextEdit | null {
	if (before === after) return null;
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from++;
	// Yjs offsets are UTF-16; never split a surrogate pair at a patch boundary.
	if (from && /[\uDC00-\uDFFF]/.test(before[from] ?? after[from] ?? '')) from--;
	let to = before.length;
	let end = after.length;
	while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
	if (to < before.length && /[\uDC00-\uDFFF]/.test(before[to] ?? '')) { to++; end++; }
	return { from, to, insert: after.slice(from, end) };
}

export class NoteDocument {
	readonly doc: Y.Doc;
	readonly text: Y.Text;
	readonly localOrigin = {};
	readonly undo: Y.UndoManager;
	private composing = new Set<object>();
	private pending: Uint8Array[] = [];
	private selection: { anchor: Y.RelativePosition; head: Y.RelativePosition } | undefined;

	constructor(initial = '', doc = new Y.Doc()) {
		this.doc = doc;
		this.text = doc.getText('markdown');
		if (initial && this.text.length === 0) this.text.insert(0, initial);
		this.undo = new Y.UndoManager(this.text, { trackedOrigins: new Set([this.localOrigin]), captureTimeout: 400 });
	}

	get source() { return this.text.toString(); }
	get pendingRemoteCount() { return this.pending.length; }
	get isComposing() { return this.composing.size > 0; }

	edit(edits: readonly TextEdit[], expectedSource?: string) {
		if (expectedSource !== undefined && this.source !== expectedSource) throw new Error('文档已更新；拒绝提交过期编辑。请保留草稿并重新打开。');
		const ordered = [...edits].sort((a, b) => a.from - b.from);
		let end = 0;
		for (const edit of ordered) {
			if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < end || edit.from < 0 || edit.to < edit.from || edit.to > this.text.length) throw new RangeError('Invalid text edit');
			end = edit.to;
		}
		this.doc.transact(() => {
			for (const edit of ordered.reverse()) {
				this.text.delete(edit.from, edit.to - edit.from);
				this.text.insert(edit.from, edit.insert);
			}
		}, this.localOrigin);
	}

	rememberSelection(selection: SourceSelection) {
		const clamp = (n: number) => Math.max(0, Math.min(n, this.text.length));
		this.selection = {
			anchor: Y.createRelativePositionFromTypeIndex(this.text, clamp(selection.anchor)),
			head: Y.createRelativePositionFromTypeIndex(this.text, clamp(selection.head)),
		};
	}

	restoreSelection(): SourceSelection {
		const resolve = (position: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(position, this.doc)?.index ?? 0;
		return this.selection ? { anchor: resolve(this.selection.anchor), head: resolve(this.selection.head) } : { anchor: 0, head: 0 };
	}

	beginComposition(owner: object) { this.composing.add(owner); }
	endComposition(owner: object) {
		this.composing.delete(owner);
		if (this.isComposing) return;
		for (const update of this.pending.splice(0)) Y.applyUpdate(this.doc, update, 'remote');
	}

	applyRemote(update: Uint8Array) {
		if (this.isComposing) this.pending.push(update.slice());
		else Y.applyUpdate(this.doc, update, 'remote');
	}

	onChange(listener: () => void) {
		this.text.observe(listener);
		return () => this.text.unobserve(listener);
	}

	destroy() { this.undo.destroy(); this.doc.destroy(); }
}
