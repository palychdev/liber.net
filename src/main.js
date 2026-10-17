const { app, BrowserWindow, ipcMain, WebContentsView, session, Menu, clipboard, desktopCapturer, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const bypass = require('./bypass')
const storage = require('./storage')

const BAR_H = 52
const OMNI_H = 44
const BM_H = 34
const SUG_H = 160
const ENGINE_PORT = 1079
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const ENGINES = {
  ddg: { label: 'duckduckgo', url: 'https://duckduckgo.com/?q=%s' },
  google: { label: 'google', url: 'https://www.google.com/search?q=%s' },
  yandex: { label: 'яндекс', url: 'https://yandex.ru/search/?text=%s' },
  bing: { label: 'bing', url: 'https://www.bing.com/search?q=%s' },
}
const PAGES = ['start', 'hist', 'bms', 'settings', 'dls']
const START_URL = 'file://' + path.join(__dirname, 'ui', 'start.html').replace(/\\/g, '/')
const ERR_URL = 'file://' + path.join(__dirname, 'ui', 'err.html').replace(/\\/g, '/')

app.commandLine.appendSwitch('disable-quic')

let win = null
let ses = null
let tabs = []
let activeId = null
let seq = 0
let expanded = false
let vidFs = false
const closedTabs = []
const data = storage.load()
const settings = Object.assign({ search: 'ddg', homepage: '', downloadDir: '', bmBar: true, restore: true, zoom: {} }, data.settings || {})
data.settings = settings
const dls = []
const dlItems = new Map()
let dlSeq = 0
let dlsTick = 0

for (const d of (data.downloads || []).slice(0, 50)) {
  dls.push(d)
  dlSeq = Math.max(dlSeq, d.id || 0)
}

function engine() {
  return ENGINES[settings.search] || ENGINES.ddg
}

function bmVisible() {
  return data.bookmarks.length > 0 && settings.bmBar
}

function chromeH() {
  if (vidFs) return 0
  return BAR_H + OMNI_H + (bmVisible() ? BM_H : 0) + (expanded ? SUG_H : 0)
}

function bmIndex(url) {
  return data.bookmarks.findIndex(b => b.url === url)
}

function activeTab() {
  return tabs.find(t => t.id === activeId)
}

function tabById(id) {
  return tabs.find(t => t.id === id)
}

function wcToTab(wc) {
  return tabs.find(t => t.view.webContents.id === wc.id)
}

function toUrl(q) {
  const s = (q || '').trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return 'https://' + s
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s)) return 'http://' + s
  return engine().url.replace('%s', encodeURIComponent(s))
}

function applyProxy(on) {
  if (!ses) return
  try {
    if (on) ses.setProxy({ proxyRules: `socks5://127.0.0.1:${ENGINE_PORT}`, proxyBypassRules: '<local>' })
    else ses.setProxy({})
  } catch (_) {}
}

function dlDirOf() {
  return settings.downloadDir && fs.existsSync(settings.downloadDir) ? settings.downloadDir : app.getPath('downloads')
}

function persistDls() {
  data.downloads = dls.slice(0, 50)
  storage.save(data)
}

function sendDls() {
  if (win && !win.isDestroyed()) win.webContents.send('dls', dls)
}

function sendSettings() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings', { bmBar: settings.bmBar, search: settings.search, homepage: settings.homepage })
  }
}

function sendState() {
  if (!win || win.isDestroyed()) return
  const a = activeTab()
  const act = dls.filter(d => d.state === 'progressing' || d.state === 'paused')
  let zoom = 100
  let muted = false
  let audible = false
  if (a) {
    try {
      zoom = Math.round(a.view.webContents.getZoomFactor() * 100)
      muted = a.view.webContents.isAudioMuted()
      audible = a.view.webContents.isCurrentlyAudible()
    } catch (_) {}
  }
  win.webContents.send('state', {
    tabs: tabs.map(t => {
      let tm = false
      let ta = false
      try {
        tm = t.view.webContents.isAudioMuted()
        ta = t.view.webContents.isCurrentlyAudible()
      } catch (_) {}
      return {
        id: t.id,
        title: t.title || 'Новая вкладка',
        url: t.url || '',
        loading: !!t.loading,
        favicon: t.favicon || '',
        active: t.id === activeId,
        muted: tm,
        audible: ta && !tm,
      }
    }),
    engine: bypass.status(),
    dls: act.length,
    dlsName: act.length ? act[0].name : '',
    dlsPct: act.length && act[0].total > 0 ? Math.round((act[0].received / act[0].total) * 100) : 0,
    zoom,
    fs: win.isFullScreen(),
    muted,
    audible,
    isBm: !!(a && a.url && /^https?:/i.test(a.url) && bmIndex(a.url) >= 0),
  })
  if (a && a.title) win.setTitle(a.title + ' — Liber')
  else win.setTitle('Liber')
}

