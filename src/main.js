const { app, BrowserWindow, ipcMain, WebContentsView, session } = require('electron')
const path = require('path')
const bypass = require('./bypass')

const TABBAR = 52
const START_URL = 'file://' + path.join(__dirname, 'ui', 'start.html').replace(/\\/g, '/')
const ENGINE_PORT = 1079

app.commandLine.appendSwitch('disable-quic')

let win = null
let ses = null
let tabs = []
let activeId = null
let seq = 0

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
  win.webContents.send('state', {
    tabs: tabs.map(t => ({
      id: t.id,
      title: t.title || 'Новая вкладка',
      url: t.url || '',
      loading: !!t.loading,
      active: t.id === activeId,
    })),
    engine: bypass.status(),
  })
}

function applyLayout() {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: TABBAR, width: w, height: Math.max(0, h - TABBAR) })
  }
}

function attachEvents(t) {
  const wc = t.view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) newTab(url)
    return { action: 'deny' }
  })
  wc.on('did-start-loading', () => { t.loading = true; sendState() })
  wc.on('did-stop-loading', () => { t.loading = false; sendState() })
  wc.on('page-title-updated', (e, title) => { t.title = title; sendState() })
  wc.on('did-navigate', (e, url) => { t.url = url; sendState() })
  wc.on('did-navigate-in-page', (e, url) => { t.url = url; sendState() })
}

function newTab(url) {
  const id = ++seq
  const view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const t = { id, view, url: url || START_URL, title: '', loading: false }
  tabs.push(t)
  attachEvents(t)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: TABBAR, width: 0, height: 0 })
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
ipcMain.handle('win:min', () => win.minimize())
ipcMain.handle('win:max', () => { win.isMaximized() ? win.unmaximize() : win.maximize() })
ipcMain.handle('win:close', () => win.close())

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
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
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
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
    createWindow()
    newTab()
  })

  app.on('window-all-closed', () => app.quit())
}
