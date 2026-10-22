import { _electron as electron, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { root } from './artifacts.mjs';

const executablePath = process.env.JOPLINU_ELECTRON_EXECUTABLE;
const flags = ['--no-sandbox', ...(process.env.JOPLINU_ELECTRON_HEADLESS ? ['--headless', '--ozone-platform=headless', '--disable-gpu'] : [])];
const application = await electron.launch({
	args: executablePath ? flags : [...flags, join(root, 'apps/desktop')],
	...(executablePath ? { executablePath } : {}),
});
try {
	const window = await application.firstWindow();
	await expect(window.getByRole('tab', { name: '实时预览', exact: true })).toBeVisible();
	await window.getByRole('tab', { name: '双列', exact: true }).click();
	await expect(window.getByLabel('Markdown 预览').locator('h1')).toContainText('JoplinU');
	const isolation = await window.evaluate(() => ({ require: typeof globalThis.require, node: typeof globalThis.process }));
	expect(isolation).toEqual({ require: 'undefined', node: 'undefined' });
	const preferences = await application.evaluate(({ BrowserWindow }) => {
		const { contextIsolation, sandbox, nodeIntegration, webSecurity } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return { contextIsolation, sandbox, nodeIntegration, webSecurity };
	});
	expect(preferences).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
	await mkdir(join(root, 'test-results'), { recursive: true });
	await window.screenshot({ path: join(root, 'test-results/electron.png') });
	console.log('Electron window, packaged assets and renderer isolation verified');
} finally { await application.close(); }