function sendBm() {
  if (win && !win.isDestroyed()) win.webContents.send('bm', data.bookmarks)
}

function persist() {
  data.tabs = tabs.map(t => (/^https?:/i.test(t.url) ? t.url : null)).filter(Boolean)
  if (win && !win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) {
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
  }
}

function recordHistory(url, title) {
  if (!/^https?:/i.test(url)) return
  data.history = data.history.filter(x => x.url !== url)
  data.history.unshift({ url, title: title || url, date: Date.now() })
  if (data.history.length > 1000) data.history.length = 1000
  storage.save(data)
}

function applySettings(patch) {
  if (!patch || typeof patch !== 'object') return
  if (typeof patch.search === 'string' && ENGINES[patch.search]) settings.search = patch.search
  if (typeof patch.homepage === 'string') settings.homepage = patch.homepage.trim()
  if (typeof patch.downloadDir === 'string') settings.downloadDir = patch.downloadDir
  if (typeof patch.bmBar === 'boolean') settings.bmBar = patch.bmBar
  if (typeof patch.restore === 'boolean') settings.restore = patch.restore
  data.settings = settings
  storage.save(data)
  sendSettings()
  applyLayout()
}

function siteHostOf(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.host : ''
  } catch (_) {
    return ''
  }
}

function setZoom(wc, factor) {
  try {
    wc.setZoomFactor(factor)
  } catch (_) {
    return
  }
  const host = siteHostOf(wc.getURL())
  if (host) {
    if (Math.abs(factor - 1) < 0.01) delete settings.zoom[host]
    else settings.zoom[host] = factor
    storage.save(data)
  }
  sendState()
}

function zoomBy(wc, dir) {
  const cur = wc.getZoomFactor()
  let i = ZOOM_STEPS.findIndex(s => s >= cur - 0.001)
  if (i < 0) i = ZOOM_STEPS.length - 1
  if (dir > 0 && Math.abs(ZOOM_STEPS[i] - cur) > 0.01) i -= 1
  i = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))
  setZoom(wc, ZOOM_STEPS[i])
}

function applySiteZoom(wc, url) {
  const host = siteHostOf(url)
  const z = host ? settings.zoom[host] : null
  try {
    wc.setZoomFactor(z && Math.abs(z - 1) > 0.01 ? z : 1)
  } catch (_) {}
}

function focusOmni() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('focus-omni')
  win.webContents.focus()
}

function navHome(wc) {
  wc.loadURL(settings.homepage || START_URL).catch(() => {})
}

function switchRelative(dir) {
  if (tabs.length < 2) return
  const i = tabs.findIndex(t => t.id === activeId)
  if (i < 0) return
  const n = (i + dir + tabs.length) % tabs.length
  switchTab(tabs[n].id)
}

function reopenClosed() {
  const last = closedTabs.pop()
  if (last) newTab(last.url)
}

function sourceOf(wc) {
  const u = wc.getURL()
  if (/^https?:/i.test(u)) newTab('view-source:' + u)
}

function printOf(wc) {
  try {
    wc.print({})
  } catch (_) {}
}

async function savePageOf(wc, t) {
  const title = ((t && t.title) || 'page').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'page'
  let filePath = null
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'сохранить страницу',
      defaultPath: path.join(dlDirOf(), title + '.html'),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (res.canceled || !res.filePath) return
    filePath = res.filePath
  } catch (_) {
    return
  }
  try {
    await wc.savePage(filePath, 'HTMLComplete')
  } catch (_) {
    return
  }
  dls.unshift({ id: ++dlSeq, name: path.basename(filePath), path: filePath, url: wc.getURL(), state: 'completed', received: 0, total: 0, date: Date.now(), saved: true })
  persistDls()
  sendDls()
  sendState()
}

