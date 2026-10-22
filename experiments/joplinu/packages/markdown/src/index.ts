import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, RootContent } from 'mdast';
import type { Root as HtmlRoot } from 'hast';

export const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export function parseMarkdown(source: string): Root { return parser.parse(source); }

export interface SourceBlock { node: RootContent; from: number; to: number; raw: string }
export function sourceBlocks(source: string): SourceBlock[] {
	return parseMarkdown(source).children.map(node => {
		const from = node.position?.start.offset ?? 0;
		const to = node.position?.end.offset ?? from;
		return { node, from, to, raw: source.slice(from, to) };
	});
}

/** Rewrites recognized URL spans only; code, link labels, titles and unknown syntax remain byte-for-byte. */
export function mapMarkdownDestinations(source: string, map: (url: string) => string | undefined): string {
	const patches: { from: number; to: number; insert: string }[] = [];
	visit(parseMarkdown(source), node => {
		if (!['link', 'image', 'definition'].includes(node.type) || !('url' in node) || !node.position || !node.url) return;
		const replacement = map(String(node.url)); if (replacement === undefined || replacement === node.url) return;
		const from = node.position.start.offset!; const raw = source.slice(from, node.position.end.offset!);
		const starts = node.type === 'definition' ? [...raw.matchAll(/^\[(?:\\.|[^\]])*\]:/g)] : [...raw.matchAll(/(?<!\\)\]\(/g)];
		for (const start of starts) {
			const contentStart = start.index! + start[0].length;
			const offset = raw.indexOf(String(node.url), contentStart); if (offset < 0) continue;
			if (!/^\s*<?$/.test(raw.slice(contentStart, offset)) || !/^(?:[>\s)]|$)/.test(raw.slice(offset + String(node.url).length))) continue;
			patches.push({ from: from + offset, to: from + offset + String(node.url).length, insert: replacement }); break;
		}
	});
	let result = source;
	for (const patch of patches.sort((a, b) => b.from - a.from)) result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
	return result;
}

export function safeLink(url: string) {
	return /^(https?:\/\/|mailto:|#)/i.test(url) && !/[\u0000-\u0020\u007f]/.test(url);
}

function positionAndResources() {
	return (tree: HtmlRoot) => {
		visit(tree, 'element', node => {
			if (node.position?.start.offset !== undefined) node.properties.dataSource = node.position.start.offset;
			if (node.tagName === 'a') {
				const internal = /^(note|attachment):([a-zA-Z0-9-]+)$/.exec(String(node.properties.href ?? ''));
				if (internal) node.properties[internal[1] === 'note' ? 'dataNote' : 'dataAttachment'] = internal[2];
				if (!safeLink(String(node.properties.href ?? ''))) delete node.properties.href;
				node.properties.rel = ['noreferrer', 'noopener'];
			}
			// Resource resolution belongs to the platform attachment broker. No external image fetches.
			if (node.tagName === 'img') {
				const resource = /^attachment:([a-zA-Z0-9-]+)$/.exec(String(node.properties.src ?? ''));
				if (resource) node.properties.dataAttachment = resource[1];
				delete node.properties.src; delete node.properties.srcSet;
			}
		});
	};
}

function createRenderer(math: boolean) {
const renderer = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
	.use(remarkRehype)
	.use(positionAndResources)
	.use(rehypeSanitize, {
		...defaultSchema,
		attributes: {
			...defaultSchema.attributes,
			'*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSource', 'dataNote', 'dataAttachment'],
			code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./, 'math-inline', 'math-display']],
		},
	});
	// KaTeX sees sanitized text only and cannot enable trusted HTML commands.
	if (math) renderer.use(rehypeKatex, { trust: false, strict: 'error', maxExpand: 100, maxSize: 20 });
	return renderer.use(rehypeStringify);
}
const renderers = { math: createRenderer(true), plain: createRenderer(false) };

export class MarkdownRenderer {
	private cache = new Map<string, string>();
	async render(source: string, options = { math: true }) {
		const key = `${options.math}:` + source;
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;
		const html = String(await renderers[options.math ? 'math' : 'plain'].process(source));
		this.cache.set(key, html);
		if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
		return html;
	}
}
