const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('liber', {
  state: cb => ipcRenderer.on('state', (e, s) => cb(s)),
  newTab: url => ipcRenderer.invoke('tab:new', url || null),
  switchTab: id => ipcRenderer.invoke('tab:switch', id),
  closeTab: id => ipcRenderer.invoke('tab:close', id),
  go: (id, input) => ipcRenderer.invoke('tab:nav', { id, input }),
  back: id => ipcRenderer.invoke('tab:back', id),
  call: m => ipcRenderer.invoke('win:' + m),
})
