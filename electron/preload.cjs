const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fpsDesktop', Object.freeze({
  openDashboard: () => ipcRenderer.invoke('fps:dashboard'),
  importConfig: () => ipcRenderer.invoke('fps:import'),
}));

// No renderer-provided command, path, URL, or generic IPC channel crosses here.
contextBridge.exposeInMainWorld('fpsShell', Object.freeze({
  status: () => ipcRenderer.invoke('fps-shell:status'),
  restart: () => ipcRenderer.invoke('fps-shell:restart'),
}));
