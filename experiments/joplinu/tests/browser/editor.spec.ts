import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = '# 中文标题  \n\n原文 **粗体** 和 *斜体*。\n\n| a | b |\n|:---|---:|\n| 甲 | 乙 |\n\n$$\nx^2\n$$\n\n~~~ts\nconst x = 1;\n~~~\n\n![附件](attachment:abc)\n\n:::custom\n未知语法\n:::\n';

async function load(page: Page, text = fixture) {
	await page.goto('/');
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: 'fixture.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
	await expect(page.locator('footer')).toContainText(`${text.length} 字符`);
}

async function exported(page: Page) {
	const downloaded = page.waitForEvent('download');
	await page.getByRole('button', { name: '导出 Markdown' }).click();
	const file = await downloaded;
	return readFile((await file.path())!, 'utf8');
}

test('four modes preserve every original byte through repeated switches', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await load(page);
	for (const name of ['源码', '富文本', '双列', '实时预览', '富文本', '源码']) {
		await page.getByRole('tab', { name, exact: true }).click();
		await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
	}
	expect(await exported(page)).toBe(fixture);
	expect(errors).toEqual([]);
});

test('source → rich → source edits, shared undo and redo retain untouched syntax', async ({ page }) => {
	await load(page);
	await page.getByRole('tab', { name: '源码', exact: true }).click();
	const source = page.getByRole('textbox', { name: 'Markdown 源码' });
	await source.click();
	await page.keyboard.press('Control+Home');
	await page.keyboard.press('End');
	await page.keyboard.insertText('源');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	const rich = page.getByRole('textbox', { name: '富文本编辑器' });
	await expect(rich.locator('h1')).toHaveText('中文标题 源');
	await rich.locator('h1').click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('富');
	await expect(rich.locator('h1')).toHaveText('中文标题 源富');
	await page.getByRole('tab', { name: '源码', exact: true }).click();
	expect(await exported(page)).toBe(fixture.replace('# 中文标题  ', '# 中文标题  源富'));
	await page.getByRole('button', { name: '撤销', exact: true }).click();
	expect(await exported(page)).toBe(fixture.replace('# 中文标题  ', '# 中文标题  源'));
	await page.getByRole('button', { name: '重做', exact: true }).click();
	expect(await exported(page)).toContain('源富');
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rich toolbar formats selected text without rewriting other blocks', async ({ page }) => {
	await load(page, '正文文字\n\n~~~ts\nlet n = 1;\n~~~\n');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	const rich = page.getByRole('textbox', { name: '富文本编辑器' });
	await rich.locator('p').first().click();
	await page.keyboard.press('Control+Home');
	await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.press('Shift+ArrowRight');
	await page.getByRole('button', { name: '加粗', exact: true }).click();
	await expect(rich.locator('strong')).toHaveText('正文');
	expect(await exported(page)).toBe('**正文**文字\n\n~~~ts\nlet n = 1;\n~~~\n');
});

test('rich typing supports new paragraphs, blank lines and an empty document', async ({ page }) => {
	await load(page, '起点');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	const rich = page.getByRole('textbox', { name: '富文本编辑器' });
	await rich.click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.insertText('新段落');
	expect(await exported(page)).toBe('起点\n\n\n\n新段落');
	await page.getByRole('tab', { name: '源码', exact: true }).click();
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await expect(rich).toContainText('新段落');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await load(page, '');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await rich.click();
	await page.keyboard.insertText('空文档输入');
	expect(await exported(page)).toBe('空文档输入');
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unknown extensions remain visible and offer explicit source fallback', async ({ page }) => {
	await load(page, ':::plugin\nkeep [[链接]]\n:::\n');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await page.locator('[data-source-fallback]').dblclick();
	await expect(page.getByRole('tab', { name: '源码', exact: true })).toHaveAttribute('aria-selected', 'true');
	expect(await exported(page)).toBe(':::plugin\nkeep [[链接]]\n:::\n');
});

test('an unsafe rich-to-Markdown conversion preserves the original and offers a recovery draft', async ({ page }) => {
	const original = '| a |\n|---|\n| b |';
	await load(page, original);
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await page.getByRole('textbox', { name: '富文本编辑器' }).locator('td').last().click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('|');
	await expect(page.getByRole('alert')).toContainText('无法无损转换');
	expect(await exported(page)).toBe(original);
	const downloaded = page.waitForEvent('download');
	await page.getByRole('button', { name: '导出恢复草稿' }).click();
	const draft = await downloaded;
	expect(await readFile((await draft.path())!, 'utf8')).toContain('b\\|');
});

test('two real editor instances merge disconnected edits and remote content reaches rich view', async ({ page }) => {
	await load(page, '共同笔记');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await page.getByRole('button', { name: '双实例实验' }).click();
	await page.getByRole('button', { name: '断开连接', exact: true }).click();
	const rich = page.getByRole('textbox', { name: '富文本编辑器' });
	await rich.click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('甲');
	const peer = page.locator('.peer').getByRole('textbox', { name: 'Markdown 源码' });
	await peer.click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('乙');
	await page.getByRole('button', { name: '重新连接并合并', exact: true }).click();
	await expect(rich).toContainText('甲');
	await expect(rich).toContainText('乙');
	const result = await exported(page);
	expect(result).toContain('甲'); expect(result).toContain('乙');
	await expect(peer).toHaveText(result);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('synthetic composition blocks mode switching and commits Chinese once', async ({ page }) => {
	await load(page, '组合输入');
	const source = page.getByRole('textbox', { name: 'Markdown 源码' });
	await source.click();
	await page.keyboard.press('End');
	await source.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
	await page.keyboard.insertText('中文');
	await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await expect(page.getByRole('tab', { name: '实时预览', exact: true })).toHaveAttribute('aria-selected', 'true');
	await source.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
	await page.getByRole('tab', { name: '源码', exact: true }).click();
	expect(await exported(page)).toBe('组合输入中文');
});

test('split preview is sanitized and clicking a heading locates source', async ({ page }) => {
	await load(page, '# 标题\n\n点击 **这里**\n\n<script>window.injected = true</script>\n\n![追踪](https://invalid.example/tracker.png)');
	await page.getByRole('tab', { name: '双列', exact: true }).click();
	const preview = page.getByLabel('Markdown 预览');
	await expect(preview.locator('h1')).toHaveText('标题');
	await expect(preview.locator('script')).toHaveCount(0);
	await expect(preview.locator('img')).not.toHaveAttribute('src');
	await preview.locator('h1').click();
	await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeFocused();
	await page.keyboard.insertText('源');
	expect(await exported(page)).toMatch(/^源# 标题/);
});

test('small-screen layout keeps both split panes reachable without horizontal overflow', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 });
	await load(page);
	await page.getByRole('tab', { name: '双列', exact: true }).click();
	await expect(page.getByLabel('Markdown 预览').locator('h1')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.screenshot({ path: 'test-results/mobile-editor.png', fullPage: true });
});
