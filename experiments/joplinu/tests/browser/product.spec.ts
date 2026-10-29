import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function open(page: Page) { await page.goto('/'); await expect(page.locator('footer')).toContainText('已保存到本地'); }
async function imported(page: Page, title: string, source: string) {
	await page.getByLabel('导入 Markdown', { exact: true }).setInputFiles({ name: title + '.md', mimeType: 'text/markdown', buffer: Buffer.from(source) }); await expect(page.getByLabel('笔记标题')).toHaveValue(title);
}
async function exported(page: Page) {
	const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Markdown ↗', exact: true }).click(); return readFile((await (await pending).path())!, 'utf8');
}
async function selectStart(page: Page, characters = 2) {
	const source = page.getByRole('textbox', { name: 'Markdown 源码', exact: true }); await source.click(); await page.keyboard.press('Control+Home'); await page.keyboard.down('Shift');
	for (let i = 0; i < characters; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
}
async function tags(page: Page, value: string) { await page.getByRole('button', { name: '信息', exact: true }).click(); await page.getByLabel('标签（逗号分隔）').fill(value); await page.getByRole('button', { name: '保存信息', exact: true }).click(); }

test('source, live and split toolbars edit the selection, retain CRLF and share undo with rich mode', async ({ page }) => {
	await open(page); const original = '文字\r\n\r\n~~~ts\r\nconst x = 1;\r\n~~~\r\n\r\n:::custom\r\n不动\r\n:::\r\n';
	for (const mode of ['源码', '实时预览', '双列']) {
		await imported(page, mode + '格式', original); await page.getByRole('tab', { name: mode, exact: true }).click(); await selectStart(page);
		await page.getByRole('button', { name: '加粗', exact: true }).click(); expect(await exported(page)).toBe(original.replace('文字', '**文字**'));
		await page.getByRole('tab', { name: '富文本', exact: true }).click(); await expect(page.getByRole('textbox', { name: '富文本编辑器' }).locator('strong')).toHaveText('文字');
		await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await exported(page)).toBe(original);
	}
});

test('format shortcuts keep the selected text and URL editing participates in undo', async ({ page }) => {
	await open(page); await imported(page, '快捷键', '文字\n\n保留的末尾'); await page.getByRole('tab', { name: '源码', exact: true }).click(); await selectStart(page);
	await page.keyboard.press('Control+b'); expect(await exported(page)).toBe('**文字**\n\n保留的末尾');
	await page.getByRole('textbox', { name: 'Markdown 源码' }).focus(); await page.keyboard.press('Control+b'); expect(await exported(page)).toBe('文字\n\n保留的末尾');
	await selectStart(page); await page.keyboard.press('Control+k'); await page.keyboard.insertText('https://example.org'); expect(await exported(page)).toBe('[文字](https://example.org)\n\n保留的末尾');
	await page.getByRole('button', { name: '撤销', exact: true }).click(); await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await exported(page)).toBe('文字\n\n保留的末尾');
});

test('task formatting changes selected lines and search/replace is available without leaving the editor', async ({ page }) => {
	await open(page); await imported(page, '任务列表', '甲\n乙\n\n~~~txt\n不动\n~~~'); await page.getByRole('tab', { name: '源码', exact: true }).click();
	await selectStart(page, 3); await page.getByRole('button', { name: '插入任务', exact: true }).click(); expect(await exported(page)).toBe('- [ ] 甲\n- [ ] 乙\n\n~~~txt\n不动\n~~~');
	await page.getByRole('button', { name: '查找替换', exact: true }).click(); await expect(page.locator('.cm-search')).toBeVisible();
	await page.locator('.cm-search input[name=search]').fill('甲'); await page.locator('.cm-search input[name=replace]').fill('替换'); await page.locator('.cm-search button[name=replaceAll]').click();
	expect(await exported(page)).toBe('- [ ] 替换\n- [ ] 乙\n\n~~~txt\n不动\n~~~');
});

