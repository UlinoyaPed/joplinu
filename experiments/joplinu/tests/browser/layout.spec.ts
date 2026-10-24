import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: Page) { await page.goto('/'); await expect(page.locator('footer')).toContainText('已保存到本地'); }
async function saved(page: Page) { await expect(page.locator('footer')).toContainText('已保存到本地'); }
async function folder(page: Page, name: string) {
	await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await page.getByLabel('文件夹名称', { exact: true }).fill(name); await page.getByRole('button', { name: '保存文件夹', exact: true }).click();
}
async function imported(page: Page, title: string, source: string) {
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: title + '.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
	await expect(page.getByLabel('笔记标题')).toHaveValue(title); await saved(page);
}
async function exported(page: Page) {
	const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Markdown ↗', exact: true }).click(); return readFile((await (await pending).path())!, 'utf8');
}
const navigation = (page: Page) => page.getByRole('complementary', { name: '笔记导航' });

test('desktop uses three independent resizable panes, persists widths, and restores hidden panes without changing Markdown', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 960 }); await open(page);
	const original = '# 布局验证  \r\n\r\n~~~ts\r\nconst n = 1;\r\n~~~\r\n'; await imported(page, '桌面布局', original);
	const sidebar = navigation(page); const list = page.getByRole('region', { name: '笔记列表面板' }); const editor = page.locator('.library-main');
	const a = (await sidebar.boundingBox())!; const b = (await list.boundingBox())!; const c = (await editor.boundingBox())!;
	expect(a.x + a.width).toBeLessThanOrEqual(b.x); expect(b.x + b.width).toBeLessThanOrEqual(c.x); expect(c.width).toBeGreaterThan(700);
	const separator = page.getByRole('separator', { name: '调整笔记列表宽度' }); await separator.focus(); await page.keyboard.press('ArrowRight'); await expect(separator).toHaveAttribute('aria-valuenow', '290');
	const handle = (await separator.boundingBox())!; await page.mouse.move(handle.x + 2, handle.y + 120); await page.mouse.down(); await page.mouse.move(handle.x + 42, handle.y + 120, { steps: 5 }); await page.mouse.up();
	await expect(separator).toHaveAttribute('aria-valuenow', '330'); await saved(page); expect(await exported(page)).toBe(original);
	await page.screenshot({ path: 'test-results/desktop-three-pane.png', fullPage: true }); await page.reload(); await expect(separator).toHaveAttribute('aria-valuenow', '330');
	await page.getByRole('button', { name: '切换文件夹栏' }).click(); await page.getByRole('button', { name: '切换笔记列表' }).click(); await saved(page); await page.reload();
	await expect(sidebar).toBeHidden(); await expect(list).toBeHidden(); expect((await editor.boundingBox())!.width).toBe(1440);
	await page.setViewportSize({ width: 950, height: 700 }); expect((await editor.boundingBox())!.width).toBe(950); await page.setViewportSize({ width: 1440, height: 960 });
	await page.getByRole('button', { name: '切换文件夹栏' }).click(); await page.getByRole('button', { name: '切换笔记列表' }).click(); await expect(sidebar).toBeVisible(); await expect(list).toBeVisible();
});

