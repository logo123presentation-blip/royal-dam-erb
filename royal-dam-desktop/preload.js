const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  get: k => ipcRenderer.invoke('store:get', k),
  set: (k, v) => ipcRenderer.invoke('store:set', k, v),
  remove: k => ipcRenderer.invoke('store:delete', k),
  config: () => ipcRenderer.invoke('config:get'),
  setApi: v => ipcRenderer.invoke('config:setApi', v),
  openExternal: url => ipcRenderer.invoke('shell:openExternal', url),
  saveFile: options => ipcRenderer.invoke('file:save', options),
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onState: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('updates:state', listener); return () => ipcRenderer.removeListener('updates:state', listener); }
  },
  getPrinters: () => ipcRenderer.invoke('app:getPrinters'),
  print: (options) => ipcRenderer.invoke('app:print', options),
  printToPDF: (options) => ipcRenderer.invoke('app:printToPDF', options),
  openPDF: (options) => ipcRenderer.invoke('app:openPDF', options)
});
