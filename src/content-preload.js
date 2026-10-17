const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('liberPage', {
    hist: () => ipcRenderer.invoke('h:list', 200),
    histRemove: url => ipcRenderer.invoke('h:remove', url),
    histClear: () => ipcRenderer.invoke('h:clear'),
    bms: () => ipcRenderer.invoke('b:list'),
    bmRemove: url => ipcRenderer.invoke('b:remove', url),
  })
}
