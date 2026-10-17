const { app, BrowserWindow, ipcMain, WebContentsView, session, Menu, clipboard, desktopCapturer, shell, dialog, safeStorage, protocol } = require('electron')
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
const INDEX = path.join(__dirname, 'ui', 'index.html')
const START_URL = 'file://' + path.join(__dirname, 'ui', 'start.html').replace(/\\/g, '/')
const ERR_URL = 'file://' + path.join(__dirname, 'ui', 'err.html').replace(/\\/g, '/')

protocol.registerSchemesAsPrivileged([{ scheme: 'liber', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

app.commandLine.appendSwitch('disable-quic')

const windows = []
const liveSessions = new Set()
let ses = null
let seq = 0
let focusedW = null
const data = storage.load()
const settings = Object.assign({ search: 'ddg', homepage: '', downloadDir: '', bmBar: true, restore: true, zoom: {} }, data.settings || {})
data.settings = settings
data.bmFolders = Array.isArray(data.bmFolders) ? data.bmFolders : []
let vault = []
try {
  if (data.vault) {
    let txt = ''
    try { txt = safeStorage.decryptString(Buffer.from(data.vault, 'base64')) } catch (_) { txt = data.vault }
    const arr = JSON.parse(txt)
    if (Array.isArray(arr)) vault = arr
  }
} catch (_) { vault = [] }
const dls = []
const dlItems = new Map()
let dlSeq = 0
let dlsTick = 0

for (const d of (data.downloads || []).slice(0, 50)) {
  dls.push(d)
  dlSeq = Math.max(dlSeq, d.id || 0)
}

function eachW(fn) {
  for (const w of [...windows]) {
    if (!w.win.isDestroyed()) fn(w)
  }
}

function winBySender(sender) {
  return windows.find(w => !w.win.isDestroyed() && w.win.webContents.id === sender.id)
}

function tabById(id) {
  for (const w of windows) {
    const t = w.tabs.find(t => t.id === id)
    if (t) return t
  }
  return null
}

function W_ofTab(t) {
  if (!t) return null
  return windows.find(w => w.tabs.includes(t)) || null
}

function wcToTab(wc) {
  for (const w of windows) {
    const t = w.tabs.find(t => t.view.webContents.id === wc.id)
    if (t) return t
  }
  return null
}

function wOfEvent(e) {
  return winBySender(e.sender) || W_ofTab(wcToTab(e.sender))
}

function engine() {
  return ENGINES[settings.search] || ENGINES.ddg
}

function bmVisible() {
  return data.bookmarks.length > 0 && settings.bmBar
}

function chromeH(w) {
  if (w.vidFs) return 0
  return BAR_H + OMNI_H + (bmVisible() ? BM_H : 0) + (w.expanded ? SUG_H : 0)
}

function bmIndex(url) {
  return data.bookmarks.findIndex(b => b.url === url)
}

function activeTab(w) {
  return w.tabs.find(t => t.id === w.activeId)
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

function applyProxyTo(s, on) {
  try {
    if (on) s.setProxy({ proxyRules: `socks5://127.0.0.1:${ENGINE_PORT}`, proxyBypassRules: '<local>' })
    else s.setProxy({})
  } catch (_) {}
}

function applyProxyAll(on) {
  for (const s of liveSessions) applyProxyTo(s, on)
}

function dlDirOf() {
  return settings.downloadDir && fs.existsSync(settings.downloadDir) ? settings.downloadDir : app.getPath('downloads')
}

function persistDls() {
  data.downloads = dls.slice(0, 50)
  storage.save(data)
}

function sendDls() {
  eachW(w => w.win.webContents.send('dls', dls))
}

function sendSettings() {
  eachW(w => w.win.webContents.send('settings', { bmBar: settings.bmBar, search: settings.search, homepage: settings.homepage }))
}

function bcast() {
  eachW(w => sendState(w))
}

function sendState(w) {
  if (!w || w.win.isDestroyed()) return
  const a = activeTab(w)
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
  w.win.webContents.send('state', {
    tabs: w.tabs.map(t => {
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
        active: t.id === w.activeId,
        muted: tm,
        audible: ta && !tm,
      }
    }),
    engine: bypass.status(),
    dls: act.length,
    dlsName: act.length ? act[0].name : '',
    dlsPct: act.length && act[0].total > 0 ? Math.round((act[0].received / act[0].total) * 100) : 0,
    zoom,
    fs: w.win.isFullScreen(),
    muted,
    audible,
    private: w.isPrivate,
    isBm: !!(a && a.url && /^https?:/i.test(a.url) && bmIndex(a.url) >= 0),
  })
  if (a && a.title) w.win.setTitle((w.isPrivate ? 'инкогнито — ' : '') + a.title + ' — Liber')
  else w.win.setTitle(w.isPrivate ? 'Liber — инкогнито' : 'Liber')
}

function sendBm() {
  eachW(w => w.win.webContents.send('bm', bmPayload()))
}

function bmPayload() {
  return { items: data.bookmarks, folders: data.bmFolders }
}

function bmFolderAdd(name) {
  const f = String(name || '').trim()
  if (!f || data.bmFolders.includes(f)) return bmPayload()
  data.bmFolders.push(f)
  storage.save(data)
  sendBm()
  eachW(applyLayout)
  bcast()
  return bmPayload()
}

function bmFolderDel(name) {
  data.bmFolders = data.bmFolders.filter(f => f !== name)
  for (const b of data.bookmarks) if (b.folder === name) delete b.folder
  storage.save(data)
  sendBm()
  eachW(applyLayout)
  bcast()
  return bmPayload()
}

function bmMove(url, folder) {
  const b = data.bookmarks.find(x => x.url === url)
  if (!b) return bmPayload()
  const f = String(folder || '').trim()
  if (!f) delete b.folder
  else b.folder = f
  storage.save(data)
  sendBm()
  bcast()
  return bmPayload()
}

function persist() {
  data.windows = windows
    .filter(w => !w.isPrivate && !w.win.isDestroyed())
    .map(w => {
      const maxed = w.win.isMaximized() || w.win.isFullScreen()
      const b = maxed ? null : w.win.getBounds()
      return {
        bounds: b,
        tabs: w.tabs.map(t => (/^https?:/i.test(t.url) ? t.url : null)).filter(Boolean),
      }
    })
  delete data.window
  delete data.tabs
  storage.save(data)
}

function applyLayout(w) {
  if (!w || w.win.isDestroyed()) return
  const [wd, ht] = w.win.getContentSize()
  const top = chromeH(w)
  for (const t of w.tabs) {
    t.view.setBounds({ x: 0, y: top, width: wd, height: Math.max(0, ht - top) })
  }
}

function recordHistory(url, title, w) {
  if (!/^https?:/i.test(url)) return
  if (w && w.isPrivate) return
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
  eachW(applyLayout)
}

function siteHostOf(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.host : ''
  } catch (_) {
    return ''
  }
}

function setZoom(wc, factor, w) {
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
  if (w) sendState(w)
}

function zoomBy(wc, dir, w) {
  const cur = wc.getZoomFactor()
  let i = ZOOM_STEPS.findIndex(s => s >= cur - 0.001)
  if (i < 0) i = ZOOM_STEPS.length - 1
  if (dir > 0 && Math.abs(ZOOM_STEPS[i] - cur) > 0.01) i -= 1
  i = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))
  setZoom(wc, ZOOM_STEPS[i], w)
}

