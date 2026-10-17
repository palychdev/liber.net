const { contextBridge, ipcRenderer } = require('electron')

window.addEventListener('wheel', e => {
  if (!e.ctrlKey) return
  e.preventDefault()
  ipcRenderer.send('zoom-wheel', e.deltaY)
}, { passive: false })

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('liberPage', {
    nav: q => ipcRenderer.invoke('page:nav', q),
    page: name => ipcRenderer.invoke('page', name),
    newTab: url => ipcRenderer.invoke('tab:new', url),
    hist: () => ipcRenderer.invoke('h:list', 500),
    histRemove: url => ipcRenderer.invoke('h:remove', url),
    histClear: () => ipcRenderer.invoke('h:clear'),
    bms: () => ipcRenderer.invoke('b:list'),
    bmRemove: url => ipcRenderer.invoke('b:remove', url),
    bfAdd: name => ipcRenderer.invoke('bf:add', name),
    bfDel: name => ipcRenderer.invoke('bf:del', name),
    bmMove: (url, folder) => ipcRenderer.invoke('b:move', url, folder),
    dls: () => ipcRenderer.invoke('d:list'),
    dlCancel: id => ipcRenderer.invoke('d:cancel', id),
    dlPause: id => ipcRenderer.invoke('d:pause', id),
    dlOpen: id => ipcRenderer.invoke('d:open', id),
    dlReveal: id => ipcRenderer.invoke('d:reveal', id),
    dlRemove: id => ipcRenderer.invoke('d:remove', id),
    dlClear: () => ipcRenderer.invoke('d:clear'),
    stGet: () => ipcRenderer.invoke('st:get'),
    stSet: patch => ipcRenderer.invoke('st:set', patch),
    pickDir: () => ipcRenderer.invoke('st:pickdir'),
    clearData: what => ipcRenderer.invoke('data:clear', what),
    setDefault: () => ipcRenderer.invoke('app:default'),
    openExt: url => ipcRenderer.invoke('open-ext', url),
    impScan: () => ipcRenderer.invoke('imp:scan'),
    impRun: opts => ipcRenderer.invoke('imp:run', opts),
  })
}
