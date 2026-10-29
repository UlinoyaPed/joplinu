const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('joplinuCloud', Object.fromEntries(['info', 'configure', 'probe', 'request', 'clear', 'openTarget', 'closeTarget'].map(method => [method, input => ipcRenderer.invoke(`joplinu:cloud:${method}`, input)])));
contextBridge.exposeInMainWorld('joplinuDatabase', {
	read: () => ipcRenderer.invoke('joplinu:database:read'),
	write: input => ipcRenderer.invoke('joplinu:database:write', { expectedRevision: input.expectedRevision, payload: input.payload, journal: input.journal }),
	check: () => ipcRenderer.invoke('joplinu:database:check'),
});
