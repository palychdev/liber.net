const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('liber', {
  state: cb => ipcRenderer.on('state', (e, s) => cb(s)),
  onBm: cb => ipcRenderer.on('bm', (e, l) => cb(l)),
  onOmni: cb => ipcRenderer.on('focus-omni', cb),
  onFind: cb => ipcRenderer.on('find-omni', cb),
  onFindRes: cb => ipcRenderer.on('findres', (e, r) => cb(r)),
  onHideSug: cb => ipcRenderer.on('hide-sug', cb),
  newTab: url => ipcRenderer.invoke('tab:new', url || null),
  switchTab: id => ipcRenderer.invoke('tab:switch', id),
  closeTab: id => ipcRenderer.invoke('tab:close', id),
  go: (id, input) => ipcRenderer.invoke('tab:nav', { id, input }),
  back: id => ipcRenderer.invoke('tab:back', id),
  reload: id => ipcRenderer.invoke('tab:reload', id),
  page: name => ipcRenderer.invoke('page', name),
  suggest: q => ipcRenderer.invoke('suggest', q),
  zoom: (id, d) => ipcRenderer.invoke('zoom', { id, d }),
  find: (id, q, nx) => ipcRenderer.invoke('find', { id, q, nx }),
  findStop: id => ipcRenderer.invoke('find:stop', id),
  bmToggle: (url, title) => ipcRenderer.invoke('bm:toggle', url, title),
  chrome: on => ipcRenderer.invoke('chrome', on),
  call: m => ipcRenderer.invoke('win:' + m),
})
