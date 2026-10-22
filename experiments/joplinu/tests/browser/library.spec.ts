import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: Page) { await page.goto('/'); await expect(page.locator('footer')).toContainText('已保存到本地'); }
async function saved(page: Page) { await expect(page.locator('footer')).toContainText('已保存到本地'); }
async function settings(page: Page, category: string) { await page.getByRole('button', { name: '打开设置', exact: true }).click(); await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: new RegExp('^' + category) }).click(); }
async function closeDialog(page: Page) { await page.getByRole('button', { name: '关闭对话框', exact: true }).click(); }
async function createFolder(page: Page, name: string) { await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await page.getByLabel('文件夹名称', { exact: true }).fill(name); await page.getByRole('button', { name: '保存文件夹', exact: true }).click(); }
async function write(page: Page, text: string) { await page.getByRole('tab', { name: '源码', exact: true }).click(); const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text); await saved(page); }
async function download(page: Page, button: string) { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: button, exact: true }).click(); return readFile((await (await pending).path())!); }

test('nested folders, notes, tags, move and trash survive reload without losing Markdown', async ({ page }) => {
	await open(page); await createFolder(page, '工作'); await page.locator('.folder-name').filter({ hasText: '工作' }).click();
	await createFolder(page, '项目'); await page.locator('.folder-name').filter({ hasText: '项目' }).click();
	await page.getByRole('complementary', { name: '笔记导航' }).getByRole('button', { name: '新建笔记', exact: true }).click(); await page.getByLabel('笔记标题', { exact: true }).fill('中文项目笔记');
	await write(page, '# 保真  \n\n第一行\n\n~~~js\nlet x = 1;\n~~~\n');
	await page.getByRole('button', { name: '信息', exact: true }).click(); await page.getByLabel('标签（逗号分隔）').fill('重要, 离线'); await page.getByRole('button', { name: '保存信息', exact: true }).click(); await saved(page);
	await page.reload(); await expect(page.locator('footer')).toContainText('已保存到本地'); await page.getByLabel('搜索笔记', { exact: true }).fill('重要 第一行');
	await expect(page.locator('.note-item')).toHaveCount(1); await page.locator('.note-item').click(); await expect(page.getByLabel('笔记标题')).toHaveValue('中文项目笔记');
	expect((await download(page, '导出 Markdown ↗')).toString()).toBe('# 保真  \n\n第一行\n\n~~~js\nlet x = 1;\n~~~\n');
	await page.getByRole('button', { name: '移动', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '工作', exact: true }).click(); await expect(page.locator('.breadcrumb')).toHaveText('工作');
	await page.getByRole('button', { name: '将笔记移入回收站' }).click(); await expect(page.getByRole('heading', { name: '这篇笔记在回收站中' })).toBeVisible();
	await page.getByRole('button', { name: '恢复笔记', exact: true }).click(); await saved(page); await expect(page.getByRole('tab', { name: '实时预览', exact: true })).toBeVisible();
});

test('theme, editor preferences and history are functional and persistent', async ({ page }) => {
	await open(page); await settings(page, '外观'); await page.getByRole('combobox', { name: '主题', exact: true }).selectOption('dark'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await closeDialog(page);
	await settings(page, '编辑器'); await page.getByLabel('拼写检查').check(); await closeDialog(page); await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toHaveAttribute('spellcheck', 'true');
	await page.getByRole('button', { name: '历史', exact: true }).click(); await page.getByRole('button', { name: '创建当前快照' }).click(); await closeDialog(page);
	await write(page, '\n要撤回的内容'); await page.getByRole('button', { name: '历史', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: /手动快照/ }).first().click(); await page.getByRole('button', { name: '恢复此版本' }).click();
	expect((await download(page, '导出 Markdown ↗')).toString()).not.toContain('要撤回的内容'); await saved(page); await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toHaveAttribute('spellcheck', 'true');
});

test('real Mermaid and Shiki render safely; Markdown switches actually disable rendering', async ({ page }) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	await open(page); await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: '图表.md', mimeType: 'text/markdown', buffer: Buffer.from('# 图表\n\n```mermaid\nflowchart LR\nA[开始] --> B[完成]\n```\n\n```ts\nconst n = 1;\n```\n\n$x^2$\n') });
	await page.getByRole('tab', { name: '双列', exact: true }).click(); const preview = page.getByLabel('Markdown 预览');
	await expect(preview.locator('.diagram svg')).toBeVisible({ timeout: 20000 }); await expect(preview.locator('pre code span[style]').first()).toBeVisible(); await expect(preview.locator('.katex')).toBeVisible();
	await settings(page, 'Markdown'); await page.getByLabel('流程图 · Mermaid').uncheck(); await page.getByLabel('数学公式 · KaTeX').uncheck(); await page.getByLabel('代码高亮 · Shiki').uncheck(); await closeDialog(page);
	await expect(preview.locator('.diagram')).toHaveCount(0); await expect(preview.locator('.katex')).toHaveCount(0); await expect(preview.locator('code.language-mermaid')).toContainText('flowchart LR');
	expect(errors).toEqual([]);
});

