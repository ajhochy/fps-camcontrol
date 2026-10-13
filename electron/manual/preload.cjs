const { contextBridge, ipcRenderer } = require('electron');
// No renderer-supplied path, command, URL or message object crosses this boundary.
contextBridge.exposeInMainWorld('fpsDesktop', Object.freeze({
  openDashboard: () => ipcRenderer.invoke('fps:dashboard'),
  importConfig: () => ipcRenderer.invoke('fps:import'),
}));