test('phone drawer traps focus while dialogs can still import files and report the result', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 }); await open(page);
	await page.getByRole('button', { name: '打开笔记列表', exact: true }).click(); await page.getByRole('button', { name: '从列表打开笔记导航' }).click();
	await expect(page.locator('.note-list-pane')).toHaveJSProperty('inert', true);
	await navigation(page).locator('button:not(:disabled), a[href]').last().focus(); await page.keyboard.press('Tab'); await expect(navigation(page).getByRole('link').first()).toBeFocused();
	await navigation(page).getByRole('button', { name: '设置', exact: true }).click();
	await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /^导入和导出/ }).click();
	await expect(page.locator('.library-main')).toHaveJSProperty('inert', false);
	const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '导入 Markdown 文件', exact: true }).click();
	await (await chooser).setFiles({ name: '手机导入.md', mimeType: 'text/markdown', buffer: Buffer.from('手机设置导入的原文  \r\n') });
	await page.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(page.getByLabel('笔记标题')).toHaveValue('手机导入');
	expect(await exported(page)).toBe('手机设置导入的原文  \r\n'); await saved(page);
	await page.getByRole('button', { name: '打开笔记列表', exact: true }).click(); await page.getByRole('button', { name: '从列表打开笔记导航' }).click();
	await page.keyboard.press('Escape'); await expect(navigation(page)).toBeHidden(); await expect(page.locator('.note-list-pane')).toHaveJSProperty('inert', false);
	await page.getByRole('button', { name: '返回当前笔记' }).click(); await expect(page.getByLabel('笔记标题')).toHaveValue('手机导入');
});