function handleKeys(wc, event, input) {
  if (input.type !== 'keyDown') return false
  const key = input.key
  const k = key.length === 1 ? key.toLowerCase() : key
  if (input.alt && !input.control) {
    if (key === 'ArrowLeft' || key === 'Left') { if (wc.navigationHistory.canGoBack()) wc.goBack(); event.preventDefault(); return true }
    if (key === 'ArrowRight' || key === 'Right') { if (wc.navigationHistory.canGoForward()) wc.goForward(); event.preventDefault(); return true }
    if (key === 'Home') { navHome(wc); event.preventDefault(); return true }
    return false
  }
  if (!input.control) {
    if (key === 'F5') { wc.reload(); event.preventDefault(); return true }
    if (key === 'F6') { focusOmni(); event.preventDefault(); return true }
    if (key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); return true }
    if (key === 'Escape' && wc.isLoading()) { wc.stop(); event.preventDefault(); return true }
    return false
  }
  if (input.shift) {
    if (k === 'o') { newTab(internalPage('bms')); event.preventDefault(); return true }
    if (k === 'i') { wc.toggleDevTools(); event.preventDefault(); return true }
    if (k === 't') { reopenClosed(); event.preventDefault(); return true }
    if (k === 'b') { applySettings({ bmBar: !settings.bmBar }); event.preventDefault(); return true }
    if (k === 'Tab') { switchRelative(-1); event.preventDefault(); return true }
    if (k === 'Delete') { newTab(internalPage('settings')); event.preventDefault(); return true }
    if (k === '+' || k === '=') { zoomBy(wc, 1); event.preventDefault(); return true }
    if (k === '-') { zoomBy(wc, -1); event.preventDefault(); return true }
    return false
  }
  if (k === 'Tab') { switchRelative(1); event.preventDefault(); return true }
  if (k === 't') { newTab(); event.preventDefault(); return true }
  if (k === 'w') { closeTab(activeId); event.preventDefault(); return true }
  if (k === 'l') { focusOmni(); event.preventDefault(); return true }
  if (k === 'f') { win.webContents.send('find-omni'); win.webContents.focus(); event.preventDefault(); return true }
  if (k === 'h') { newTab(internalPage('hist')); event.preventDefault(); return true }
  if (k === 'j') { newTab(internalPage('dls')); event.preventDefault(); return true }
  if (k === 'u') { sourceOf(wc); event.preventDefault(); return true }
  if (k === 's') { const t = wcToTab(wc); savePageOf(wc, t); event.preventDefault(); return true }
  if (k === 'p') { printOf(wc); event.preventDefault(); return true }
  if (/^[1-8]$/.test(key)) { const t = tabs[Number(key) - 1]; if (t) switchTab(t.id); event.preventDefault(); return true }
  if (key === '9') { if (tabs.length) switchTab(tabs[tabs.length - 1].id); event.preventDefault(); return true }
  if (k === 'd') {
    const a = activeTab()
    if (a && a.url && /^https?:/i.test(a.url)) toggleBm(a.url, a.title)
    event.preventDefault(); return true
  }
  if (k === 'r') { wc.reload(); event.preventDefault(); return true }
  if (k === '+' || k === '=') { zoomBy(wc, 1); event.preventDefault(); return true }
  if (k === '-') { zoomBy(wc, -1); event.preventDefault(); return true }
  if (k === '0') { setZoom(wc, 1); event.preventDefault(); return true }
  return false
}

