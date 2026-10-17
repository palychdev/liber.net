const { app, BrowserWindow, ipcMain, WebContentsView, session } = require('electron')
const path = require('path')
const fs = require('fs')
const bypass = require('./bypass')
const storage = require('./storage')

const BAR_H = 52
const OMNI_H = 44
const BM_H = 34
const START_URL = 'file://' + path.join(__dirname, 'ui', 'start.html').replace(/\\/g, '/')
const ERR_URL = 'file://' + path.join(__dirname, 'ui', 'err.html').replace(/\\/g, '/')
const ENGINE_PORT = 1079
const ZOOM_STEPS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

app.commandLine.appendSwitch('disable-quic')

let win = null
let ses = null
let tabs = []
let activeId = null
let seq = 0
let expanded = false
let dlsActive = 0
const data = storage.load()

function bmOn() {
  return data.bookmarks.length > 0
}

function chromeH() {
  return BAR_H + OMNI_H + (bmOn() ? BM_H : 0) + (expanded ? 160 : 0)
}

function bmIndex(url) {
  return data.bookmarks.findIndex(b => b.url === url)
}

function activeTab() {
  return tabs.find(t => t.id === activeId)
}

function toUrl(q) {
  const s = (q || '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s) || /^file:/i.test(s)) return s
  if (/^[a-z0-9.-]+\.[a-z]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/i.test(s)) return 'https://' + s
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s)
}

function applyProxy(on) {
  if (!ses) return
  try {
    if (on) ses.setProxy({ proxyRules: `socks5://127.0.0.1:${ENGINE_PORT}`, proxyBypassRules: '<local>' })
    else ses.setProxy({})
  } catch (_) {}
}

function sendState() {
  if (!win || win.isDestroyed()) return
  const a = activeTab()
  win.webContents.send('state', {
    tabs: tabs.map(t => ({
      id: t.id,
      title: t.title || 'Новая вкладка',
      url: t.url || '',
      loading: !!t.loading,
      favicon: t.favicon || '',
      active: t.id === activeId,
    })),
    engine: bypass.status(),
    dls: dlsActive,
    isBm: !!(a && a.url && /^https?:/i.test(a.url) && bmIndex(a.url) >= 0),
  })
}

function sendBm() {
  if (win && !win.isDestroyed()) win.webContents.send('bm', data.bookmarks)
}

function persist() {
  data.tabs = tabs.map(t => (/^https?:/i.test(t.url) ? t.url : null)).filter(Boolean)
  if (win && !win.isDestroyed() && !win.isMaximized()) {
    const b = win.getBounds()
    data.window = { x: b.x, y: b.y, width: b.width, height: b.height }
  }
  storage.save(data)
}

function applyLayout() {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  const top = chromeH()
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) })
  }}

function recordHistory(url, title) {
  if (!/^https?:/i.test(url)) return
  data.history = data.history.filter(x => x.url !== url)
  data.history.unshift({ url, title: title || url, date: Date.now() })
  if (data.history.length > 1000) data.history.length = 1000
  storage.save(data)
}

function handleKeys(wc, event, input) {
  if (input.type !== 'keyDown' || !input.control) return false
  const k = input.key.toLowerCase()
  if (input.shift) {
    if (k === 'o') { newTab('file://' + path.join(__dirname, 'ui', 'bms.html').replace(/\\/g, '/')); event.preventDefault(); return true }
    if (k === 'i') { wc.toggleDevTools(); event.preventDefault(); return true }
    return false
  }
  if (k === 't') { newTab(); event.preventDefault(); return true }
  if (k === 'w') { closeTab(activeId); event.preventDefault(); return true }
  if (k === 'l') { win.webContents.send('focus-omni'); win.webContents.focus(); event.preventDefault(); return true }
  if (k === 'f') { win.webContents.send('find-omni'); win.webContents.focus(); event.preventDefault(); return true }
  if (k === 'h') { newTab('file://' + path.join(__dirname, 'ui', 'hist.html').replace(/\\/g, '/')); event.preventDefault(); return true }
  if (k === 'd') {
    const a = activeTab()
    if (a && a.url && /^https?:/i.test(a.url)) { toggleBm(a.url, a.title) }
    event.preventDefault(); return true
  }
  if (k === 'r' || input.key === 'F5') { wc.reload(); event.preventDefault(); return true }
  if (k === '+' || k === '=') { zoomBy(wc, 1); event.preventDefault(); return true }
  if (k === '-') { zoomBy(wc, -1); event.preventDefault(); return true }
  if (k === '0') { wc.setZoomFactor(1); event.preventDefault(); return true }
  return false
}

