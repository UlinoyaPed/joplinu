import { Schema, type Node as PMNode, type Mark } from 'prosemirror-model';
import { schema as commonmarkSchema, defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';
import type { Nodes } from 'mdast';
import { sourceBlocks, safeLink, type SourceBlock } from '../../markdown/src/index';
import { minimalEdit, type TextEdit } from '../../document/src/index';
import { diffChars } from 'diff';

let nodes = commonmarkSchema.spec.nodes.append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph+', cellAttributes: {} }));
nodes = nodes.update('list_item', {
	...nodes.get('list_item')!,
	attrs: { checked: { default: null } },
	toDOM: node => ['li', { 'data-checked': node.attrs.checked }, 0],
});
nodes = nodes.update('image', {
	...nodes.get('image')!,
	// Attachment bytes will be supplied by a validated platform resource broker.
	toDOM: node => ['span', { class: 'image-placeholder', title: node.attrs.src }, `▧ ${String(node.attrs.alt || '图片 / 附件')}`],
});
nodes = nodes.append({
	opaque: {
		group: 'block', atom: true, attrs: { raw: {} },
		toDOM: node => ['pre', { class: 'opaque', 'data-source-fallback': 'true', title: '此语法按原样保留。双击切换源码编辑。' }, String(node.attrs.raw)],
	},
	math_block: {
		group: 'block', atom: true, attrs: { value: {} },
		toDOM: node => ['div', { class: 'math-source', 'data-math': 'block' }, `$$ ${String(node.attrs.value)} $$`],
	},
	inline_math: {
		group: 'inline', inline: true, atom: true, attrs: { value: {} },
		toDOM: node => ['span', { class: 'math-source', 'data-math': 'inline' }, `$${String(node.attrs.value)}$`],
	},
});
let marks = commonmarkSchema.spec.marks.append({ strike: { toDOM: () => ['del', 0], parseDOM: [{ tag: 'del' }] } });
marks = marks.update('link', {
	...marks.get('link')!,
	toDOM: mark => {
		const internal = /^(note|attachment):([a-zA-Z0-9-]+)$/.exec(String(mark.attrs.href));
		return ['a', { href: safeLink(String(mark.attrs.href)) ? mark.attrs.href : undefined, ...(internal ? { [internal[1] === 'note' ? 'data-note' : 'data-attachment']: internal[2] } : {}), rel: 'noreferrer noopener' }, 0];
	},
});
export const richSchema = new Schema({ nodes, marks });

export const richSerializer = new MarkdownSerializer({
	...defaultMarkdownSerializer.nodes,
	opaque(state, node) { state.write(String(node.attrs.raw)); state.closeBlock(node); },
	math_block(state, node) { state.write(`$$\n${String(node.attrs.value)}\n$$`); state.closeBlock(node); },
	inline_math(state, node) { state.write(`$${String(node.attrs.value)}$`); },
	list_item(state, node) {
		if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ');
		state.renderContent(node);
	},
	table(state, node) {
		node.forEach((row, _offset, rowIndex) => {
			const cells: string[] = [];
			row.forEach(cell => cells.push(richSerializer.serialize(richSchema.nodes.doc!.create(null, cell.content)).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
			if (rowIndex) state.write('\n');
			state.write(`| ${cells.join(' | ')} |`);
			if (rowIndex === 0) state.write(`\n| ${cells.map(() => '---').join(' | ')} |`);
		});
		state.closeBlock(node);
	},
}, {
	...defaultMarkdownSerializer.marks,
	strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
});

interface Span { pmFrom: number; pmTo: number; sourceFrom: number; sourceTo: number }
interface Built { nodes: PMNode[]; spans: Span[] }
export interface RichBlock extends SourceBlock { pm: PMNode; pmFrom: number; virtual?: boolean }
export interface RichProjection { source: string; doc: PMNode; blocks: RichBlock[]; spans: Span[] }

const supported = new Set(['paragraph', 'heading', 'text', 'emphasis', 'strong', 'delete', 'link', 'image', 'inlineCode', 'code', 'blockquote', 'list', 'listItem', 'break', 'thematicBreak', 'table', 'tableRow', 'tableCell', 'math', 'inlineMath']);
function isSupported(node: Nodes): boolean {
	if (!supported.has(node.type)) return false;
	return !('children' in node) || node.children.every(child => isSupported(child));
}

function build(node: Nodes, source: string, activeMarks: readonly Mark[] = []): Built {
	const types = richSchema.nodes;
	const from = node.position?.start.offset ?? 0;
	const to = node.position?.end.offset ?? from;
	if (node.type === 'text' || node.type === 'inlineCode') {
		const textMarks = node.type === 'inlineCode' ? [...activeMarks, richSchema.marks.code!.create()] : activeMarks;
		const start = node.type === 'inlineCode' ? from + Math.max(0, source.slice(from, to).indexOf(node.value)) : from;
		return { nodes: [richSchema.text(node.value, textMarks)], spans: [{ pmFrom: 0, pmTo: node.value.length, sourceFrom: start, sourceTo: node.type === 'inlineCode' ? start + node.value.length : to }] };
	}
	const children = 'children' in node ? node.children : [];
	let childMarks = activeMarks;
	const markType = { strong: 'strong', emphasis: 'em', delete: 'strike', link: 'link' }[node.type as 'strong' | 'emphasis' | 'delete' | 'link'];
	if (markType) {
		const attrs = node.type === 'link' ? { href: node.url, title: node.title } : undefined;
		childMarks = [...activeMarks, richSchema.marks[markType]!.create(attrs)];
	}
	const built = children.map(child => build(child, source, childMarks));
	const content = built.flatMap(child => child.nodes);
	if (markType) {
		let inlineOffset = 0;
		return { nodes: content, spans: built.flatMap(child => {
			const next = child.spans.map(span => ({ ...span, pmFrom: span.pmFrom + inlineOffset, pmTo: span.pmTo + inlineOffset }));
			inlineOffset += child.nodes.reduce((sum, item) => sum + item.nodeSize, 0);
			return next;
		}) };
	}
	let result: PMNode;
	switch (node.type) {
	case 'paragraph': result = types.paragraph!.create(null, content); break;
	case 'heading': result = types.heading!.create({ level: node.depth }, content); break;
	case 'blockquote': result = types.blockquote!.create(null, content); break;
	case 'list': result = (node.ordered ? types.ordered_list! : types.bullet_list!).create(node.ordered ? { order: node.start ?? 1, tight: !node.spread } : { tight: !node.spread }, content); break;
	case 'listItem': result = types.list_item!.create({ checked: node.checked ?? null }, content); break;
	case 'code': result = types.code_block!.create({ params: [node.lang, node.meta].filter(Boolean).join(' ') }, node.value ? richSchema.text(node.value) : undefined); break;
	case 'break': result = types.hard_break!.create(null, null, activeMarks); break;
	case 'thematicBreak': result = types.horizontal_rule!.create(); break;
	case 'image': result = types.image!.create({ src: node.url, alt: node.alt, title: node.title }, null, activeMarks); break;
	case 'math': result = types.math_block!.create({ value: node.value }); break;
	case 'inlineMath': result = types.inline_math!.create({ value: node.value }, null, activeMarks); break;
	case 'table': result = types.table!.create(null, content.map((row, index) => index === 0 ? row.type.create(row.attrs, row.content.content.map(cell => types.table_header!.create(cell.attrs, cell.content))) : row)); break;
	case 'tableRow': result = types.table_row!.create(null, content); break;
	case 'tableCell': result = types.table_cell!.create(null, types.paragraph!.create(null, content)); break;
	default: throw new Error(`Unsupported node ${node.type}`);
	}
	let offset = node.type === 'tableCell' ? 2 : 1;
	const spans = built.flatMap(child => {
		const next = child.spans.map(span => ({ ...span, pmFrom: span.pmFrom + offset, pmTo: span.pmTo + offset }));
		offset += child.nodes.reduce((sum, item) => sum + item.nodeSize, 0);
		return next;
	});
	if (node.type === 'code' && node.value) {
		const raw = source.slice(from, to);
		const contentStart = /^ {0,3}(`{3,}|~{3,})/.test(raw) ? raw.indexOf('\n') + 1 : 0;
		const contentFrom = from + Math.max(0, raw.indexOf(node.value, contentStart));
		spans.push({ pmFrom: 1, pmTo: 1 + node.value.length, sourceFrom: contentFrom, sourceTo: contentFrom + node.value.length });
	}
	return { nodes: [result], spans };
}

export function projectMarkdown(source: string): RichProjection {
	const blocks: RichBlock[] = [];
	const spans: Span[] = [];
	let offset = 0;
	const addEmpty = (from: number, to = from) => {
		const pm = richSchema.nodes.paragraph!.create();
		blocks.push({ node: { type: 'paragraph', children: [] }, from, to, raw: '', pm, pmFrom: offset, virtual: true });
		offset += pm.nodeSize;
	};
	for (const block of sourceBlocks(source)) {
		const previousEnd = blocks.at(-1)?.to ?? 0;
		const gapLines = source.slice(previousEnd, block.from).match(/\n/g)?.length ?? 0;
		const emptyCount = Math.max(0, Math.floor(gapLines / 2) - (blocks.length ? 1 : 0));
		for (let index = 0; index < emptyCount; index++) addEmpty(previousEnd + 2 * (index + 1));
		let built: Built;
		if (!isSupported(block.node) || /\[\[|\]\]|(^|\n)\s*:::|\{\{/.test(block.raw)) {
			built = { nodes: [richSchema.nodes.opaque!.create({ raw: block.raw })], spans: [] };
		} else built = build(block.node, source);
		blocks.push({ ...block, pm: built.nodes[0]!, pmFrom: offset });
		spans.push(...built.spans.map(span => ({ ...span, pmFrom: span.pmFrom + offset, pmTo: span.pmTo + offset })));
		offset += built.nodes[0]!.nodeSize;
	}
	const lastEnd = blocks.at(-1)?.to ?? 0;
	const blankParagraphs = blocks.length ? Math.floor((source.slice(lastEnd).match(/\n/g)?.length ?? 0) / 2) : 1;
	for (let index = 0; index < blankParagraphs; index++) {
		if (!blocks.length) addEmpty(0, source.length);
		else addEmpty(Math.min(source.length, lastEnd + 2 * (index + 1)));
	}
	const doc = richSchema.nodes.doc!.create(null, blocks.map(block => block.pm));
	doc.check();
	return { source, doc, blocks, spans };
}

function rawTextEdits(before: RichProjection, after: PMNode) {
	const edits: TextEdit[] = [];
	function walk(old: PMNode, next: PMNode, position: number): boolean {
		if (!old.sameMarkup(next) || old.childCount !== next.childCount) return false;
		if (old.isText) {
			if (old.text === next.text) return true;
			const span = before.spans.find(item => item.pmFrom === position && item.pmTo === position + old.nodeSize);
			if (!span || before.source.slice(span.sourceFrom, span.sourceTo) !== old.text) return false;
			edits.push(...diffTextEdits(old.text!, next.text!, span.sourceFrom));
			return true;
		}
		let offset = old.type.name === 'doc' ? 0 : position + 1;
		for (let index = 0; index < old.childCount; index++) {
			if (!walk(old.child(index), next.child(index), offset)) return false;
			offset += old.child(index).nodeSize;
		}
		return true;
	}
	return walk(before.doc, after, 0) ? edits : null;
}

export function planRichEdits(before: RichProjection, after: PMNode): TextEdit[] {
	const raw = rawTextEdits(before, after);
	if (raw) return raw;
	const oldNodes = before.blocks.map(block => block.pm);
	if (!oldNodes.length && before.doc.eq(after)) return [];
	const newNodes: PMNode[] = [];
	after.forEach(node => newNodes.push(node));
	let prefix = 0;
	while (prefix < oldNodes.length && prefix < newNodes.length && oldNodes[prefix]!.eq(newNodes[prefix]!)) prefix++;
	let suffix = 0;
	while (suffix < oldNodes.length - prefix && suffix < newNodes.length - prefix && oldNodes[oldNodes.length - suffix - 1]!.eq(newNodes[newNodes.length - suffix - 1]!)) suffix++;
	if (prefix === oldNodes.length && prefix === newNodes.length) return [];
	const oldEnd = oldNodes.length - suffix;
	const changed = newNodes.slice(prefix, newNodes.length - suffix);
	let replacement = changed.map(node => richSerializer.serialize(richSchema.nodes.doc!.create(null, node))).join('\n\n');
	let from = before.blocks[prefix]?.from ?? before.source.length;
	let to = oldEnd > prefix ? before.blocks[oldEnd - 1]!.to : from;
	if (!changed.length && before.blocks.slice(prefix, oldEnd).every(block => block.virtual)) {
		if (oldEnd === before.blocks.length) {
			from = before.blocks[prefix - 1]?.to ?? 0;
			to = before.source.length;
		} else to = before.blocks[oldEnd]!.from;
	}
	if (oldEnd === prefix && changed.length) {
		if (prefix < oldNodes.length) replacement += '\n\n';
		else if (before.source) replacement = `\n\n${replacement}`;
	}
	return diffTextEdits(before.source.slice(from, to), replacement, from);
}

function diffTextEdits(before: string, after: string, base: number): TextEdit[] {
	const minimal = minimalEdit(before, after);
	if (!minimal) return [];
	const difference = diffChars(before.slice(minimal.from, minimal.to), minimal.insert, { timeout: 50 });
	if (!difference) throw new Error('此修改超出局部转换预算，请切换源码视图编辑。');
	const edits: TextEdit[] = [];
	let offset = base + minimal.from;
	for (const part of difference) {
		if (!part.added && !part.removed) { offset += part.value.length; continue; }
		const previous = edits.at(-1);
		if (previous && previous.to === offset) {
			if (part.removed) { previous.to += part.value.length; offset += part.value.length; }
			else previous.insert += part.value;
		} else if (part.removed) {
			edits.push({ from: offset, to: offset + part.value.length, insert: '' });
			offset += part.value.length;
		} else edits.push({ from: offset, to: offset, insert: part.value });
	}
	return edits;
}

export function sourceToRich(projection: RichProjection, sourceOffset: number) {
	const span = projection.spans.find(item => sourceOffset >= item.sourceFrom && sourceOffset <= item.sourceTo);
	if (span) return Math.min(span.pmTo, span.pmFrom + Math.max(0, sourceOffset - span.sourceFrom));
	const block = projection.blocks.find(item => sourceOffset >= item.from && sourceOffset <= item.to) ?? projection.blocks.at(-1);
	return block ? Math.min(projection.doc.content.size, block.pmFrom + (block.pm.isAtom ? 0 : 1)) : 0;
}

export function richToSource(projection: RichProjection, pmOffset: number) {
	const span = projection.spans.find(item => pmOffset >= item.pmFrom && pmOffset <= item.pmTo);
	if (span) return Math.min(span.sourceTo, span.sourceFrom + Math.max(0, pmOffset - span.pmFrom));
	return projection.blocks.find(block => pmOffset >= block.pmFrom && pmOffset <= block.pmFrom + block.pm.nodeSize)?.from ?? 0;
}