function contextMenu(wc, p) {
  const items = []
  if (p.misspelledWord) {
    for (const s of (p.dictionarySuggestions || []).slice(0, 5)) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    }
    items.push({ type: 'separator' })
    items.push({ label: 'добавить в словарь', click: () => { try { ses.addWordToSpellCheckerDictionary(p.misspelledWord) } catch (_) {} } })
    items.push({ type: 'separator' })
  }
  if (p.linkURL) {
    items.push({ label: 'открыть в новой вкладке', click: () => newTab(p.linkURL) })
    items.push({ label: 'сохранить ссылку как', click: () => { try { wc.downloadURL(p.linkURL) } catch (_) {} } })
    items.push({ label: 'копировать ссылку', click: () => clipboard.writeText(p.linkURL) })
    items.push({ type: 'separator' })
  }
  if (p.isEditable) {
    items.push({ label: 'вырезать', role: 'cut', enabled: p.editFlags.canCut })
    items.push({ label: 'копировать', role: 'copy', enabled: p.editFlags.canCopy })
    items.push({ label: 'вставить', role: 'paste', enabled: p.editFlags.canPaste })
    items.push({ label: 'выделить всё', role: 'selectAll' })
    items.push({ type: 'separator' })
  } else if (p.selectionText) {
    items.push({ label: 'копировать', role: 'copy' })
    const sel = p.selectionText.trim().slice(0, 60)
    if (sel) items.push({ label: 'искать «' + sel + '» в ' + engine().label, click: () => newTab(engine().url.replace('%s', encodeURIComponent(sel))) })
    items.push({ type: 'separator' })
  }
  if (p.mediaType === 'image') {
    items.push({ label: 'открыть картинку в новой вкладке', click: () => { if (p.srcURL) newTab(p.srcURL) } })
    items.push({ label: 'сохранить картинку как', click: () => { try { wc.downloadURL(p.srcURL) } catch (_) {} } })
    items.push({ label: 'копировать картинку', click: () => wc.copyImageAt(p.x, p.y) })
    items.push({ type: 'separator' })
  }
  items.push({ label: 'назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.goBack() })
  items.push({ label: 'вперёд', enabled: wc.navigationHistory.canGoForward(), click: () => wc.goForward() })
  items.push({ label: 'обновить', click: () => wc.reload() })
  items.push({ type: 'separator' })
  const u = wc.getURL()
  if (/^https?:/i.test(u)) items.push({ label: 'просмотр кода страницы', click: () => newTab('view-source:' + u) })
  items.push({ label: 'сохранить страницу как…', click: () => savePageOf(wc, wcToTab(wc)) })
  items.push({ label: 'печать…', click: () => printOf(wc) })
  items.push({ type: 'separator' })
  items.push({ label: 'копировать адрес страницы', click: () => clipboard.writeText(u) })
  Menu.buildFromTemplate(items).popup({ window: win })
}

function attachEvents(t) {
  const wc = t.view.webContents
  wc.on('focus', () => {
    if (win && !win.isDestroyed()) win.webContents.send('hide-sug')
  })
  if (process.env.LIBER_DEBUG) {
    wc.on('console-message', (e, level, message, line, sourceId) => console.log('[tab]', message, '(' + sourceId + ':' + line + ')'))
  }
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) newTab(url)
    return { action: 'deny' }
  })
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && handleKeys(wc, e, input)) e.preventDefault()
  })
  wc.on('did-start-loading', () => { t.loading = true; sendState() })
  wc.on('did-stop-loading', () => { t.loading = false; sendState() })
  wc.on('page-title-updated', (e, title) => { t.title = title; if (!t.loading) recordHistory(t.url, title); sendState() })
  wc.on('did-navigate', (e, url) => {
    let u = url
    try {
      const full = wc.getURL()
      if (/^view-source:/i.test(full)) u = full
    } catch (_) {}
    t.url = u
    if (/^https?:/i.test(u)) applySiteZoom(wc, u)
    if (!t.loading) recordHistory(u, t.title)
    sendState()
  })
  wc.on('did-navigate-in-page', (e, url) => { t.url = url; sendState() })
  wc.on('page-favicon-updated', (e, favs) => { t.favicon = (favs && favs[0]) ? favs[0].url : ''; sendState() })
  wc.on('audio-state-changed', () => sendState())
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || !/^https?:/i.test(url)) return
    if (/^view-source:/i.test(t.url)) return
    t.url = ERR_URL + '?u=' + encodeURIComponent(url) + '&c=' + code
    wc.loadURL(t.url).catch(() => {})
    sendState()
  })
  wc.on('render-process-gone', (e, details) => {
    if (!win || win.isDestroyed()) return
    const back = /^https?:/i.test(t.url) ? t.url : ''
    t.url = ERR_URL + '?u=' + encodeURIComponent(back) + '&c=crash'
    try { wc.loadURL(t.url) } catch (_) {}
    sendState()
  })
  wc.on('enter-html-full-screen', () => { vidFs = true; win.setFullScreen(true); applyLayout() })
  wc.on('leave-html-full-screen', () => { vidFs = false; win.setFullScreen(false); applyLayout() })
  wc.on('found-in-page', (e, res) => {
    if (win && !win.isDestroyed()) win.webContents.send('findres', { count: res.matches, active: res.activeMatchOrdinal })
  })
  wc.on('context-menu', (e, p) => contextMenu(wc, p))
  wc.on('did-finish-load', () => { if (t.url && /^https?:/i.test(t.url)) recordHistory(t.url, t.title) })
}

function internalPage(name) {
  const n = PAGES.includes(name) ? name : 'start'
  return 'file://' + path.join(__dirname, 'ui', n + '.html').replace(/\\/g, '/')
}