function applySiteZoom(wc, url) {
  const host = siteHostOf(url)
  const z = host ? settings.zoom[host] : null
  try {
    wc.setZoomFactor(z && Math.abs(z - 1) > 0.01 ? z : 1)
  } catch (_) {}
}

function focusOmni(w) {
  if (!w || w.win.isDestroyed()) return
  w.win.webContents.send('focus-omni')
  w.win.webContents.focus()
}

function navHome(wc) {
  wc.loadURL(settings.homepage || START_URL).catch(() => {})
}

function switchRelative(w, dir) {
  if (w.tabs.length < 2) return
  const i = w.tabs.findIndex(t => t.id === w.activeId)
  if (i < 0) return
  const n = (i + dir + w.tabs.length) % w.tabs.length
  switchTab(w, w.tabs[n].id)
}

function reopenClosed(w) {
  const last = w.closedTabs.pop()
  if (last) newTab(last.url, w)
}

function sourceOf(wc) {
  const u = wc.getURL()
  if (/^https?:/i.test(u)) {
    const t = wcToTab(wc)
    const w = W_ofTab(t)
    if (w) newTab('view-source:' + u, w)
  }
}

function printOf(wc) {
  try {
    wc.print({})
  } catch (_) {}
}

async function savePageOf(wc, t) {
  const title = ((t && t.title) || 'page').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'page'
  const owner = W_ofTab(t) || focusedW
  let filePath = null
  try {
    const res = await dialog.showSaveDialog(owner ? owner.win : null, {
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
  bcast()
}

function handleKeys(wc, event, input, w) {
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
    if (key === 'F6') { focusOmni(w); event.preventDefault(); return true }
    if (key === 'F9') { readerOf(w); event.preventDefault(); return true }
    if (key === 'F11') { w.win.setFullScreen(!w.win.isFullScreen()); event.preventDefault(); return true }
    if (key === 'Escape' && wc.isLoading()) { wc.stop(); event.preventDefault(); return true }
    return false
  }
  if (input.shift) {
    if (k === 'o') { newTab(internalPage('bms'), w); event.preventDefault(); return true }
    if (k === 'i') { wc.toggleDevTools(); event.preventDefault(); return true }
    if (k === 't') { reopenClosed(w); event.preventDefault(); return true }
    if (k === 'b') { applySettings({ bmBar: !settings.bmBar }); event.preventDefault(); return true }
    if (k === 'n') { createWindow({ private: true }); event.preventDefault(); return true }
    if (k === 'a') { w.win.webContents.send('tab-search'); w.win.webContents.focus(); event.preventDefault(); return true }
    if (k === 'Tab') { switchRelative(w, -1); event.preventDefault(); return true }
    if (k === 'Delete') { newTab(internalPage('settings'), w); event.preventDefault(); return true }
    if (k === '+' || k === '=') { zoomBy(wc, 1, w); event.preventDefault(); return true }
    if (k === '-') { zoomBy(wc, -1, w); event.preventDefault(); return true }
    return false
  }
  if (k === 'Tab') { switchRelative(w, 1); event.preventDefault(); return true }
  if (k === 't') { newTab(null, w); event.preventDefault(); return true }
  if (k === 'n') { createWindow({}); event.preventDefault(); return true }
  if (k === 'w') { closeTab(w, w.activeId); event.preventDefault(); return true }
  if (k === 'l') { focusOmni(w); event.preventDefault(); return true }
  if (k === 'f') { w.win.webContents.send('find-omni'); w.win.webContents.focus(); event.preventDefault(); return true }
  if (k === 'h') { newTab(internalPage('hist'), w); event.preventDefault(); return true }
  if (k === 'j') { newTab(internalPage('dls'), w); event.preventDefault(); return true }
  if (k === 'u') { sourceOf(wc); event.preventDefault(); return true }
  if (k === 's') { savePageOf(wc, wcToTab(wc)); event.preventDefault(); return true }
  if (k === 'p') { printOf(wc); event.preventDefault(); return true }
  if (/^[1-8]$/.test(key)) { const t = w.tabs[Number(key) - 1]; if (t) switchTab(w, t.id); event.preventDefault(); return true }
  if (key === '9') { if (w.tabs.length) switchTab(w, w.tabs[w.tabs.length - 1].id); event.preventDefault(); return true }
  if (k === 'd') {
    const a = activeTab(w)
    if (a && a.url && /^https?:/i.test(a.url)) toggleBm(a.url, a.title)
    event.preventDefault(); return true
  }
  if (k === 'r') { wc.reload(); event.preventDefault(); return true }
  if (k === '+' || k === '=') { zoomBy(wc, 1, w); event.preventDefault(); return true }
  if (k === '-') { zoomBy(wc, -1, w); event.preventDefault(); return true }
  if (k === '0') { setZoom(wc, 1, w); event.preventDefault(); return true }
  return false
}

function contextMenu(wc, p, w) {
  const items = []
  if (p.misspelledWord) {
    for (const s of (p.dictionarySuggestions || []).slice(0, 5)) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    }
    items.push({ type: 'separator' })
    items.push({ label: 'добавить в словарь', click: () => { try { w.ses.addWordToSpellCheckerDictionary(p.misspelledWord) } catch (_) {} } })
    items.push({ type: 'separator' })
  }
  if (p.linkURL) {
    items.push({ label: 'открыть в новой вкладке', click: () => newTab(p.linkURL, w) })
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
    if (sel) items.push({ label: 'искать «' + sel + '» в ' + engine().label, click: () => newTab(engine().url.replace('%s', encodeURIComponent(sel)), w) })
    items.push({ type: 'separator' })
  }
  if (p.mediaType === 'image') {
    items.push({ label: 'открыть картинку в новой вкладке', click: () => { if (p.srcURL) newTab(p.srcURL, w) } })
    items.push({ label: 'сохранить картинку как', click: () => { try { wc.downloadURL(p.srcURL) } catch (_) {} } })
    items.push({ label: 'копировать картинку', click: () => wc.copyImageAt(p.x, p.y) })
    items.push({ type: 'separator' })
  }
  items.push({ label: 'назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.goBack() })
  items.push({ label: 'вперёд', enabled: wc.navigationHistory.canGoForward(), click: () => wc.goForward() })
  items.push({ label: 'обновить', click: () => wc.reload() })
  items.push({ type: 'separator' })
  const u = wc.getURL()
  if (/^https?:/i.test(u)) {
    items.push({ label: 'просмотр кода страницы', click: () => newTab('view-source:' + u, w) })
    items.push({ label: 'режим чтения', click: () => wc.send('reader-mode') })
    items.push({ label: 'перевести страницу', click: () => newTab(translateUrl(u), w) })
  }
  items.push({ label: 'сохранить страницу как…', click: () => savePageOf(wc, wcToTab(wc)) })
  items.push({ label: 'печать…', click: () => printOf(wc) })
  items.push({ type: 'separator' })
  items.push({ label: 'копировать адрес страницы', click: () => clipboard.writeText(u) })
  Menu.buildFromTemplate(items).popup({ window: w.win })
}

function attachEvents(t, w) {
  const wc = t.view.webContents
  wc.on('focus', () => {
    if (!w.win.isDestroyed()) w.win.webContents.send('hide-sug')
  })
  if (process.env.LIBER_DEBUG) {
    wc.on('console-message', (e, level, message, line, sourceId) => console.log('[tab]', message, '(' + sourceId + ':' + line + ')'))
  }
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) newTab(url, w)
    return { action: 'deny' }
  })
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && handleKeys(wc, e, input, w)) e.preventDefault()
  })
  wc.on('did-start-loading', () => { t.loading = true; sendState(w) })
  wc.on('did-stop-loading', () => { t.loading = false; sendState(w) })
  wc.on('page-title-updated', (e, title) => { t.title = title; if (!t.loading) recordHistory(t.url, title, w); sendState(w) })
  wc.on('did-navigate', (e, url) => {
    let u = url
    try {
      const full = wc.getURL()
      if (/^view-source:/i.test(full)) u = full
    } catch (_) {}
    t.url = u
    if (/^https?:/i.test(u)) applySiteZoom(wc, u)
    if (!t.loading) recordHistory(u, t.title, w)
    sendState(w)
  })
  wc.on('did-navigate-in-page', (e, url) => { t.url = url; sendState(w) })
  wc.on('page-favicon-updated', (e, favs) => { t.favicon = (favs && favs[0]) ? favs[0].url : ''; sendState(w) })
  wc.on('audio-state-changed', () => sendState(w))
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || !/^https?:/i.test(url)) return
    if (/^view-source:/i.test(t.url)) return
    t.url = ERR_URL + '?u=' + encodeURIComponent(url) + '&c=' + code
    wc.loadURL(t.url).catch(() => {})
    sendState(w)
  })
  wc.on('render-process-gone', () => {
    if (w.win.isDestroyed()) return
    const back = /^https?:/i.test(t.url) ? t.url : ''
    t.url = ERR_URL + '?u=' + encodeURIComponent(back) + '&c=crash'
    try { wc.loadURL(t.url) } catch (_) {}
    sendState(w)
  })
  wc.on('enter-html-full-screen', () => { w.vidFs = true; w.win.setFullScreen(true); applyLayout(w) })
  wc.on('leave-html-full-screen', () => { w.vidFs = false; w.win.setFullScreen(false); applyLayout(w) })
  wc.on('found-in-page', (e, res) => {
    if (!w.win.isDestroyed()) w.win.webContents.send('findres', { count: res.matches, active: res.activeMatchOrdinal })
  })
  wc.on('context-menu', (e, p) => contextMenu(wc, p, w))
  wc.on('did-finish-load', () => { if (t.url && /^https?:/i.test(t.url)) recordHistory(t.url, t.title, w) })
}