test('tag navigation combines exact tags and text search; new notes inherit the tag and copies edit independently', async ({ page }) => {
	await open(page); await imported(page, 'Alpha', '# 原文  \n\n:::unknown\n保留\n:::');
	await page.getByRole('button', { name: '信息', exact: true }).click(); await page.getByLabel('标签（逗号分隔）').fill('重要'); await page.getByRole('button', { name: '保存信息', exact: true }).click();
	await imported(page, 'Beta', '正文里提到重要，但没有标签');
	await page.getByRole('navigation', { name: '笔记标签' }).getByRole('button', { name: /# 重要/ }).click(); await expect(page.locator('.note-item')).toHaveCount(1);
	await page.getByLabel('搜索笔记', { exact: true }).fill('Beta'); await expect(page.locator('.note-item')).toHaveCount(0); await page.getByLabel('搜索笔记', { exact: true }).fill('');
	await navigation(page).getByRole('button', { name: '新建笔记', exact: true }).click(); await page.getByLabel('笔记标题').fill('继承标签');
	await page.getByRole('button', { name: '信息', exact: true }).click(); await expect(page.getByLabel('标签（逗号分隔）')).toHaveValue('重要'); await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
	await page.getByRole('button', { name: '笔记操作 Alpha', exact: true }).click(); await page.getByRole('button', { name: '复制笔记', exact: true }).click(); await expect(page.getByLabel('笔记标题')).toHaveValue('Alpha（副本）');
	await page.getByRole('tab', { name: '源码', exact: true }).click(); await page.getByRole('textbox', { name: 'Markdown 源码' }).click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n副本独有');
	await page.getByRole('button', { name: '笔记操作 Alpha', exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); expect(await exported(page)).toBe('# 原文  \n\n:::unknown\n保留\n:::');
	await saved(page); await page.reload(); await page.getByRole('button', { name: '笔记操作 Alpha（副本）', exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); expect(await exported(page)).toContain('副本独有');
});

test('bulk move, trash and restore retain every selected Markdown document after reload', async ({ page }) => {
	await open(page); await folder(page, '归档');
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles([1, 2, 3].map(n => ({ name: `批量${n}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`第${n}篇\n\n~~~txt\n保真  \n~~~`) })));
	await saved(page); await page.getByLabel('搜索笔记', { exact: true }).fill('批量'); await expect(page.locator('.note-item')).toHaveCount(3);
	await page.getByRole('button', { name: '批量选择', exact: true }).click(); await page.getByRole('checkbox', { name: '全选当前列表' }).check(); await page.getByRole('button', { name: '移动所选' }).click(); await page.getByRole('dialog').getByRole('button', { name: '归档', exact: true }).click();
	await expect(page.locator('.breadcrumb')).toHaveText('归档'); await page.getByRole('checkbox', { name: '全选当前列表' }).check(); await page.getByRole('button', { name: '回收所选' }).click();
	await expect(page.getByRole('status').filter({ hasText: '已移入回收站' })).toBeVisible();
	await navigation(page).getByRole('button', { name: /^回收站/ }).click(); await expect(page.locator('.note-item')).toHaveCount(3); await page.reload();
	await navigation(page).getByRole('button', { name: /^回收站/ }).click(); await page.getByRole('button', { name: '批量选择', exact: true }).click(); await page.getByRole('checkbox', { name: '全选当前列表' }).check(); await page.getByRole('button', { name: '恢复所选' }).click();
	await navigation(page).getByRole('button', { name: /^全部笔记/ }).click(); await page.getByLabel('搜索笔记', { exact: true }).fill('批量'); await expect(page.locator('.note-item')).toHaveCount(3);
	for (const n of [1, 2, 3]) { await page.getByRole('button', { name: `笔记操作 批量${n}`, exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); expect(await exported(page)).toBe(`第${n}篇\n\n~~~txt\n保真  \n~~~`); await expect(page.locator('.breadcrumb')).toHaveText('归档'); }
});

test('removing a nonempty folder requires its name and retains child folders, content and history', async ({ page }) => {
	await open(page); await folder(page, '工作'); await page.locator('.folder-name').filter({ hasText: '工作' }).click(); await folder(page, '子目录');
	await navigation(page).getByRole('button', { name: '新建笔记', exact: true }).click(); await page.getByLabel('笔记标题').fill('保留的笔记');
	await page.getByRole('tab', { name: '源码', exact: true }).click(); await page.getByRole('textbox', { name: 'Markdown 源码' }).click(); await page.keyboard.insertText('正文  \n\n~~~js\nlet x = 1;\n~~~');
	await page.getByRole('button', { name: '历史', exact: true }).click(); await page.getByRole('button', { name: '创建当前快照' }).click(); await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
	await page.getByRole('button', { name: '管理文件夹 工作', exact: true }).click(); await page.getByRole('button', { name: '移除文件夹', exact: true }).click(); await expect(page.getByRole('button', { name: '确认移除文件夹' })).toBeDisabled();
	await page.getByLabel('输入文件夹名称确认').fill('工作'); await page.getByRole('button', { name: '确认移除文件夹' }).click();
	await expect(page.getByRole('button', { name: '管理文件夹 工作', exact: true })).toHaveCount(0); await expect(page.locator('.folder-name').filter({ hasText: '子目录' })).toBeVisible();
	expect(await exported(page)).toBe('正文  \n\n~~~js\nlet x = 1;\n~~~'); await page.getByRole('button', { name: '历史', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('button', { name: /手动快照/ })).toBeVisible();
	await page.getByRole('button', { name: '关闭对话框', exact: true }).click(); await saved(page); await page.reload(); await page.getByRole('button', { name: '笔记操作 保留的笔记', exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); expect(await exported(page)).toContain('let x = 1;');
});

test('phone switches between list and editor with undo intact, and rotation reveals the tablet panes', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 }); await open(page); await imported(page, '手机笔记', '开始');
	await page.getByRole('tab', { name: '源码', exact: true }).click(); await page.getByRole('textbox', { name: 'Markdown 源码' }).click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('中文编辑');
	await page.getByRole('button', { name: '打开笔记列表', exact: true }).click(); await expect(page.locator('.library-main')).toBeHidden(); await expect(page.getByLabel('搜索笔记', { exact: true })).toBeVisible();
	await page.screenshot({ path: 'test-results/mobile-note-list.png', fullPage: true });
	await page.getByRole('button', { name: '笔记操作 手机笔记', exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); await expect(page.getByRole('tab', { name: '源码', exact: true })).toHaveAttribute('aria-selected', 'true');
	expect(await exported(page)).toBe('开始中文编辑'); await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await exported(page)).toBe('开始');
	await page.setViewportSize({ width: 950, height: 700 }); await expect(page.getByRole('region', { name: '笔记列表面板' })).toBeVisible(); await expect(page.locator('.library-main')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect((await page.locator('.library-main').boundingBox())!.width).toBeGreaterThan(600);
});
