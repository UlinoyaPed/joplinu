import DOMPurify from 'dompurify';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
export interface MarkdownFeatures { math: boolean; diagrams: boolean; highlight: boolean; media: boolean }

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter() {
	return highlighter ??= createHighlighterCore({
		themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
		langs: [import('shiki/langs/typescript.mjs'), import('shiki/langs/javascript.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/python.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/html.mjs'), import('shiki/langs/markdown.mjs'), import('shiki/langs/rust.mjs'), import('shiki/langs/kotlin.mjs')],
		engine: createJavaScriptRegexEngine(),
	});
}
let mermaidQueue = Promise.resolve();
let diagramId = 0;

export function enhancePreview(root: HTMLElement, preferences: MarkdownFeatures, assets: Map<string, { url: string; mime: string }>) {
	let cancelled = false;
	const stillHere = (element: Element) => !cancelled && root.contains(element);
	for (const element of root.querySelectorAll<HTMLElement>('[data-attachment]')) {
		const asset = assets.get(element.dataset.attachment!);
		if (!asset) { element.title = '附件不存在，请恢复完整备份'; continue; }
		if (element instanceof HTMLImageElement && /^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mime)) element.src = asset.url;
		if (element.tagName === 'A' && preferences.media && /^(audio|video)\//.test(asset.mime)) {
			const player = document.createElement(asset.mime.startsWith('audio/') ? 'audio' : 'video');
			player.controls = true; player.preload = 'metadata'; player.src = asset.url;
			element.after(player);
		}
	}
	for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
		const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
		const source = code.textContent ?? '';
		if (source.length > 50000) continue;
		if (language === 'mermaid' && preferences.diagrams) {
			mermaidQueue = mermaidQueue.then(async () => {
				if (!stillHere(code)) return;
				try {
					const { default: mermaid } = await import('mermaid');
					mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', maxTextSize: 50000, suppressErrorRendering: true, flowchart: { htmlLabels: false }, secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'themeCSS', 'flowchart'] });
					const { svg } = await mermaid.render(`joplinu-diagram-${++diagramId}`, source);
					if (!stillHere(code)) return;
					const container = document.createElement('div'); container.className = 'diagram';
					container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'a'], FORBID_ATTR: ['href', 'xlink:href'] });
					for (const style of container.querySelectorAll('style')) if (/@import|url\(\s*['"]?(?!#)/i.test(style.textContent ?? '')) style.remove();
					for (const element of container.querySelectorAll('[style]')) if (/url\(\s*['"]?(?!#)/i.test(element.getAttribute('style') ?? '')) element.removeAttribute('style');
					code.parentElement!.replaceChildren(container);
				} catch { if (stillHere(code)) code.parentElement!.dataset.renderError = '图表语法错误，已保留源码'; }
			}).catch(() => {});
		} else if (language && preferences.highlight) {
			void getHighlighter().then(highlighter => {
				if (!stillHere(code)) return;
				const aliases: Record<string, string> = { ts: 'typescript', js: 'javascript', sh: 'bash', py: 'python', md: 'markdown', rs: 'rust', kt: 'kotlin' };
				const lang = aliases[language] ?? language;
				if (!highlighter.getLoadedLanguages().includes(lang)) return;
				const html = highlighter.codeToHtml(source, { lang, themes: { light: 'github-light', dark: 'github-dark' } });
				const container = document.createElement('div'); container.innerHTML = DOMPurify.sanitize(html);
				const highlighted = container.firstElementChild;
				if (highlighted) code.parentElement!.replaceChildren(...highlighted.childNodes);
			}).catch(() => {});
		}
	}
	return () => { cancelled = true; };
}