function internalPage(name) {
  const n = PAGES.includes(name) ? name : 'start'
  return 'file://' + path.join(__dirname, 'ui', n + '.html').replace(/\\/g, '/')
}

function newTab(url, w) {
  const id = ++seq
  const view = new WebContentsView({
    webPreferences: {
      session: w.ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      plugins: true,
      spellcheck: true,
      preload: path.join(__dirname, 'content-preload.js'),
    },
  })
  const t = { id, view, url: url || START_URL, title: '', loading: false, favicon: '' }
  w.tabs.push(t)
  attachEvents(t, w)
  w.win.contentView.addChildView(view)
  try { view.setBackgroundColor('#0b0c10') } catch (_) {}
  view.setBounds({ x: 0, y: chromeH(w), width: 0, height: 0 })
  view.webContents.loadURL(t.url)
  w.activeId = id
  applyLayout(w)
  view.webContents.focus()
  sendState(w)
  return id
}

function switchTab(w, id) {
  const prev = w.tabs.find(t => t.id === w.activeId)
  const next = w.tabs.find(t => t.id === id)
  if (!next || prev === next) return
  if (prev) {
    try { prev.view.setVisible(false) } catch (_) { w.win.contentView.removeChildView(prev.view) }
  }
  try { next.view.setVisible(true) } catch (_) { w.win.contentView.addChildView(next.view) }
  w.activeId = id
  applyLayout(w)
  next.view.webContents.focus()
  sendState(w)
}

function closeTab(w, id) {
  const t = w.tabs.find(x => x.id === id)
  if (!t) return
  if (/^https?:/i.test(t.url)) {
    w.closedTabs.push({ url: t.url })
    if (w.closedTabs.length > 25) w.closedTabs.shift()
  }
  w.tabs = w.tabs.filter(x => x.id !== id)
  try {
    w.win.contentView.removeChildView(t.view)
    t.view.webContents.close()
  } catch (_) {}
  if (!w.tabs.length) { w.win.close(); return }
  if (w.activeId === id) {
    const n = w.tabs[w.tabs.length - 1]
    try { n.view.setVisible(true) } catch (_) { w.win.contentView.addChildView(n.view) }
    w.activeId = n.id
    applyLayout(w)
    n.view.webContents.focus()
  }
  sendState(w)
}