test('complete backup restore adds a subtree and rejects damaged backups', async ({ page }) => {
	await open(page); await page.getByLabel('笔记标题').fill('保留的原笔记'); await saved(page);
	await settings(page, '导入和导出'); const backup = await download(page, '导出明文备份');
	const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '恢复备份', exact: true }).click(); await (await chooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
	await expect(page.getByRole('status').filter({ hasText: '导入完成' })).toBeAttached(); await closeDialog(page); await expect(page.locator('.note-item').filter({ hasText: '保留的原笔记' })).toHaveCount(2);
	await settings(page, '导入和导出'); const bad = JSON.parse(backup.toString()); bad.payload += 'tampered'; const badChooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '恢复备份', exact: true }).click(); await (await badChooser).setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
	await expect(page.getByRole('dialog').getByRole('alert')).toContainText('校验失败'); await closeDialog(page); await expect(page.locator('.note-item').filter({ hasText: '保留的原笔记' })).toHaveCount(2);
});

test('attachment bytes survive backup and local image previews never fetch remote URLs', async ({ page }) => {
	await open(page); const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGPQaIr6jw8zjAwFABxGgMFYpl+zAAAAAElFTkSuQmCC', 'base64');
	await page.getByLabel('导入附件', { exact: true }).setInputFiles({ name: '本地图片.png', mimeType: 'image/png', buffer: pixel });
	await page.getByRole('tab', { name: '双列', exact: true }).click(); await expect(page.getByLabel('Markdown 预览').locator('img[src^="blob:"]')).toBeVisible(); await saved(page);
	await settings(page, '导入和导出'); const backup = JSON.parse((await download(page, '导出明文备份')).toString()); const vault = JSON.parse(backup.payload); expect(Buffer.from(vault.attachments[0].data, 'base64')).toEqual(pixel);
});

test('a second window cannot overwrite a newer saved library and can export its unsaved draft', async ({ page, context }) => {
	await open(page); const second = await context.newPage(); await open(second);
	await write(page, '\n来自窗口甲'); await second.getByRole('tab', { name: '源码', exact: true }).click(); await second.getByRole('textbox', { name: 'Markdown 源码' }).click(); await second.keyboard.press('Control+End'); await second.keyboard.insertText('\n来自窗口乙');
	await expect(second.getByRole('alert')).toContainText('其他窗口');
	const backup = JSON.parse((await download(second, '导出当前备份')).toString()); const vault = JSON.parse(backup.payload); expect(vault.notes.length).toBeGreaterThan(0);
	await page.reload(); expect((await download(page, '导出 Markdown ↗')).toString()).toContain('来自窗口甲'); expect((await download(page, '导出 Markdown ↗')).toString()).not.toContain('来自窗口乙');
});

test('mobile navigation exposes folders and all settings without horizontal overflow', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 }); await open(page);
	await page.getByRole('button', { name: '打开笔记导航' }).click(); await expect(page.getByRole('button', { name: '新建文件夹' })).toBeVisible(); await createFolder(page, '手机资料');
	await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.getByRole('navigation', { name: '设置分类' }).getByRole('button')).toHaveCount(9);
	await page.screenshot({ path: 'test-results/mobile-settings.png', fullPage: true }); await page.getByRole('button', { name: /编辑器.*字体/ }).click(); await expect(page.getByLabel('默认编辑模式')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('rich table tools and task checkboxes change Markdown through the shared document', async ({ page }) => {
	await open(page); await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: '表格.md', mimeType: 'text/markdown', buffer: Buffer.from('前言\n\n') });
	await page.getByRole('tab', { name: '富文本', exact: true }).click(); const rich = page.getByRole('textbox', { name: '富文本编辑器' }); await rich.locator('p').last().click(); await page.keyboard.press('Control+End');
	await page.getByRole('button', { name: '插入表格', exact: true }).click(); await expect(rich.locator('table')).toHaveCount(1); await expect(rich.locator('tr')).toHaveCount(2);
	await rich.locator('td').last().click(); await page.getByRole('button', { name: '增加行', exact: true }).click(); await expect(rich.locator('tr')).toHaveCount(3);
	await rich.locator('td').last().click(); await page.getByRole('button', { name: '增加列', exact: true }).click(); await expect(rich.locator('tr').first().locator('th')).toHaveCount(3);
	expect((await download(page, '导出 Markdown ↗')).toString()).toContain('| 标题一 | 标题二 |'); await expect(page.getByRole('alert')).toHaveCount(0);
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: '任务.md', mimeType: 'text/markdown', buffer: Buffer.from('- [ ] 待办\n') }); await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await page.getByRole('checkbox', { name: '切换任务完成状态' }).check(); expect((await download(page, '导出 Markdown ↗')).toString()).toContain('[x] 待办');
});

