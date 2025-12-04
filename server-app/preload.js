const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openUploadsFolder: () => ipcRenderer.invoke('open-uploads-folder'),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  onServerLog: (callback) => ipcRenderer.on('server-log', (event, data) => callback(data)),
  onServerError: (callback) => ipcRenderer.on('server-error', (event, data) => callback(data))
});
