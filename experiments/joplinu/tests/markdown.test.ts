import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../packages/markdown/src/index';

describe('safe Markdown rendering', () => {
	const renderer = new MarkdownRenderer();
	it('renders GFM, KaTeX and source positions', async () => {
		const html = await renderer.render('# 中文\n\n- [x] 完成\n\n$x^2$\n\n| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<h1 data-source="0">中文</h1>');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain('katex');
		expect(html).toContain('<table');
	});

	it.each([
		'<script>alert(1)</script><img src=x onerror=alert(1)>',
		'[x](javascript:alert%281%29)',
		'[x](file:///etc/passwd)',
		'[x](data:text/html,test)',
		'![x](https://tracker.invalid/a.png)',
		'![x](file:///etc/passwd)',
		'$\\href{javascript:alert(1)}{x}$',
	])('blocks active content and unsolicited resource access: %s', async input => {
		const html = await renderer.render(input);
		expect(html).not.toMatch(/<script|onerror=|href="(?:javascript:|file:|data:)|src="(?:https?:|file:)/i);
	});

	it('produces stable cached output', async () => {
		expect(await renderer.render('**same**')).toBe(await renderer.render('**same**'));
	});
});