function zoomBy(wc, dir) {
  const cur = wc.getZoomFactor()
  let i = ZOOM_STEPS.findIndex(s => s >= cur)
  if (i < 0) i = ZOOM_STEPS.length - 1
  if (dir > 0 && Math.abs(ZOOM_STEPS[i] - cur) > 0.01) i = i - 1
  i = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))
  wc.setZoomFactor(ZOOM_STEPS[i])
}

function attachEvents(t) {
  const wc = t.view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) newTab(url)
    return { action: 'deny' }
  })
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && handleKeys(wc, e, input)) e.preventDefault()
  })
  wc.on('did-start-loading', () => { t.loading = true; sendState() })
  wc.on('did-stop-loading', () => { t.loading = false; sendState() })
  wc.on('page-title-updated', (e, title) => { t.title = title; if (!t.loading) recordHistory(t.url, title); sendState() })
  wc.on('did-navigate', (e, url) => { t.url = url; if (!t.loading) recordHistory(url, t.title); sendState() })
  wc.on('did-navigate-in-page', (e, url) => { t.url = url; sendState() })
  wc.on('page-favicon-updated', (e, favs) => { t.favicon = (favs && favs[0]) ? favs[0].url : ''; sendState() })
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || !/^https?:/i.test(url)) return
    t.url = ERR_URL + '?u=' + encodeURIComponent(url) + '&c=' + code
    wc.loadURL(t.url).catch(() => {})
    sendState()
  })
  wc.on('found-in-page', (e, res) => {
    win.webContents.send('findres', { count: res.matches, active: res.activeMatchOrdinal })
  })
  wc.on('did-finish-load', () => { if (t.url && /^https?:/i.test(t.url)) recordHistory(t.url, t.title) })
}

function internalPage(name) {
  const safe = name === 'hist' ? 'hist' : name === 'bms' ? 'bms' : 'start'
  return 'file://' + path.join(__dirname, 'ui', safe + '.html').replace(/\\/g, '/')
}

function newTab(url) {
  const id = ++seq
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'content-preload.js'),
    },
  })
  const t = { id, view, url: url || START_URL, title: '', loading: false, favicon: '' }
  tabs.push(t)
  attachEvents(t)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: chromeH(), width: 0, height: 0 })
  view.webContents.loadURL(t.url)
  activeId = id
  applyLayout()
  view.webContents.focus()
  sendState()
  return id
}

function switchTab(id) {
  const prev = tabs.find(t => t.id === activeId)
  const next = tabs.find(t => t.id === id)
  if (!next || prev === next) return
  if (prev) win.contentView.removeChildView(prev.view)
  win.contentView.addChildView(next.view)
  activeId = id
  applyLayout()
  next.view.webContents.focus()
  sendState()
}

function closeTab(id) {
  const t = tabs.find(x => x.id === id)
  if (!t) return
  tabs = tabs.filter(x => x.id !== id)
  win.contentView.removeChildView(t.view)
  t.view.webContents.close()
  if (!tabs.length) { win.close(); return }
  if (activeId === id) {
    const n = tabs[tabs.length - 1]
    win.contentView.addChildView(n.view)
    activeId = n.id
    applyLayout()
    n.view.webContents.focus()
  }
  sendState()
}

function toggleBm(url, title) {
  const i = bmIndex(url)
  if (i >= 0) data.bookmarks.splice(i, 1)
  else data.bookmarks.unshift({ url, title: title || url, date: Date.now() })
  storage.save(data)
  sendBm()
  applyLayout()
  sendState()
}

