import { ChangeSet, EditorSelection } from '@codemirror/state';
import type { SourceSelection, TextEdit } from '../../document/src/index';

export type MarkdownCommand = 'bold' | 'italic' | 'strike' | 'inlineCode' | 'heading' | 'list' | 'quote' | 'task' | 'code' | 'table' | 'link';
export interface MarkdownTransaction { edits: TextEdit[]; selection: SourceSelection }
const longestBackticks = (value: string, initial = 0) => { let length = initial; for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length); return length; };

/** Local edits only; formatting does not serialize the rest of the document. */
export function markdownCommand(source: string, selection: SourceSelection, command: MarkdownCommand): MarkdownTransaction {
	const { anchor, head } = selection;
	if (![anchor, head].every(position => Number.isInteger(position) && position >= 0 && position <= source.length)) throw new RangeError('Invalid Markdown selection');
	const from = Math.min(anchor, head); const to = Math.max(anchor, head);
	const chosen = source.slice(from, to);
	const mapped = (edits: TextEdit[]): MarkdownTransaction => {
		const changes = ChangeSet.of(edits, source.length);
		const result = EditorSelection.single(anchor, head).map(changes).main;
		return { edits, selection: { anchor: result.anchor, head: result.head } };
	};
	const wrap = (mark: string) => {
		if (from >= mark.length && source.slice(from - mark.length, from) === mark && source.slice(to, to + mark.length) === mark) {
			return { edits: [{ from: from - mark.length, to: from, insert: '' }, { from: to, to: to + mark.length, insert: '' }], selection: { anchor: from - mark.length, head: to - mark.length } };
		}
		if (chosen.length >= mark.length * 2 && chosen.startsWith(mark) && chosen.endsWith(mark)) return { edits: [{ from, to: from + mark.length, insert: '' }, { from: to - mark.length, to, insert: '' }], selection: { anchor: from, head: to - mark.length * 2 } };
		return { edits: [{ from, to: from, insert: mark }, { from: to, to, insert: mark }], selection: { anchor: from + mark.length, head: to + mark.length } };
	};
	if (command === 'bold') return wrap('**');
	if (command === 'italic') return wrap('*');
	if (command === 'strike') return wrap('~~');
	if (command === 'inlineCode') {
		// A delimiter longer than any selected run cannot close inside the selection.
		const longest = longestBackticks(chosen);
		if (!longest) return wrap('`');
		const mark = '`'.repeat(longest + 1); const padding = /^`|`$/.test(chosen) ? ' ' : '';
		return { edits: [{ from, to: from, insert: mark + padding }, { from: to, to, insert: padding + mark }], selection: { anchor: from + mark.length + padding.length, head: to + mark.length + padding.length } };
	}
	if (command === 'link') {
		const label = chosen || '链接文字'; const insert = `[${label.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ')}](https://)`;
		const url = from + insert.lastIndexOf('https://');
		return { edits: [{ from, to, insert }], selection: { anchor: url, head: url + 8 } };
	}
	const lineStart = from === 0 ? 0 : source.lastIndexOf('\n', from - 1) + 1;
	const last = to > from && source[to - 1] === '\n' ? to - 1 : to;
	let lineEnd = source.indexOf('\n', last);
	if (lineEnd < 0) lineEnd = source.length;
	if (lineEnd > lineStart && source[lineEnd - 1] === '\r') lineEnd--;
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	if (command === 'code' || command === 'table') {
		const body = source.slice(lineStart, lineEnd);
		if (command === 'code') {
			const longest = longestBackticks(body, 2); const fence = '`'.repeat(longest + 1);
			const edits = [{ from: lineStart, to: lineStart, insert: fence + eol }, { from: lineEnd, to: lineEnd, insert: eol + fence }];
			return { edits, selection: { anchor: from + fence.length + eol.length, head: Math.min(to, lineEnd) + fence.length + eol.length } };
		}
		const position = to; const before = source.slice(0, position); const after = source.slice(position);
		const insert = `${before && !before.endsWith(eol + eol) ? eol + eol : ''}| 标题一 | 标题二 |${eol}| --- | --- |${eol}| 内容 | 内容 |${after.startsWith(eol + eol) ? '' : eol + eol}`;
		return mapped([{ from: position, to: position, insert }]);
	}
	const prefix = { heading: '# ', list: '- ', quote: '> ', task: '- [ ] ' }[command];
	const pattern = { heading: /^#{1,6}[ \t]+/, list: /^(?:[-+*]|\d+[.)])[ \t]+/, quote: /^>[ \t]?/, task: /^[-+*][ \t]+\[[ xX]\][ \t]+/ }[command];
	const lines: { start: number; marker: string }[] = [];
	for (let position = lineStart; position <= lineEnd;) {
		const next = source.indexOf('\n', position); const end = next < 0 || next > lineEnd ? lineEnd : next;
		const text = source.slice(position, end); const indent = /^[ \t]*/.exec(text)![0].length;
		lines.push({ start: position + indent, marker: pattern.exec(text.slice(indent))?.[0] ?? '' });
		if (next < 0 || next >= lineEnd) break; position = next + 1;
	}
	const remove = lines.every(line => !!line.marker);
	return mapped(lines.map(line => ({ from: line.start, to: line.start + line.marker.length, insert: remove ? '' : prefix })));
}