test('to-do notes complete, pin, reopen and convert without modifying their Markdown body', async ({ page }) => {
	await open(page); await page.getByRole('button', { name: '新建待办', exact: true }).click(); await page.getByLabel('笔记标题').fill('采购清单');
	await page.getByRole('tab', { name: '源码', exact: true }).click(); await page.getByRole('textbox', { name: 'Markdown 源码' }).click(); await page.keyboard.insertText('- [ ] 正文任务保留');
	await page.getByRole('button', { name: '切换笔记置顶' }).click(); await page.getByRole('checkbox', { name: '完成当前待办' }).check();
	await page.getByRole('complementary', { name: '笔记导航' }).getByRole('button', { name: /^待办事项/ }).click(); await page.getByLabel('搜索笔记', { exact: true }).fill('type:todo is:completed is:pinned'); await expect(page.locator('.note-item')).toHaveCount(1);
	await expect(page.getByRole('checkbox', { name: '完成待办 采购清单' })).toBeChecked(); await expect(page.locator('footer')).toContainText('已保存到本地'); await page.reload();
	await page.getByRole('button', { name: '笔记操作 采购清单', exact: true }).click(); await page.getByRole('button', { name: '打开笔记', exact: true }).click(); await expect(page.getByRole('checkbox', { name: '完成当前待办' })).toBeChecked(); await expect(page.getByRole('button', { name: '切换笔记置顶' })).toHaveAttribute('aria-pressed', 'true');
	expect(await exported(page)).toBe('- [ ] 正文任务保留'); await page.getByRole('button', { name: '切换笔记类型' }).click(); await expect(page.getByRole('checkbox', { name: '完成当前待办' })).toHaveCount(0); expect(await exported(page)).toBe('- [ ] 正文任务保留');
	await expect(page.locator('.note-item').first()).toContainText('采购清单');
});

test('query filters combine quoted tags, notebook, negation and OR while remaining safe during typing', async ({ page }) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await open(page);
	await imported(page, '项目 计划', 'coffee tea'); await tags(page, '重要 项目'); await imported(page, '旧计划', 'coffee'); await tags(page, '归档'); await imported(page, '无关', '别的内容');
	const search = page.getByLabel('搜索笔记', { exact: true });
	for (const query of ['tag:"重要 项目" -body:取消', 'any:1 body:tea body:coffee -tag:归档', 'title:"项目 计划"']) { await search.fill(query); await expect(page.locator('.note-item')).toHaveCount(1); await expect(page.locator('.note-item')).toContainText('项目 计划'); }
	await search.fill('title:"项目'); await expect(page.locator('.note-item')).toHaveCount(1); await search.fill('https://not-present.example'); await expect(page.locator('.note-item')).toHaveCount(0);
	await search.fill('is:unknown'); await expect(page.locator('.note-item')).toHaveCount(0); expect(errors).toEqual([]);
});

test('phone formatting toolbar remains reachable and an active composition cannot trigger a formatting transaction', async ({ page }) => {
	await page.setViewportSize({ width: 393, height: 852 }); await open(page); await imported(page, '手机编辑', '文字'); await page.getByRole('tab', { name: '源码', exact: true }).click(); await selectStart(page);
	const source = page.getByRole('textbox', { name: 'Markdown 源码' }); await source.dispatchEvent('compositionstart', { data: '' }); await page.getByRole('button', { name: '加粗', exact: true }).click(); await source.dispatchEvent('compositionend', { data: '' });
	expect(await exported(page)).toBe('文字'); await selectStart(page); await page.getByRole('button', { name: '加粗', exact: true }).click(); expect(await exported(page)).toBe('**文字**');
	await page.getByRole('button', { name: '查找替换', exact: true }).scrollIntoViewIfNeeded(); await page.getByRole('button', { name: '查找替换', exact: true }).click(); await expect(page.locator('.cm-search')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/mobile-formatting.png', fullPage: true });
});
