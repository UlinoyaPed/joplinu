import { _electron as electron, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { root } from './artifacts.mjs';

const executablePath = process.env.JOPLINU_ELECTRON_EXECUTABLE;
const profile = await mkdtemp(join(tmpdir(), 'joplinu-electron-test-'));
const flags = ['--no-sandbox', `--user-data-dir=${profile}`, ...(process.env.JOPLINU_ELECTRON_HEADLESS ? ['--headless', '--ozone-platform=headless', '--disable-gpu'] : [])];
const options = {
	args: executablePath ? flags : [...flags, join(root, 'apps/desktop')],
	...(executablePath ? { executablePath } : {}),
};
let application = await electron.launch(options);
try {
	expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
	const window = await application.firstWindow();
	await expect(window.getByRole('tab', { name: '实时预览', exact: true })).toBeVisible();
	await window.getByRole('tab', { name: '双列', exact: true }).click();
	await expect(window.getByLabel('Markdown 预览').locator('h1')).toContainText('JoplinU');
	const isolation = await window.evaluate(() => ({ require: typeof globalThis.require, node: typeof globalThis.process }));
	expect(isolation).toEqual({ require: 'undefined', node: 'undefined' });
	const cloud = await window.evaluate(() => globalThis.joplinuCloud.info());
	expect(cloud.ok).toBe(true); expect(cloud.value.supported).toBe(true);
	const preferences = await application.evaluate(({ BrowserWindow }) => {
		const { contextIsolation, sandbox, nodeIntegration, webSecurity } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return { contextIsolation, sandbox, nodeIntegration, webSecurity };
	});
	expect(preferences).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
	await window.getByLabel('笔记标题', { exact: true }).fill('SQLite 重启恢复验证');
	await expect(window.locator('footer')).toContainText('已保存到本地 · SQLite');
	await mkdir(join(root, 'test-results'), { recursive: true });
	await window.screenshot({ path: join(root, 'test-results/electron.png') });
	await application.close(); application = await electron.launch(options);
	const reopened = await application.firstWindow();
	await expect(reopened.getByLabel('笔记标题', { exact: true })).toHaveValue('SQLite 重启恢复验证');
	await expect(reopened.locator('footer')).toContainText('已保存到本地 · SQLite');
	await application.close();
	const corrupted = Buffer.from('corrupted SQLite test fixture');
	await writeFile(join(profile, 'joplinu-v2.sqlite'), corrupted);
	application = await electron.launch(options);
	const recovery = await application.firstWindow();
	await expect(recovery.getByRole('heading', { name: '无法打开本地笔记库' })).toBeVisible();
	expect(await readFile(join(profile, 'joplinu-v2.sqlite'))).toEqual(corrupted);
	console.log('Electron isolation, SQLite restart recovery and non-destructive corrupt-database startup verified');
} finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
