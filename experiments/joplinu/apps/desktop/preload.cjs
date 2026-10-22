const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('joplinuDesktop', Object.freeze({
	read: noteId => ipcRenderer.invoke('joplinu:storage:read', noteId),
	append: (noteId, update) => ipcRenderer.invoke('joplinu:storage:append', noteId, update),
	onCloseRequested(callback) {
		const listener = () => callback();
		ipcRenderer.on('joplinu:close-requested', listener);
		return () => ipcRenderer.removeListener('joplinu:close-requested', listener);
	},
	readyToClose: () => ipcRenderer.send('joplinu:ready-to-close'),
}));