function uniquePath(dir, name) {
  const safe = (name || 'download').replace(/[\\/:*?"<>|]/g, '_')
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let f = path.join(dir, safe)
  let n = 0
  while (fs.existsSync(f)) {
    n += 1
    f = path.join(dir, `${stem} (${n})${ext}`)
  }
  return f
}

ipcMain.handle('tab:new', (e, url) => { newTab(toUrl(url) || START_URL) })
ipcMain.handle('tab:switch', (e, id) => switchTab(id))
ipcMain.handle('tab:close', (e, id) => closeTab(id))
ipcMain.handle('tab:nav', (e, { id, input }) => {
  const u = toUrl(input)
  const t = tabs.find(x => x.id === id)
  if (u && t) t.view.webContents.loadURL(u)
})
ipcMain.handle('tab:back', (e, id) => {
  const t = tabs.find(x => x.id === id)
  if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.goBack()
})
ipcMain.handle('tab:reload', (e, id) => {
  const t = tabs.find(x => x.id === id)
  if (t) t.view.webContents.reload()
})
ipcMain.handle('page', (e, name) => newTab(internalPage(name)))
ipcMain.handle('zoom', (e, { id, d }) => {
  const t = tabs.find(x => x.id === id)
  if (!t) return
  if (d === 0) t.view.webContents.setZoomFactor(1)
  else zoomBy(t.view.webContents, d)
})
ipcMain.handle('find', (e, { id, q, nx }) => {
  const t = tabs.find(x => x.id === id)
  if (!t) return
  if (!q) return t.view.webContents.stopFindInPage('clearSelection')
  t.view.webContents.findInPage(q, { findNext: !!nx })
})
ipcMain.handle('find:stop', (e, id) => {
  const t = tabs.find(x => x.id === id)
  if (t) t.view.webContents.stopFindInPage('clearSelection')
})
ipcMain.handle('bm:toggle', (e, url, title) => { toggleBm(url, title) })
ipcMain.handle('chrome', (e, on) => { expanded = !!on; applyLayout() })
ipcMain.handle('b:list', () => data.bookmarks)
ipcMain.handle('b:remove', (e, url) => {
  const i = bmIndex(url)
  if (i >= 0) { data.bookmarks.splice(i, 1); storage.save(data); sendBm(); applyLayout(); sendState() }
})
ipcMain.handle('h:list', (e, n) => data.history.slice(0, n))
ipcMain.handle('h:remove', (e, url) => {
  data.history = data.history.filter(x => x.url !== url)
  storage.save(data)
})
ipcMain.handle('h:clear', () => {
  data.history = []
  storage.save(data)
})
ipcMain.handle('suggest', (e, q) => {
  const s = (q || '').trim().toLowerCase()
  if (s.length < 2) return []
  const seen = new Set()
  const out = []
  for (const kind of ['bookmarks', 'history']) {
    for (const it of data[kind]) {
      const hay = (it.url + ' ' + it.title).toLowerCase()
      if (!hay.includes(s) || seen.has(it.url)) continue
      seen.add(it.url)
      out.push({ url: it.url, title: it.title, bm: kind === 'bookmarks' })
      if (out.length >= 8) break
    }
    if (out.length >= 8) break
  }
  return out
})
ipcMain.handle('win:min', () => win.minimize())
ipcMain.handle('win:max', () => { win.isMaximized() ? win.unmaximize() : win.maximize() })
ipcMain.handle('win:close', () => win.close())

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    ses = session.fromPartition('persist:liber')
    applyProxy(false)
    bypass.start(on => applyProxy(on))
    ses.on('will-download', (e, item) => {
      const f = uniquePath(app.getPath('downloads'), item.getFilename())
      item.setSavePath(f)
      dlsActive += 1
      sendState()
      item.once('done', (i, state) => {
        dlsActive = Math.max(0, dlsActive - 1)
        sendState()
      })
    })
    const w = data.window && Number.isInteger(data.window.width) ? data.window : {}
    win = new BrowserWindow({
      width: w.width || 1280,
      height: w.height || 840,
      x: w.x,
      y: w.y,
      minWidth: 920,
      minHeight: 600,
      frame: false,
      backgroundColor: '#0b0c10',
      show: false,
      title: 'Liber',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    win.setMenuBarVisibility(false)
    win.once('ready-to-show', () => win.show())
    win.on('resize', applyLayout)
    win.on('maximize', sendState)
    win.on('unmaximize', sendState)
    win.on('close', persist)
    win.webContents.on('did-finish-load', () => { sendBm(); sendState() })
    win.loadFile(path.join(__dirname, 'ui', 'index.html'))
    for (const u of data.tabs.length ? data.tabs : [null]) newTab(u)
  })

  app.on('window-all-closed', () => app.quit())
}
