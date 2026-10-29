const { app, BrowserWindow, Menu, net, protocol, session, ipcMain, safeStorage } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset } = require('./assets.cjs');
const { VaultDatabase } = require('./database.cjs');
const { CloudHost } = require('./cloud.bundle.cjs');
const { mkdirSync } = require('node:fs');

protocol.registerSchemesAsPrivileged([{ scheme: 'joplinu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function createWindow() {
	const window = new BrowserWindow({
		width: 1280,
		height: 900,
		minWidth: 720,
		minHeight: 500,
		title: 'JoplinU',
		backgroundColor: '#f1f5f1',
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: join(__dirname, 'preload.cjs') },
	});
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event, url) => {
		if (new URL(url).origin !== new URL('joplinu://app/').origin || !url.startsWith('joplinu://app/')) event.preventDefault();
	});
	window.webContents.on('will-attach-webview', event => event.preventDefault());
	void window.loadURL('joplinu://app/');
	return window;
}

app.whenReady().then(() => {
	// Test profiles are isolated through Electron's standard --user-data-dir switch.
	let database;
	try {
		mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
		database = new VaultDatabase(join(app.getPath('userData'), 'joplinu-v2.sqlite'));
	} catch { /* Open the recovery UI without replacing an unreadable database. */ }
	const trusted = event => event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith('joplinu://app/');
	const cloud = new CloudHost(app.getPath('userData'), safeStorage, !app.isPackaged);
	for (const method of ['info', 'configure', 'probe', 'request', 'clear', 'openTarget', 'closeTarget']) ipcMain.handle(`joplinu:cloud:${method}`, async (event, input) => {
		if (!trusted(event)) throw new Error('Untrusted cloud storage caller');
		return cloud.invoke(method, input);
	});
	for (const method of ['read', 'write', 'check']) ipcMain.handle(`joplinu:database:${method}`, (event, input) => {
		if (!trusted(event)) throw new Error('Untrusted local database caller');
		if (!database) throw new Error('无法打开本地 SQLite；原数据未重置，请保留应用数据目录以便恢复。');
		return database[method](input);
	});
	app.once('will-quit', () => { database?.close(); cloud.close(); });
	const root = app.isPackaged ? join(process.resourcesPath, 'web') : resolve(__dirname, '../../dist');
	protocol.handle('joplinu', async request => {
		const file = resolveAsset(root, request.url);
		if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
		try { return await net.fetch(pathToFileURL(file).toString()); }
		catch { return new Response(null, { status: 404 }); }
	});
	session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
		responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy] },
	}));
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{ label: 'JoplinU', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
		{ role: 'editMenu' },
		{ role: 'viewMenu' },
		{ role: 'windowMenu' },
	]));
	createWindow();
	app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