function toggleBm(url, title) {
  const i = bmIndex(url)
  if (i >= 0) data.bookmarks.splice(i, 1)
  else data.bookmarks.unshift({ url, title: title || url, date: Date.now() })
  storage.save(data)
  sendBm()
  eachW(applyLayout)
  bcast()
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

const LOCAL = process.env.LOCALAPPDATA || ''
const ROAM = process.env.APPDATA || ''

const BROWSERS = [
  { id: 'chrome', name: 'chrome', kind: 'cr', dir: () => path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'edge', kind: 'cr', dir: () => path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
  { id: 'brave', name: 'brave', kind: 'cr', dir: () => path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'yandex', name: 'яндекс', kind: 'cr', dir: () => path.join(LOCAL, 'Yandex', 'YandexBrowser', 'User Data') },
  { id: 'opera', name: 'opera', kind: 'cr', flat: true, dir: () => path.join(ROAM, 'Opera Software', 'Opera Stable') },
  { id: 'firefox', name: 'firefox', kind: 'ff', dir: () => path.join(ROAM, 'Mozilla', 'Firefox', 'Profiles') },
]

function profLabel(b, n) {
  const sec = String(n || '').split('.')[0]
  return b.name + (!sec || sec === 'Default' ? '' : ' · ' + sec.toLowerCase())
}

function importProfiles() {
  const out = []
  for (const b of BROWSERS) {
    const dir = b.dir()
    let names = []
    try { names = fs.readdirSync(dir) } catch (_) { continue }
    if (b.flat) names = ['']
    for (const n of names) {
      if (!b.flat && b.kind === 'cr' && n !== 'Default' && !/^Profile \d+$/.test(n)) continue
      const p = n ? path.join(dir, n) : dir
      const hasBookmarks = fs.existsSync(path.join(p, b.kind === 'ff' ? 'places.sqlite' : 'Bookmarks'))
      const hasHistory = fs.existsSync(path.join(p, b.kind === 'ff' ? 'places.sqlite' : 'History'))
      if (!hasBookmarks && !hasHistory) continue
      out.push({ id: b.id + '|' + (n || '0'), name: b.name, kind: b.kind, dir: p, label: profLabel(b, n), hasBookmarks, hasHistory })
    }
  }
  return out
}

function withDb(file, fn) {
  let sqlite = null
  try { sqlite = require('node:sqlite') } catch (_) { return null }
  const tmp = path.join(app.getPath('temp'), 'liber-imp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.db')
  try {
    fs.copyFileSync(file, tmp)
    for (const suf of ['-wal', '-shm']) if (fs.existsSync(file + suf)) fs.copyFileSync(file + suf, tmp + suf)
  } catch (_) { return null }
  let out = null
  try {
    const db = new sqlite.DatabaseSync(tmp, { readOnly: true })
    out = fn(db)
    db.close()
  } catch (_) {
    out = null
  }
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f) } catch (_) {} }
  return out
}

function parseBookmarks(file, folder, out) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return }
  const walk = (node, f) => {
    if (!node) return
    if (node.type === 'url' && node.url) {
      out.push({ url: node.url, title: node.name || node.url, folder: f })
      return
    }
    const nf = node.type === 'folder' && node.name ? node.name : f
    for (const c of node.children || []) walk(c, nf)
  }
  const roots = raw.roots || {}
  for (const k of ['bookmark_bar', 'other', 'synced']) {
    const r = roots[k]
    if (!r) continue
    for (const c of r.children || []) walk(c, folder)
  }
}

function readFirefoxBookmarks(dir, folder) {
  const rows = withDb(path.join(dir, 'places.sqlite'), db => db.prepare('SELECT b.id, b.parent, b.type, b.title, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk').all())
  if (!rows) return null
  const kids = new Map()
  const meta = new Map()
  for (const r of rows) {
    meta.set(r.id, r)
    if (!kids.has(r.parent)) kids.set(r.parent, [])
    kids.get(r.parent).push(r.id)
  }
  const out = []
  const walk = (id, f) => {
    for (const cid of kids.get(id) || []) {
      const n = meta.get(cid)
      if (!n) continue
      if (n.type === 1) {
        if (n.url) out.push({ url: n.url, title: n.title || n.url, folder: f })
      } else if (n.type === 2) {
        const t = String(n.title || '').trim()
        if (/^(tags|метки)$/i.test(t)) continue
        walk(cid, t || f)
      }
    }
  }
  walk(0, folder)
  return out
}

function readChromeHistory(file, limit) {
  const rows = withDb(file, db => db.prepare('SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?').all(limit))
  if (!rows) return null
  return rows.filter(r => r.url).map(r => ({ url: r.url, title: r.title || r.url, date: Math.max(0, Number(r.last_visit_time) / 1000 - 11644473600000) }))
}

function readFirefoxHistory(dir, limit) {
  const rows = withDb(path.join(dir, 'places.sqlite'), db => db.prepare('SELECT url, title, last_visit_date FROM moz_places WHERE last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ?').all(limit))
  if (!rows) return null
  return rows.filter(r => r.url).map(r => ({ url: r.url, title: r.title || r.url, date: Math.max(0, Number(r.last_visit_date) / 1000) }))
}

function importRun(opts) {
  const o = opts || {}
  const p = importProfiles().find(x => x.id === o.id)
  if (!p) return { bookmarks: 0, history: 0, historyOk: false }
  let added = 0
  if (o.bookmarks && p.hasBookmarks) {
    const found = p.kind === 'ff' ? readFirefoxBookmarks(p.dir, p.label) : []
    if (p.kind !== 'ff') parseBookmarks(path.join(p.dir, 'Bookmarks'), p.label, found)
    const have = new Set(data.bookmarks.map(b => b.url))
    for (const b of found || []) {
      if (!b.url || have.has(b.url)) continue
      have.add(b.url)
      data.bookmarks.push({ url: b.url, title: b.title, folder: p.label, date: Date.now() })
      added += 1
    }
    if (added && !data.bmFolders.includes(p.label)) data.bmFolders.push(p.label)
    if (added) {
      storage.save(data)
      sendBm()
      eachW(applyLayout)
      bcast()
    }
  }
  let rows = []
  let historyOk = false
  if (o.history && p.hasHistory) {
    const res = p.kind === 'ff' ? readFirefoxHistory(p.dir, 3000) : readChromeHistory(path.join(p.dir, 'History'), 3000)
    historyOk = !!res
    rows = res || []
  }
  let hAdded = 0
  if (rows.length) {
    const map = new Map()
    for (const h of data.history) map.set(h.url, h)
    for (const r of rows) {
      const ex = map.get(r.url)
      if (!ex || r.date > ex.date) map.set(r.url, r)
    }
    data.history = [...map.values()].sort((a, b) => b.date - a.date).slice(0, 1000)
    storage.save(data)
    hAdded = rows.length
  }
  return { bookmarks: added, history: hAdded, historyOk }
}

function hostKey(h) {
  return String(h || '').replace(/^www\./i, '').toLowerCase()
}

