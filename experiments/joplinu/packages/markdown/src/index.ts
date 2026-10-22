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

export function safeLink(url: string) {
	return /^(https?:\/\/|mailto:|#)/i.test(url) && !/[\u0000-\u0020\u007f]/.test(url);
}

function positionAndResources() {
	return (tree: HtmlRoot) => {
		visit(tree, 'element', node => {
			if (node.position?.start.offset !== undefined) node.properties.dataSource = node.position.start.offset;
			if (node.tagName === 'a') {
				if (!safeLink(String(node.properties.href ?? ''))) delete node.properties.href;
				node.properties.rel = ['noreferrer', 'noopener'];
			}
			// Resource resolution belongs to the platform attachment broker. No external image fetches.
			if (node.tagName === 'img') { delete node.properties.src; delete node.properties.srcSet; }
		});
	};
}

const renderer = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
	.use(remarkRehype)
	.use(positionAndResources)
	.use(rehypeSanitize, {
		...defaultSchema,
		attributes: {
			...defaultSchema.attributes,
			'*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSource'],
			code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./, 'math-inline', 'math-display']],
		},
	})
	// KaTeX sees sanitized text only and cannot enable trusted HTML commands.
	.use(rehypeKatex, { trust: false, strict: 'error', maxExpand: 100, maxSize: 20 })
	.use(rehypeStringify);

export class MarkdownRenderer {
	private cache = new Map<string, string>();
	async render(source: string) {
		const cached = this.cache.get(source);
		if (cached !== undefined) return cached;
		const html = String(await renderer.process(source));
		this.cache.set(source, html);
		if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
		return html;
	}
}
