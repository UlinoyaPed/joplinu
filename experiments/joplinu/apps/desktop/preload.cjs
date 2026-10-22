const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('joplinuDatabase', {
	read: () => ipcRenderer.invoke('joplinu:database:read'),
	write: input => ipcRenderer.invoke('joplinu:database:write', { expectedRevision: input.expectedRevision, payload: input.payload }),
	check: () => ipcRenderer.invoke('joplinu:database:check'),
});