function pwFind(host) {
  const h = hostKey(host)
  return vault.find(c => hostKey(c.host) === h) || null
}

function pwList() {
  return vault.map(({ host, user, date }) => ({ host, user, date }))
}

function saveVault() {
  try {
    if (safeStorage.isEncryptionAvailable()) data.vault = safeStorage.encryptString(JSON.stringify(vault)).toString('base64')
    else data.vault = JSON.stringify(vault)
    storage.save(data)
  } catch (_) {}
}

function pwSave(host, user, pass) {
  const h = hostKey(host)
  if (!h || !pass) return
  const i = vault.findIndex(c => hostKey(c.host) === h && c.user === user)
  const rec = { host: h, user: user || '', pass, date: Date.now() }
  if (i >= 0) vault[i] = rec
  else vault.push(rec)
  saveVault()
}

const READER_KEEP = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'div', 'span', 'cite', 'sub', 'sup'])
const readerCache = new Map()
let readerSeq = 0

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<(script|style|iframe|object|embed|svg|math|form|input|button|link|meta|video|audio|source|template)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, tag => {
      const m = /^<(\/?)([a-zA-Z0-9]+)[\s\S]*>$/.exec(tag)
      if (!m) return ''
      const name = m[2].toLowerCase()
      if (!READER_KEEP.has(name)) return ''
      if (m[1]) return '</' + name + '>'
      if (name === 'a') {
        const h = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
        const href = (h && (h[2] || h[3] || '')) || ''
        return /^https?:/i.test(href) ? '<a href="' + href.replace(/"/g, '&quot;') + '" target="_blank" rel="noreferrer">' : '<a>'
      }
      if (name === 'img') {
        const s = /src\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
        const src = (s && (s[2] || s[3] || '')) || ''
        return /^https?:/i.test(src) ? '<img src="' + src.replace(/"/g, '&quot;') + '">' : ''
      }
      return '<' + name + '>'
    })
    .replace(/(<br\s*\/?>){3,}/gi, '<br><br>')
}

function openReader(w, t, article) {
  if (!w || !t || !article || !article.html) return
  readerSeq += 1
  readerCache.set(readerSeq, {
    url: t.url,
    title: article.title || t.title || t.url,
    html: sanitizeHtml(article.html),
    date: Date.now(),
  })
  if (readerCache.size > 20) {
    let oldest = null
    for (const [k, v] of readerCache) if (!oldest || v.date < readerCache.get(oldest).date) oldest = k
    if (oldest) readerCache.delete(oldest)
  }
  newTab('liber://reader?id=' + readerSeq, w)
}

function attachLiber(s) {
  try {
    s.protocol.handle('liber', req => {
      let name = ''
      try { name = new URL(req.url).hostname } catch (_) {}
      if (!/^[a-z][a-z0-9-]*$/.test(name)) name = 'start'
      let body = null
      try { body = fs.readFileSync(path.join(__dirname, 'ui', name + '.html')) } catch (_) {}
      if (!body) return new Response('', { status: 404 })
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  } catch (_) {}
  return s
}

function translateUrl(url) {
  return 'https://www.translatetheweb.com/?from=auto&to=ru&a=' + encodeURIComponent(url)
}

function readerOf(w) {
  const t = activeTab(w)
  if (t && /^https?:/i.test(t.url)) t.view.webContents.send('reader-mode')
}

function onWillDownload(e, item) {
  const f = uniquePath(dlDirOf(), item.getFilename())
  item.setSavePath(f)
  const entry = { id: ++dlSeq, name: path.basename(f), path: f, url: item.getURL(), state: 'progressing', received: 0, total: item.getTotalBytes(), date: Date.now() }
  dls.unshift(entry)
  dlItems.set(entry.id, item)
  sendDls()
  bcast()
  item.on('updated', () => {
    if (Date.now() - dlsTick < 400) return
    dlsTick = Date.now()
    entry.state = item.isPaused() ? 'paused' : 'progressing'
    entry.received = item.getReceivedBytes()
    entry.total = item.getTotalBytes()
    sendDls()
    bcast()
  })
  item.once('done', (i, st) => {
    entry.state = st === 'completed' ? 'completed' : st === 'cancelled' ? 'cancelled' : 'interrupted'
    entry.received = item.getReceivedBytes()
    entry.total = item.getTotalBytes()
    dlItems.delete(entry.id)
    persistDls()
    sendDls()
    bcast()
  })
}

function setupSession(s) {
  const ALLOW = new Set(['media', 'fullscreen', 'pointerLock', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'display-capture'])
  s.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOW.has(permission)))
  s.setPermissionCheckHandler((wc, permission) => ALLOW.has(permission))
  s.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(srcs => cb(srcs.length ? { video: srcs[0], audio: 'loopback' } : {}))
      .catch(() => cb({}))
  })
  s.on('will-download', onWillDownload)
}