function newTab(url) {
  const id = ++seq
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      plugins: true,
      spellcheck: true,
      preload: path.join(__dirname, 'content-preload.js'),
    },
  })
  const t = { id, view, url: url || START_URL, title: '', loading: false, favicon: '' }
  tabs.push(t)
  attachEvents(t)
  win.contentView.addChildView(view)
  try { view.setBackgroundColor('#0b0c10') } catch (_) {}
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
  if (/^https?:/i.test(t.url)) {
    closedTabs.push({ url: t.url })
    if (closedTabs.length > 25) closedTabs.shift()
  }
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
ipcMain.handle('tab:dup', (e, id) => {
  const t = tabById(id)
  if (t && /^https?:/i.test(t.url)) newTab(t.url)
})
ipcMain.handle('tab:closeothers', (e, id) => {
  for (const t of [...tabs]) if (t.id !== id) closeTab(t.id)
})
ipcMain.handle('tab:closeright', (e, id) => {
  const i = tabs.findIndex(t => t.id === id)
  if (i < 0) return
  for (const t of tabs.slice(i + 1)) closeTab(t.id)
})
ipcMain.handle('tab:mute', (e, id) => {
  const t = tabById(id)
  if (!t) return
  try {
    const wc = t.view.webContents
    wc.setAudioMuted(!wc.isAudioMuted())
  } catch (_) {}
  sendState()
})
ipcMain.handle('tab:stop', (e, id) => {
  const t = tabById(id)
  if (t) try { t.view.webContents.stop() } catch (_) {}
})
ipcMain.handle('tab:print', (e, id) => {
  const t = tabById(id)
  if (t) printOf(t.view.webContents)
})
ipcMain.handle('tab:save', (e, id) => {
  const t = tabById(id)
  if (t) savePageOf(t.view.webContents, t)
})
ipcMain.handle('tab:source', (e, id) => {
  const t = tabById(id)
  if (t) sourceOf(t.view.webContents)
})
ipcMain.handle('tab:reopen', () => reopenClosed())
ipcMain.handle('tab:cycle', (e, d) => switchRelative(d))
ipcMain.handle('tab:pick', (e, i) => {
  const t = i < 0 ? tabs[tabs.length - 1] : tabs[i]
  if (t) switchTab(t.id)
})
ipcMain.handle('tab:nav', (e, { id, input }) => {
  const t = tabById(id)
  if (!t) return
  const s = (input || '').trim()
  if (!s) {
    if (settings.homepage) t.view.webContents.loadURL(settings.homepage).catch(() => {})
    return
  }
  const u = toUrl(s)
  if (u) t.view.webContents.loadURL(u).catch(() => {})
})
ipcMain.handle('tab:back', (e, id) => {
  const t = tabById(id)
  if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.goBack()
})
ipcMain.handle('tab:reload', (e, id) => {
  const t = tabById(id)
  if (t) t.view.webContents.reload()
})
ipcMain.handle('page', (e, name) => newTab(internalPage(name)))
ipcMain.handle('page:nav', (e, q) => {
  const t = wcToTab(e.sender)
  if (!t) return
  const u = toUrl(q)
  if (u) t.view.webContents.loadURL(u).catch(() => {})
})
ipcMain.handle('zoom', (e, { id, d }) => {
  const t = tabById(id)
  if (!t) return
  if (d === 0) setZoom(t.view.webContents, 1)
  else zoomBy(t.view.webContents, d)
})
ipcMain.handle('find', (e, { id, q, nx }) => {
  const t = tabById(id)
  if (!t) return
  if (!q) return t.view.webContents.stopFindInPage('clearSelection')
  t.view.webContents.findInPage(q, { findNext: !!nx })
})
ipcMain.handle('find:stop', (e, id) => {
  const t = tabById(id)
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
  if (s.length === 0) return data.history.slice(0, 6).map(it => ({ url: it.url, title: it.title }))
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
ipcMain.handle('d:list', () => dls)
ipcMain.handle('d:cancel', (e, id) => {
  const it = dlItems.get(id)
  if (it) try { it.cancel() } catch (_) {}
})
ipcMain.handle('d:pause', (e, id) => {
  const it = dlItems.get(id)
  if (!it) return
  try {
    if (it.isPaused()) it.resume()
    else it.pause()
  } catch (_) {}
})
ipcMain.handle('d:open', (e, id) => {
  const d = dls.find(x => x.id === id)
  if (d) shell.openPath(d.path)
})
ipcMain.handle('d:reveal', (e, id) => {
  const d = dls.find(x => x.id === id)
  if (d) shell.showItemInFolder(d.path)
})
ipcMain.handle('d:remove', (e, id) => {
  const i = dls.findIndex(x => x.id === id)
  if (i < 0) return
  const it = dlItems.get(id)
  if (it) try { it.cancel() } catch (_) {}
  dlItems.delete(id)
  dls.splice(i, 1)
  persistDls()
  sendDls()
  sendState()
})
ipcMain.handle('d:clear', () => {
  for (let i = dls.length - 1; i >= 0; i--) {
    if (dls[i].state !== 'progressing' && dls[i].state !== 'paused') dls.splice(i, 1)
  }
  persistDls()
  sendDls()
  sendState()
})
ipcMain.handle('st:get', () => ({
  search: settings.search,
  homepage: settings.homepage,
  bmBar: settings.bmBar,
  restore: settings.restore,
  downloadsDir: dlDirOf(),
  engine: bypass.status(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
}))
ipcMain.handle('st:set', (e, patch) => applySettings(patch))
ipcMain.handle('st:pickdir', async () => {
  try {
    const res = await dialog.showOpenDialog(win, { title: 'папка загрузок', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths.length) return ''
    applySettings({ downloadDir: res.filePaths[0] })
    return res.filePaths[0]
  } catch (_) {
    return ''
  }
})
ipcMain.handle('data:clear', async (e, what) => {
  const w = what || {}
  if (w.history) {
    data.history = []
    storage.save(data)
    sendState()
  }
  if (w.cache) {
    try { await ses.clearCache() } catch (_) {}
  }
  if (w.site) {
    try { await ses.clearStorageData() } catch (_) {}
  }
  return true
})
ipcMain.handle('app:default', async () => {
  let ok = false
  try { ok = app.setAsDefaultProtocolClient('http') || ok } catch (_) {}
  try { ok = app.setAsDefaultProtocolClient('https') || ok } catch (_) {}
  try { shell.openExternal('ms-settings:defaultapps') } catch (_) {}
  return ok
})
ipcMain.handle('open-ext', (e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url) })
ipcMain.handle('zoom-wheel', (e, deltaY) => {
  const t = wcToTab(e.sender)
  if (t) zoomBy(t.view.webContents, deltaY < 0 ? 1 : -1)
})
ipcMain.handle('win:min', () => win.minimize())
ipcMain.handle('win:max', () => { win.isMaximized() ? win.unmaximize() : win.maximize() })
ipcMain.handle('win:close', () => win.close())
ipcMain.handle('win:full', () => { win.setFullScreen(!win.isFullScreen()) })

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (e, argv) => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const u = (argv || []).find(a => /^https?:\/\//i.test(a))
    if (u) newTab(u)
  })

  app.whenReady().then(() => {
    ses = session.fromPartition('persist:liber')
    const ALLOW = new Set(['media', 'fullscreen', 'pointerLock', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'display-capture'])
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOW.has(permission)))
    ses.setPermissionCheckHandler((wc, permission) => ALLOW.has(permission))
    ses.setDisplayMediaRequestHandler((req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then(srcs => cb(srcs.length ? { video: srcs[0], audio: 'loopback' } : {}))
        .catch(() => cb({}))
    })
    applyProxy(false)
    bypass.start(on => applyProxy(on))
    ses.on('will-download', (e, item) => {
      const f = uniquePath(dlDirOf(), item.getFilename())
      item.setSavePath(f)
      const entry = { id: ++dlSeq, name: path.basename(f), path: f, url: item.getURL(), state: 'progressing', received: 0, total: item.getTotalBytes(), date: Date.now() }
      dls.unshift(entry)
      dlItems.set(entry.id, item)
      sendDls()
      sendState()
      item.on('updated', () => {
        if (Date.now() - dlsTick < 400) return
        dlsTick = Date.now()
        entry.state = item.isPaused() ? 'paused' : 'progressing'
        entry.received = item.getReceivedBytes()
        entry.total = item.getTotalBytes()
        sendDls()
        sendState()
      })
      item.once('done', (i, st) => {
        entry.state = st === 'completed' ? 'completed' : st === 'cancelled' ? 'cancelled' : 'interrupted'
        entry.received = item.getReceivedBytes()
        entry.total = item.getTotalBytes()
        dlItems.delete(entry.id)
        persistDls()
        sendDls()
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
        spellcheck: false,
      },
    })
    win.setMenuBarVisibility(false)
    win.once('ready-to-show', () => win.show())
    win.on('resize', applyLayout)
    win.on('maximize', sendState)
    win.on('unmaximize', sendState)
    win.on('enter-full-screen', sendState)
    win.on('leave-full-screen', sendState)
    win.on('close', persist)
    win.webContents.on('did-finish-load', () => { sendBm(); sendSettings(); sendDls(); sendState() })
    win.webContents.on('context-menu', (e, p) => {
      const items = []
      if (p.isEditable) {
        items.push({ label: 'вырезать', role: 'cut', enabled: p.editFlags.canCut })
        items.push({ label: 'копировать', role: 'copy', enabled: p.editFlags.canCopy })
        items.push({ label: 'вставить', role: 'paste', enabled: p.editFlags.canPaste })
        items.push({ label: 'вставить и перейти', enabled: p.editFlags.canPaste, click: () => { const txt = clipboard.readText().trim(); if (txt) win.webContents.send('omni-paste', txt) } })
        items.push({ type: 'separator' })
        items.push({ label: 'выделить всё', role: 'selectAll' })
      } else if (p.selectionText) {
        items.push({ label: 'копировать', role: 'copy' })
      }
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
    })
    if (process.env.LIBER_DEBUG) {
      win.webContents.on('console-message', (e, level, message, line, sourceId) => console.log('[ui]', message, '(' + sourceId + ':' + line + ')'))
    }
    win.loadFile(path.join(__dirname, 'ui', 'index.html'))
    const argUrl = process.argv.find(a => /^https?:\/\//i.test(a))
    const startTabs = argUrl ? [argUrl] : (settings.restore && data.tabs.length ? data.tabs : [null])
    for (const u of startTabs) newTab(u)
    setInterval(() => persist(), 20000)
    if (process.env.LIBER_SELFTEST) setTimeout(selftest, 2500)
  })

  async function selftest() {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const js = code => win.webContents.executeJavaScript(code)
    const dev = path.join(__dirname, '..', '_dev')
    try { fs.mkdirSync(dev, { recursive: true }) } catch (_) {}
    const shot = async name => {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(path.join(dev, name + '.png'), img.toPNG())
      } catch (e) { console.log('ST shot fail:', name, e.message) }
    }
    try {
      console.log('ST shell:', await js(`JSON.stringify({ href: location.href, more: !!document.getElementById('more'), lock: !!document.getElementById('lock'), menu: !!document.getElementById('menu'), tmenu: !!document.getElementById('tmenu'), add: !!document.getElementById('add'), err: window.__liberErr || null })`))
      console.log('ST restored:', JSON.stringify(tabs.map(t => t.url)))
      const t0 = tabs[0]
      const wc0 = t0.view.webContents
      if (!/^https?:/i.test(t0.url)) {
        await wc0.loadURL('https://example.com/')
        await wait(1800)
      }
      const key = (k, mods) => {
        wc0.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] })
        wc0.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] })
      }
      console.log('ST ctrl+T from content:')
      let n = tabs.length
      key('t', ['control'])
      await wait(500)
      console.log('ST tabs:', n, '->', tabs.length)
      console.log('ST ctrl+W:')
      n = tabs.length
      key('w', ['control'])
      await wait(400)
      console.log('ST tabs:', n, '->', tabs.length)
      console.log('ST zoom ctrl+= :')
      wc0.setZoomFactor(1)
      key('=', ['control'])
      await wait(300)
      console.log('ST zoomFactor:', wc0.getZoomFactor())
      wc0.setZoomFactor(1)
      key('+', ['control', 'shift'])
      await wait(300)
      console.log('ST zoomFactor shift+:', wc0.getZoomFactor())
      console.log('ST zoom site map:', JSON.stringify(settings.zoom))
      setZoom(wc0, 1)
      console.log('ST ctrl+D on http tab:')
      await js(`(function(){ const pills = [...document.querySelectorAll('.tab')]; pills[0].click(); return 1 })()`)
      await wait(300)
      const bmBefore = data.bookmarks.length
      key('d', ['control'])
      await wait(400)
      console.log('ST bm:', bmBefore, '->', data.bookmarks.length)
      key('d', ['control'])
      await wait(400)
      console.log('ST bm back:', data.bookmarks.length)
      console.log('ST popup window.open:')
      n = tabs.length
      await wc0.executeJavaScript(`window.open('https://example.com/?popup', '_blank'); 1`)
      await wait(900)
      console.log('ST tabs:', n, '->', tabs.length, 'last:', tabs[tabs.length - 1].url)
      console.log('ST close popup + reopen closed:')
      n = tabs.length
      key('w', ['control'])
      await wait(400)
      const afterClose = tabs.length
      key('t', ['control', 'shift'])
      await wait(700)
      console.log('ST tabs:', n, '->', afterClose, '->', tabs.length, 'last:', tabs[tabs.length - 1].url)
      console.log('ST alt+left back:')
      await wc0.loadURL('https://example.com/?x')
      await wait(1500)
      await wc0.loadURL('https://example.com/?y')
      await wait(1500)
      console.log('ST canGoBack:', wc0.navigationHistory.canGoBack())
      key('Left', ['alt'])
      await wait(900)
      console.log('ST url after alt+Left:', wc0.getURL())
      console.log('ST ctrl+F find:')
      key('f', ['control'])
      await wait(400)
      console.log('ST find placeholder:', await js(`document.getElementById('omni').placeholder`))
      await js(`(function(){ document.getElementById('omni').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`)
      await wait(300)
      console.log('ST suggest on focus:')
      await js(`(function(){ document.getElementById('omni').focus(); return 1 })()`)
      await wait(700)
      console.log('ST sug state:', await js(`JSON.stringify({ cls: document.getElementById('sug').className, items: document.querySelectorAll('.sugit').length })`))
      await shot('sug')
      console.log('ST inline completion:')
      await js(`(function(){ const o = document.getElementById('omni'); o.value = 'exam'; o.setSelectionRange(4, 4); o.dispatchEvent(new Event('input')); return 1 })()`)
      await wait(600)
      console.log('ST omni after type:', await js(`JSON.stringify({ v: document.getElementById('omni').value, sel: document.getElementById('omni').selectionEnd })`))
      console.log('ST comp state:', await js(`JSON.stringify({ grew: typeof grew !== 'undefined' ? grew : 'na', lastVal: typeof lastVal !== 'undefined' ? lastVal : 'na', comp: typeof comp !== 'undefined' ? comp : 'na', ae: document.activeElement && document.activeElement.id, dfocus: document.hasFocus() })`))
      await js(`(function(){ const o = document.getElementById('omni'); o.value = ''; o.dispatchEvent(new Event('input')); return 1 })()`)
      console.log('ST star via dom:')
      await js(`(function(){ document.querySelectorAll('.tab')[0].click(); return 1 })()`)
      await wait(300)
      await js(`(function(){ document.getElementById('star').click(); return 1 })()`)
      await wait(500)
      console.log('ST bm list:', data.bookmarks.map(b => b.url).join(','))
      console.log('ST bmbar:', await js(`document.getElementById('bmbar').className + ' ' + document.querySelectorAll('.bmi').length`))
      await shot('bm')
      await js(`(function(){ document.getElementById('star').click(); return 1 })()`)
      await wait(300)
      console.log('ST download test:')
      const dlDir = app.getPath('downloads')
      const before2 = new Set(fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : [])
      wc0.downloadURL('https://example.com/')
      await wait(4000)
      const after2 = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter(f => !before2.has(f)) : []
      console.log('ST new files:', JSON.stringify(after2))
      console.log('ST dls list:', dls.length, dls[0] ? dls[0].name + ' ' + dls[0].state : '-')
      console.log('ST ctrl+J downloads page:')
      key('j', ['control'])
      await wait(800)
      console.log('ST last url:', tabs[tabs.length - 1].url)
      console.log('ST ctrl+1 first tab:')
      key('1', ['control'])
      await wait(400)
      console.log('ST active is first:', activeId === tabs[0].id)
      console.log('ST view-source:')
      n = tabs.length
      newTab('view-source:https://example.com/')
      await wait(1500)
      const vsw = tabs[tabs.length - 1].view.webContents
      console.log('ST tabs:', n, '->', tabs.length, 'src url:', tabs[tabs.length - 1].url)
      console.log('ST vs getURL:', vsw.getURL())
      console.log('ST vs title:', JSON.stringify(tabs[tabs.length - 1].title))
      console.log('ST settings page:')
      await js(`window.liber.page('settings')`)
      await wait(900)
      console.log('ST settings url:', tabs[tabs.length - 1].url)
      console.log('ST settings dom:', JSON.stringify((await tabs[tabs.length - 1].view.webContents.executeJavaScript(`document.body.innerText.slice(0, 60)`))))
      await js(`(function(){ document.querySelectorAll('.tab')[0].click(); return 1 })()`)
      await wait(500)
      console.log('ST lock icon:', await js(`(() => { const l = document.getElementById('lock'); return l ? l.title + '|' + l.textContent : 'none' })()`))
      console.log('ST search engine switch:')
      applySettings({ search: 'yandex' })
      console.log('ST toUrl search:', toUrl('привет мир'))
      applySettings({ search: 'ddg' })
      persist()
      const saved = storage.load()
      console.log('ST persisted tabs:', JSON.stringify(saved.tabs))
      console.log('ST history:', saved.history.length)
    } catch (e) {
      console.log('ST FATAL:', e.message)
    }
    console.log('ST done')
  }

  app.on('window-all-closed', () => app.quit())
}
