const { contextBridge, ipcRenderer } = require('electron')

window.addEventListener('wheel', e => {
  if (!e.ctrlKey) return
  e.preventDefault()
  ipcRenderer.send('zoom-wheel', e.deltaY)
}, { passive: false })

if (location.protocol === 'https:' || location.protocol === 'http:') {
  const filled = new WeakSet()
  const fire = el => el.dispatchEvent(new Event('input', { bubbles: true }))
  const fill = async () => {
    const pw = document.querySelector('input[type=password]')
    if (!pw || filled.has(pw)) return
    let cred = null
    try { cred = await ipcRenderer.invoke('pw:get', location.host) } catch (_) {}
    if (!cred) return
    filled.add(pw)
    const scope = pw.form || document
    const user = [...scope.querySelectorAll('input')].find(i => i !== pw && /^(text|email|tel)$/i.test(i.type || ''))
    if (user && !user.value) { user.value = cred.user || ''; fire(user) }
    if (!pw.value) { pw.value = cred.pass || ''; fire(pw) }
  }
  document.addEventListener('focusin', e => {
    const t = e.target
    if (t && t.type === 'password') fill()
  }, true)
  document.addEventListener('submit', e => {
    const f = e.target
    if (!f || !f.querySelector) return
    const pw = f.querySelector('input[type=password]')
    if (!pw || !pw.value) return
    const user = [...f.querySelectorAll('input')].find(i => i !== pw && /^(text|email|tel)$/i.test(i.type || ''))
    ipcRenderer.send('pw:capture', { host: location.host, user: user ? user.value : '', pass: pw.value })
  }, true)
}

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
    pwList: () => ipcRenderer.invoke('pw:list'),
    pwDel: (host, user) => ipcRenderer.invoke('pw:del', host, user),
  })
}