function createWindow(opts) {
  const o = opts || {}
  const s = o.private
    ? session.fromPartition('private:' + Date.now() + '-' + Math.floor(Math.random() * 1e9), { cache: false })
    : ses
  if (o.private) {
    setupSession(s)
    attachLiber(s)
    liveSessions.add(s)
    applyProxyTo(s, bypass.status())
  }
  const b = o.bounds && Number.isInteger(o.bounds.width) ? o.bounds : {}
  const bw = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 840,
    x: b.x,
    y: b.y,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0b0c10',
    show: false,
    title: o.private ? 'Liber — инкогнито' : 'Liber',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  const w = { win: bw, tabs: [], activeId: null, expanded: false, vidFs: false, closedTabs: [], isPrivate: !!o.private, ses: s }
  windows.push(w)
  bw.setMenuBarVisibility(false)
  bw.once('ready-to-show', () => bw.show())
  bw.on('focus', () => { focusedW = w })
  bw.on('resize', () => applyLayout(w))
  bw.on('maximize', () => sendState(w))
  bw.on('unmaximize', () => sendState(w))
  bw.on('enter-full-screen', () => sendState(w))
  bw.on('leave-full-screen', () => sendState(w))
  bw.on('close', persist)
  bw.on('closed', () => {
    const i = windows.indexOf(w)
    if (i >= 0) windows.splice(i, 1)
    if (o.private) liveSessions.delete(s)
    if (focusedW === w) focusedW = windows[windows.length - 1] || null
  })
  bw.webContents.on('did-finish-load', () => { sendBm(); sendSettings(); sendDls(); sendState(w) })
  bw.webContents.on('context-menu', (e, p) => {
    const items = []
    if (p.isEditable) {
      items.push({ label: 'вырезать', role: 'cut', enabled: p.editFlags.canCut })
      items.push({ label: 'копировать', role: 'copy', enabled: p.editFlags.canCopy })
      items.push({ label: 'вставить', role: 'paste', enabled: p.editFlags.canPaste })
      items.push({ label: 'вставить и перейти', enabled: p.editFlags.canPaste, click: () => { const txt = clipboard.readText().trim(); if (txt) bw.webContents.send('omni-paste', txt) } })
      items.push({ type: 'separator' })
      items.push({ label: 'выделить всё', role: 'selectAll' })
    } else if (p.selectionText) {
      items.push({ label: 'копировать', role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: bw })
  })
  if (process.env.LIBER_DEBUG) {
    bw.webContents.on('console-message', (e, level, message, line, sourceId) => console.log('[ui]', message, '(' + sourceId + ':' + line + ')'))
  }
  if (o.private) bw.loadFile(INDEX, { query: { priv: '1' } })
  else bw.loadFile(INDEX)
  for (const u of (o.tabs && o.tabs.length ? o.tabs : [null])) newTab(u, w)
  focusedW = w
  return w
}

ipcMain.handle('tab:new', (e, url) => {
  const w = wOfEvent(e)
  if (w) newTab(toUrl(url) || START_URL, w)
})
ipcMain.handle('tab:switch', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (w) switchTab(w, id)
})
ipcMain.handle('tab:close', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (w) closeTab(w, id)
})
ipcMain.handle('tab:dup', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (t && w && /^https?:/i.test(t.url)) newTab(t.url, w)
})
ipcMain.handle('tab:closeothers', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (!w) return
  for (const x of [...w.tabs]) if (x.id !== id) closeTab(w, x.id)
})
ipcMain.handle('tab:closeright', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (!w) return
  const i = w.tabs.findIndex(x => x.id === id)
  if (i < 0) return
  for (const x of w.tabs.slice(i + 1)) closeTab(w, x.id)
})
ipcMain.handle('tab:mute', (e, id) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (!t) return
  try {
    const wc = t.view.webContents
    wc.setAudioMuted(!wc.isAudioMuted())
  } catch (_) {}
  if (w) sendState(w)
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
ipcMain.handle('tab:reopen', (e) => {
  const w = wOfEvent(e)
  if (w) reopenClosed(w)
})
ipcMain.handle('tab:cycle', (e, d) => {
  const w = wOfEvent(e)
  if (w) switchRelative(w, d)
})
ipcMain.handle('tab:pick', (e, i) => {
  const w = wOfEvent(e)
  if (!w) return
  const t = i < 0 ? w.tabs[w.tabs.length - 1] : w.tabs[i]
  if (t) switchTab(w, t.id)
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
ipcMain.handle('page', (e, name) => {
  const w = wOfEvent(e)
  if (w) newTab(internalPage(name), w)
})
ipcMain.handle('page:nav', (e, q) => {
  const t = wcToTab(e.sender)
  if (!t) return
  const u = toUrl(q)
  if (u) t.view.webContents.loadURL(u).catch(() => {})
})
ipcMain.handle('zoom', (e, { id, d }) => {
  const t = tabById(id)
  if (!t) return
  const w = W_ofTab(t)
  if (d === 0) setZoom(t.view.webContents, 1, w)
  else zoomBy(t.view.webContents, d, w)
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
ipcMain.handle('chrome', (e, on) => {
  const w = winBySender(e.sender)
  if (!w) return
  w.expanded = !!on
  applyLayout(w)
})
ipcMain.handle('b:list', () => bmPayload())
ipcMain.handle('b:remove', (e, url) => {
  const i = bmIndex(url)
  if (i >= 0) {
    data.bookmarks.splice(i, 1)
    storage.save(data)
    sendBm()
    eachW(applyLayout)
    bcast()
  }
  return bmPayload()
})
ipcMain.handle('bf:add', (e, name) => bmFolderAdd(name))
ipcMain.handle('bf:del', (e, name) => bmFolderDel(name))
ipcMain.handle('b:move', (e, url, folder) => bmMove(url, folder))
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
  bcast()
})
ipcMain.handle('d:clear', () => {
  for (let i = dls.length - 1; i >= 0; i--) {
    if (dls[i].state !== 'progressing' && dls[i].state !== 'paused') dls.splice(i, 1)
  }
  persistDls()
  sendDls()
  bcast()
})
ipcMain.handle('imp:scan', () => importProfiles().map(p => ({ id: p.id, name: p.name, label: p.label, hasBookmarks: p.hasBookmarks, hasHistory: p.hasHistory })))
ipcMain.handle('imp:run', (e, opts) => importRun(opts))
ipcMain.handle('pw:get', (e, host) => {
  const w = W_ofTab(wcToTab(e.sender))
  if (w && w.isPrivate) return null
  const c = pwFind(host)
  return c ? { user: c.user, pass: c.pass } : null
})
ipcMain.handle('pw:list', () => pwList())
ipcMain.handle('pw:del', (e, host, user) => {
  vault = vault.filter(c => !(hostKey(c.host) === hostKey(host) && c.user === (user || '')))
  saveVault()
  return pwList()
})
ipcMain.on('pw:capture', async (e, c) => {
  if (!c || !c.pass || !c.host) return
  const t = wcToTab(e.sender)
  const w = W_ofTab(t)
  if (!w || w.isPrivate || w.win.isDestroyed()) return
  const h = hostKey(c.host)
  const ex = vault.find(x => hostKey(x.host) === h && x.user === (c.user || ''))
  if (ex && ex.pass === c.pass) return
  try {
    const res = await dialog.showMessageBox(w.win, {
      type: 'question',
      buttons: ['сохранить', 'не сейчас'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: 'сохранить пароль для ' + h + '?',
      detail: c.user ? 'логин: ' + c.user : 'пароль будет подставляться на этой странице',
    })
    if (res.response === 0) pwSave(h, c.user || '', c.pass)
  } catch (_) {}
})
ipcMain.on('reader-open', (e, a) => {
  const t = wcToTab(e.sender)
  openReader(W_ofTab(t), t, a)
})
ipcMain.handle('reader:get', (e, id) => {
  const a = readerCache.get(Number(id))
  if (!a) return null
  return { title: a.title, url: a.url, host: siteHostOf(a.url), html: a.html }
})
ipcMain.handle('reader:back', (e) => {
  const t = wcToTab(e.sender)
  const w = W_ofTab(t)
  if (!w || !t) return
  const i = w.tabs.findIndex(x => x.id === t.id)
  closeTab(w, t.id)
  const prev = w.tabs[Math.max(0, i - 1)]
  if (prev) switchTab(w, prev.id)
})
ipcMain.handle('tab:reader', (e) => {
  const w = wOfEvent(e)
  if (w) readerOf(w)
})
ipcMain.handle('tab:translate', (e) => {
  const w = wOfEvent(e)
  const t = w && activeTab(w)
  if (t && /^https?:/i.test(t.url)) newTab(translateUrl(t.url), w)
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
ipcMain.handle('st:pickdir', async (e) => {
  const w = wOfEvent(e)
  try {
    const res = await dialog.showOpenDialog(w ? w.win : null, { title: 'папка загрузок', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths.length) return ''
    applySettings({ downloadDir: res.filePaths[0] })
    return res.filePaths[0]
  } catch (_) {
    return ''
  }
})
ipcMain.handle('data:clear', async (e, what) => {
  const x = what || {}
  if (x.history) {
    data.history = []
    storage.save(data)
    bcast()
  }
  if (x.cache) {
    try { await ses.clearCache() } catch (_) {}
    for (const s of liveSessions) try { await s.clearCache() } catch (_) {}
  }
  if (x.site) {
    for (const s of liveSessions) try { await s.clearStorageData() } catch (_) {}
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
  if (t) zoomBy(t.view.webContents, deltaY < 0 ? 1 : -1, W_ofTab(t))
})
ipcMain.handle('win:new', (e, priv) => { createWindow({ private: !!priv }) })
ipcMain.handle('win:min', (e) => { const w = winBySender(e.sender); if (w) w.win.minimize() })
ipcMain.handle('win:max', (e) => {
  const w = winBySender(e.sender)
  if (!w) return
  if (w.win.isMaximized()) w.win.unmaximize()
  else w.win.maximize()
})
ipcMain.handle('win:close', (e) => { const w = winBySender(e.sender); if (w) w.win.close() })
ipcMain.handle('win:full', (e) => {
  const w = winBySender(e.sender)
  if (w) w.win.setFullScreen(!w.win.isFullScreen())
})

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (e, argv) => {
    const u = (argv || []).find(a => /^https?:\/\//i.test(a))
    if (focusedW && !focusedW.win.isDestroyed()) {
      if (focusedW.win.isMinimized()) focusedW.win.restore()
      focusedW.win.focus()
      if (u) newTab(u, focusedW)
    } else {
      createWindow(u ? { tabs: [u] } : {})
    }
  })

  app.whenReady().then(() => {
    ses = session.fromPartition('persist:liber')
    setupSession(ses)
    attachLiber(ses)
    liveSessions.add(ses)
    applyProxyTo(ses, false)
    bypass.start(on => applyProxyAll(on))

    const saved = Array.isArray(data.windows) && data.windows.length
      ? data.windows
      : (data.window || (data.tabs && data.tabs.length) ? [{ bounds: data.window, tabs: data.tabs || [] }] : [])
    if (settings.restore && saved.length) {
      for (const sw of saved) createWindow({ bounds: sw.bounds, tabs: sw.tabs })
    } else {
      createWindow({})
    }
    setInterval(() => persist(), 20000)
    if (process.env.LIBER_SELFTEST) setTimeout(selftest, 2500)
  })

  async function selftest() {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const w0 = windows[0]
    const js = code => w0.win.webContents.executeJavaScript(code)
    const dev = path.join(__dirname, '..', '_dev')
    try { fs.mkdirSync(dev, { recursive: true }) } catch (_) {}
    const shot = async name => {
      try {
        const img = await w0.win.webContents.capturePage()
        fs.writeFileSync(path.join(dev, name + '.png'), img.toPNG())
      } catch (e) { console.log('ST shot fail:', name, e.message) }
    }
    try {
      console.log('ST shell:', await js(`JSON.stringify({ href: location.href, more: !!document.getElementById('more'), lock: !!document.getElementById('lock'), tsearch: !!document.getElementById('tsearch'), err: window.__liberErr || null })`))
      console.log('ST windows:', windows.length, JSON.stringify(windows.map(w => ({ priv: w.isPrivate, tabs: w.tabs.length }))))
      console.log('ST restored:', JSON.stringify(w0.tabs.map(t => t.url)))
      const t0 = w0.tabs[0]
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
      let n = w0.tabs.length
      key('t', ['control'])
      await wait(500)
      console.log('ST tabs:', n, '->', w0.tabs.length)
      console.log('ST ctrl+W:')
      n = w0.tabs.length
      key('w', ['control'])
      await wait(400)
      console.log('ST tabs:', n, '->', w0.tabs.length)
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
      setZoom(wc0, 1, w0)
      console.log('ST ctrl+D on http tab:')
      await js(`(function(){ document.querySelectorAll('.tab')[0].click(); return 1 })()`)
      await wait(300)
      const bmBefore = data.bookmarks.length
      key('d', ['control'])
      await wait(400)
      console.log('ST bm:', bmBefore, '->', data.bookmarks.length)
      key('d', ['control'])
      await wait(400)
      console.log('ST bm back:', data.bookmarks.length)
      console.log('ST popup window.open:')
      n = w0.tabs.length
      await wc0.executeJavaScript(`window.open('https://example.com/?popup', '_blank'); 1`)
      await wait(900)
      console.log('ST tabs:', n, '->', w0.tabs.length, 'last:', w0.tabs[w0.tabs.length - 1].url)
      console.log('ST close popup + reopen closed:')
      n = w0.tabs.length
      key('w', ['control'])
      await wait(400)
      const afterClose = w0.tabs.length
      key('t', ['control', 'shift'])
      await wait(700)
      console.log('ST tabs:', n, '->', afterClose, '->', w0.tabs.length, 'last:', w0.tabs[w0.tabs.length - 1].url)
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
      console.log('ST last url:', w0.tabs[w0.tabs.length - 1].url)
      console.log('ST ctrl+1 first tab:')
      key('1', ['control'])
      await wait(400)
      console.log('ST active is first:', w0.activeId === w0.tabs[0].id)
      console.log('ST view-source:')
      n = w0.tabs.length
      newTab('view-source:https://example.com/', w0)
      await wait(1500)
      console.log('ST tabs:', n, '->', w0.tabs.length, 'src url:', w0.tabs[w0.tabs.length - 1].url)
      console.log('ST settings page:')
      await js(`window.liber.page('settings')`)
      await wait(900)
      console.log('ST settings url:', w0.tabs[w0.tabs.length - 1].url)
      const stTab = w0.tabs[w0.tabs.length - 1]
      console.log('ST settings cards:', await stTab.view.webContents.executeJavaScript(`JSON.stringify({ imp: !!document.getElementById('imp'), impText: (document.getElementById('imp').textContent || '').slice(0, 30), impRows: document.querySelectorAll('#imp .kv').length, pwcount: document.getElementById('pwcount').textContent })`))
      await js(`(function(){ document.querySelectorAll('.tab')[0].click(); return 1 })()`)
      await wait(500)
      console.log('ST lock icon:', await js(`(() => { const l = document.getElementById('lock'); return l ? l.title + '|' + l.textContent : 'none' })()`))
      console.log('ST search engine switch:')
      applySettings({ search: 'yandex' })
      console.log('ST toUrl search:', toUrl('привет мир'))
      applySettings({ search: 'ddg' })
      console.log('ST new window:')
      n = windows.length
      key('n', ['control'])
      await wait(1500)
      const w2 = windows[windows.length - 1]
      console.log('ST windows:', n, '->', windows.length, 'new tabs:', w2.tabs.length, 'priv:', w2.isPrivate)
      console.log('ST private window (ctrl+shift+N):')
      n = windows.length
      key('n', ['control', 'shift'])
      await wait(1500)
      const wp = windows[windows.length - 1]
      console.log('ST windows:', n, '->', windows.length, 'priv:', wp.isPrivate, 'ses:', wp.ses === ses ? 'shared' : 'own')
      const privUrl = 'https://example.com/?priv'
      wp.tabs[0].view.webContents.loadURL(privUrl)
      await wait(1500)
      console.log('ST priv recorded in history:', data.history.some(h => h.url === privUrl))
      console.log('ST shell priv flag:', await wp.win.webContents.executeJavaScript(`document.body.className`))
      console.log('ST close extra windows:')
      wp.win.close()
      w2.win.close()
      await wait(1000)
      console.log('ST windows left:', windows.length)
      console.log('ST tab search panel:')
      await js(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true })); return 1 })()`)
      await wait(500)
      console.log('ST tsearch state:', await js(`JSON.stringify({ cls: document.getElementById('tsearch').className, rows: document.querySelectorAll('.tsrow').length })`))
      await js(`document.getElementById('tsearch').classList.remove('show')`)
      console.log('ST bookmark folders:')
      toggleBm('https://liber.net/folder-test', 'folder test')
      const oneBm = data.bookmarks.find(b => b.url === 'https://liber.net/folder-test')
      bmFolderAdd('test-folder')
      bmMove(oneBm.url, 'test-folder')
      console.log('ST folder move:', String(oneBm.folder), 'folders:', JSON.stringify(data.bmFolders))
      console.log('ST bms page:')
      await js(`window.liber.page('bms')`)
      await wait(800)
      const bmsTab = w0.tabs[w0.tabs.length - 1]
      console.log('ST bms ui:', await bmsTab.view.webContents.executeJavaScript(`JSON.stringify({ side: document.querySelectorAll('.fbtn').length, sels: document.querySelectorAll('.mini-sel').length, rows: document.querySelectorAll('.item').length })`))
      closeTab(w0, bmsTab.id)
      await wait(400)
      bmFolderDel('test-folder')
      console.log('ST folder del:', JSON.stringify(data.bmFolders), 'item folder:', String(oneBm.folder))
      toggleBm('https://liber.net/folder-test')
      console.log('ST folder cleanup bm:', data.bookmarks.length)
      console.log('ST reader mode:')
      switchTab(w0, w0.tabs[0].id)
      await wc0.loadURL('https://example.com/')
      await wait(1500)
      await wc0.executeJavaScript(`document.body.innerHTML = '<article><h1>Заголовок статьи</h1><p>' + 'Абзац текста для проверки режима чтения, достаточно длинный чтобы алгоритм выбрал именно этот блок страницы. '.repeat(8) + '</p><p>' + 'Второй абзац статьи, тоже длинный, продолжает проверку извлечения текста целиком без мусора. '.repeat(5) + '</p><script>window.__pwn = 1<\/script><img src=x onerror="window.__pwn=2"></article>'`)
      await wait(600)
      key('F9')
      await wait(1200)
      const rdTab = w0.tabs[w0.tabs.length - 1]
      console.log('ST reader tab:', w0.tabs.length, rdTab.url)
      console.log('ST reader state:', JSON.stringify({ now: rdTab.view.webContents.getURL(), loading: rdTab.view.webContents.isLoading() }))
      const rdUi = await Promise.race([
        rdTab.view.webContents.executeJavaScript(`JSON.stringify({ title: document.getElementById('title').textContent, host: document.getElementById('host').textContent, bodyScripts: document.querySelectorAll('#body script').length, pwn: typeof window.__pwn, onerror: document.querySelectorAll('[onerror]').length, hasText: document.getElementById('body').innerText.indexOf('Абзац текста') >= 0 })`),
        wait(5000).then(() => 'TIMEOUT'),
      ])
      console.log('ST reader page:', rdUi)
      console.log('ST translate url:', translateUrl('https://example.com/страница'))
      closeTab(w0, rdTab.id)
      await wait(400)
      console.log('ST reader closed, tabs:', w0.tabs.length)
      console.log('ST import scan:', JSON.stringify(importProfiles().map(p => p.id)))
      const prof = importProfiles().find(p => p.hasBookmarks)
      if (prof) {
        const r = importRun({ id: prof.id, bookmarks: true })
        console.log('ST import bookmarks:', r.bookmarks, 'folder:', prof.label)
        const keepHist = data.history
        const rh = importRun({ id: prof.id, history: true })
        console.log('ST import history:', rh.history, 'ok:', rh.historyOk, 'sample:', data.history[0] ? data.history[0].url.slice(0, 40) : '-')
        data.history = keepHist
        data.bookmarks = data.bookmarks.filter(b => b.folder !== prof.label)
        bmFolderDel(prof.label)
        storage.save(data)
        console.log('ST import cleanup:', data.bookmarks.length, 'history:', data.history.length)
      } else {
        console.log('ST import: no profile found')
      }
      console.log('ST sqlite:', (() => { try { require('node:sqlite'); return 'yes' } catch (_) { return 'no' } })())
      console.log('ST passwords:')
      pwSave('example.com', 'user1', 'secret1')
      const got = pwFind('www.example.com')
      console.log('ST pw match www:', got ? got.user + '/' + got.pass : 'none')
      console.log('ST pw list:', pwList().length, 'vault encrypted:', !!data.vault)
      vault = []
      saveVault()
      console.log('ST pw cleared:', pwList().length)
      persist()
      const saved = storage.load()
      console.log('ST persisted windows:', JSON.stringify((saved.windows || []).map(w => w.tabs.length)))
      console.log('ST history:', saved.history.length)
    } catch (e) {
      console.log('ST FATAL:', e.message)
    }
    console.log('ST done')
  }

  app.on('window-all-closed', () => app.quit())
}
