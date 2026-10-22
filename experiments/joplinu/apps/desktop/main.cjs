const { app, BrowserWindow, Menu, net, protocol, session, ipcMain } = require('electron');
const storage = require('./storage.cjs');
let closing = false;
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveAsset } = require('./assets.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'joplinu', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

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
	window.on('close', event => {
		if (closing) return;
		event.preventDefault();
		window.webContents.send('joplinu:close-requested');
	});
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event, url) => {
		if (new URL(url).origin !== new URL('joplinu://app/').origin || !url.startsWith('joplinu://app/')) event.preventDefault();
	});
	window.webContents.on('will-attach-webview', event => event.preventDefault());
	void window.loadURL('joplinu://app/');
	return window;
}

function authorized(event) {
	const sender = event.sender;
	if (sender.isDestroyed() || !sender.getURL().startsWith('joplinu://app/')) throw new Error('Unauthorized storage request');
}
app.whenReady().then(() => {
	ipcMain.handle('joplinu:storage:read', (event, noteId) => { authorized(event); return storage.read(noteId); });
	ipcMain.handle('joplinu:storage:append', (event, noteId, update) => { authorized(event); return storage.append(noteId, update); });
	ipcMain.on('joplinu:ready-to-close', event => {
		authorized(event);
		closing = true;
		BrowserWindow.fromWebContents(event.sender)?.close();
		closing = false;
	});

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

app.on('before-quit', () => storage.closeDatabase());

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