test('rich math edits have a real formula dialog and preserve untouched Markdown', async ({ page }) => {
	const fixture = '公式：$x^2$\n\n~~~ts\nconst x = 1;\n~~~\n';
	await open(page); await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: '公式.md', mimeType: 'text/markdown', buffer: Buffer.from(fixture) });
	await page.getByRole('tab', { name: '富文本', exact: true }).click(); await page.getByRole('textbox', { name: '富文本编辑器' }).locator('.math-source').dblclick();
	await expect(page.getByRole('dialog', { name: '编辑数学公式' })).toBeVisible(); await page.getByLabel('LaTeX 公式').fill('y^3'); await page.getByRole('button', { name: '保存公式', exact: true }).click();
	expect((await download(page, '导出 Markdown ↗')).toString()).toBe(fixture.replace('$x^2$', '$y^3$'));
	await expect(page.getByRole('textbox', { name: '富文本编辑器' }).locator('.katex')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an async file import cannot switch away from a different note during composition', async ({ page }) => {
	await open(page);
	await page.evaluate(() => { const original = File.prototype.text; File.prototype.text = async function() { if (this.name === 'slow.md') await new Promise<void>(resolve => window.addEventListener('test-release-file-read', () => resolve(), { once: true })); return original.call(this); }; });
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: 'slow.md', mimeType: 'text/markdown', buffer: Buffer.from('不可打断输入') });
	await page.getByRole('complementary', { name: '笔记导航' }).getByRole('button', { name: '新建笔记', exact: true }).click();
	const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.click();
	await source.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
	await page.keyboard.insertText('中文'); await page.evaluate(() => window.dispatchEvent(new Event('test-release-file-read'))); await expect(page.getByRole('alert')).toContainText('结束中文输入');
	await expect(page.getByLabel('笔记标题')).toHaveValue('无标题笔记');
	await source.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
	expect((await download(page, '导出 Markdown ↗')).toString()).toBe('中文'); await expect(page.locator('.note-item')).toHaveCount(2);
});

test('note links navigate in both rendered and rich views', async ({ page }) => {
	await open(page); await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles([{ name: '起点.md', mimeType: 'text/markdown', buffer: Buffer.from('跳转：') }, { name: '终点.md', mimeType: 'text/markdown', buffer: Buffer.from('目标正文') }]);
	await page.getByRole('button', { name: '内链', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: /^终点/ }).click(); await page.getByRole('tab', { name: '富文本', exact: true }).click();
	await page.getByRole('textbox', { name: '富文本编辑器' }).locator('a[data-note]').click(); await expect(page.getByLabel('笔记标题')).toHaveValue('终点');
	await page.locator('.note-item').filter({ hasText: '起点' }).click(); await page.getByRole('tab', { name: '双列', exact: true }).click(); await page.getByLabel('Markdown 预览').locator('a[data-note]').click(); await expect(page.getByLabel('笔记标题')).toHaveValue('终点');
});

test('live block widgets render tables, formulas and code without changing original Markdown', async ({ page }) => {
	await open(page); const source = '# 编辑区\n\n正文\n\n| a | b |\n|---|---|\n| 甲 | 乙 |\n\n$$\nx^2\n$$\n\n```ts\nconst n = 1;\n```\n';
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: '实时预览.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
	await expect(page.locator('.live-block-preview table')).toBeVisible(); await expect(page.locator('.live-block-preview .katex')).toBeVisible();
	expect((await download(page, '导出 Markdown ↗')).toString()).toBe(source);
	await page.locator('.live-block-preview').filter({ has: page.locator('table') }).dblclick(); await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toBeFocused();
	await expect(page.locator('.live-block-preview table')).toHaveCount(0); expect((await download(page, '导出 Markdown ↗')).toString()).toBe(source);
	await expect(page.getByRole('alert')).toHaveCount(0);
});
