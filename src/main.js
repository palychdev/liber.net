const { app, BrowserWindow, ipcMain, WebContentsView, session, Menu, clipboard, desktopCapturer, shell, dialog, safeStorage, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const bypass = require('./bypass')
const storage = require('./storage')
const { Adblock, regDomain } = require('./adblock')

const BAR_H = 52
const OMNI_H = 44
const BM_H = 34
const SUG_H = 160
const ENGINE_PORT = 1079
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const ENGINES = {
  ddg: { label: 'duckduckgo', url: 'https://duckduckgo.com/?q=%s', keyword: 'd' },
  google: { label: 'google', url: 'https://www.google.com/search?q=%s', keyword: 'g' },
  yandex: { label: 'яндекс', url: 'https://yandex.ru/search/?text=%s', keyword: 'y' },
  bing: { label: 'bing', url: 'https://www.bing.com/search?q=%s', keyword: 'b' },
}
const GRP_COLORS = ['#8a7bff', '#3ddc97', '#ffb454', '#ff5f56', '#4aa8ff', '#c77bff', '#5ed3d3', '#8b8d97']
const RAIL_W = 236
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
const settings = Object.assign({ search: 'ddg', homepage: '', downloadDir: '', bmBar: true, restore: true, vtab: false, zoom: {} }, data.settings || {})
data.settings = settings
data.engines = Array.isArray(data.engines) ? data.engines.filter(e => e && typeof e.id === 'string' && typeof e.url === 'string' && e.url.includes('%s')) : []
const userEngines = data.engines
data.siteRules = data.siteRules && typeof data.siteRules === 'object' ? data.siteRules : {}
const siteRules = data.siteRules
const adblock = new Adblock()
adblock.on = settings.adblock !== false
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

function engineById(id) {
  if (ENGINES[id]) return ENGINES[id]
  return userEngines.find(e => e.id === id) || null
}

function engine() {
  return engineById(settings.search) || ENGINES.ddg
}

function engList() {
  const out = []
  for (const id of Object.keys(ENGINES)) {
    out.push({ id, label: ENGINES[id].label, url: ENGINES[id].url, keyword: ENGINES[id].keyword || '', builtin: true })
  }
  for (const e of userEngines) out.push({ id: e.id, label: e.label, url: e.url, keyword: e.keyword || '', builtin: false })
  return out
}

function keywordEngine(word) {
  const w = String(word || '').toLowerCase()
  if (!w) return null
  for (const id of Object.keys(ENGINES)) {
    if ((ENGINES[id].keyword || '').toLowerCase() === w) return ENGINES[id]
  }
  return userEngines.find(e => (e.keyword || '').toLowerCase() === w) || null
}

function engSave(p) {
  if (!p || typeof p !== 'object') return null
  const label = String(p.label || '').trim().slice(0, 40)
  const url = String(p.url || '').trim()
  const keyword = String(p.keyword || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!label || !/^https?:\/\/.+/i.test(url) || !url.includes('%s')) return null
  const cur = p.id ? userEngines.find(e => e.id === p.id) : null
  const taken = keywordEngine(keyword)
  if (keyword && taken && (!cur || taken !== cur)) return null
  if (cur) {
    cur.label = label
    cur.url = url
    cur.keyword = keyword
  } else {
    userEngines.push({ id: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 4096).toString(36), label, url, keyword })
  }
  storage.save(data)
  return engList()
}

function engDel(id) {
  const i = userEngines.findIndex(e => e.id === id)
  if (i >= 0) {
    userEngines.splice(i, 1)
    if (settings.search === id) {
      settings.search = 'ddg'
      sendSettings()
    }
    storage.save(data)
  }
  return engList()
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
  const kw = s.match(/^(\S+)\s+([\s\S]+)$/)
  if (kw) {
    const e = keywordEngine(kw[1])
    if (e) return e.url.replace('%s', encodeURIComponent(kw[2].trim()))
  }
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
  eachW(w => w.win.webContents.send('settings', { bmBar: settings.bmBar, search: settings.search, homepage: settings.homepage, vtab: !!settings.vtab }))
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
        pinned: !!t.pinned,
        group: t.group || '',
      }
    }),
    groups: w.groups.map(g => ({ id: g.id, name: g.name, color: g.color, collapsed: !!g.collapsed, count: w.tabs.filter(t => t.group === g.id).length })),
    engine: bypass.status(),
    dls: act.length,
    dlsName: act.length ? act[0].name : '',
    dlsPct: act.length && act[0].total > 0 ? Math.round((act[0].received / act[0].total) * 100) : 0,
    zoom,
    fs: w.win.isFullScreen(),
    muted,
    audible,
    private: w.isPrivate,
    vtab: !!settings.vtab,
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

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlUnesc(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 0))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, '')
}

function bmExportHtml() {
  const ts = Math.floor(Date.now() / 1000)
  const a = b => '    <DT><A HREF="' + htmlEsc(b.url) + '" ADD_DATE="' + Math.floor((b.date || Date.now()) / 1000) + '">' + htmlEsc(b.title || b.url) + '</A>'
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ]
  for (const b of data.bookmarks) {
    if (!b.folder) out.push(a(b))
  }
  for (const f of data.bmFolders) {
    out.push('    <DT><H3 ADD_DATE="' + ts + '" LAST_MODIFIED="' + ts + '">' + htmlEsc(f) + '</H3>')
    out.push('    <DL><p>')
    for (const b of data.bookmarks) {
      if (b.folder === f) out.push('    ' + a(b))
    }
    out.push('    </DL><p>')
  }
  out.push('</DL><p>', '')
  return out.join('\n')
}

function parseBmHtml(text) {
  const out = []
  const stack = []
  const re = /<\/dl[^>]*>|(?:<dt[^>]*>\s*)?<h3[^>]*>([\s\S]*?)<\/h3>|<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let m = null
  while ((m = re.exec(String(text || '')))) {
    if (/^<\/dl/i.test(m[0])) {
      if (stack.length) stack.pop()
      continue
    }
    if (m[1] !== undefined) {
      const name = htmlUnesc(stripTags(m[1])).replace(/\s+/g, ' ').trim()
      stack.push(name)
      continue
    }
    const url = htmlUnesc(m[2]).trim()
    if (!/^(https?|ftp|file):/i.test(url)) continue
    const title = htmlUnesc(stripTags(m[3])).replace(/\s+/g, ' ').trim()
    out.push({ url, title: title || url, folder: stack.filter(Boolean).join(' / ') })
  }
  return out
}

function bmImportHtml(text) {
  const list = parseBmHtml(text)
  const have = new Set(data.bookmarks.map(b => b.url))
  let added = 0
  let folders = 0
  for (const it of list) {
    if (have.has(it.url)) continue
    have.add(it.url)
    if (it.folder && !data.bmFolders.includes(it.folder)) {
      data.bmFolders.push(it.folder)
      folders += 1
    }
    data.bookmarks.push({ url: it.url, title: it.title, folder: it.folder || '', date: Date.now() })
    added += 1
  }
  storage.save(data)
  sendBm()
  bcast()
  return { found: list.length, added, folders }
}

function setPinned(w, id, on) {
  const t = w.tabs.find(x => x.id === id)
  if (!t || !!t.pinned === !!on) return
  t.pinned = !!on
  if (t.pinned) t.group = ''
  const rest = w.tabs.filter(x => x.id !== id)
  let idx = 0
  while (idx < rest.length && rest[idx].pinned) idx += 1
  rest.splice(idx, 0, t)
  w.tabs = rest
  sendState(w)
}

function grpById(w, gid) {
  return w.groups.find(g => g.id === gid) || null
}

function grpReorder(w) {
  const pinned = w.tabs.filter(t => t.pinned)
  const rest = w.tabs.filter(t => !t.pinned)
  const out = []
  const done = new Set()
  for (const t of rest) {
    if (!t.group) {
      out.push(t)
      continue
    }
    if (!grpById(w, t.group)) {
      t.group = ''
      out.push(t)
      continue
    }
    if (done.has(t.group)) continue
    done.add(t.group)
    for (const x of rest) if (x.group === t.group) out.push(x)
  }
  w.tabs = pinned.concat(out)
}

function grpNew(w, name) {
  const g = {
    id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 4096).toString(36),
    name: String(name || '').trim().slice(0, 40) || 'группа ' + (w.groups.length + 1),
    color: GRP_COLORS[w.groups.length % GRP_COLORS.length],
    collapsed: false,
  }
  w.groups.push(g)
  return g
}

function grpAssign(w, id, gid) {
  const t = w.tabs.find(x => x.id === id)
  if (!t) return
  if (gid && !grpById(w, gid)) return
  if (t.pinned) t.pinned = false
  t.group = gid || ''
  grpReorder(w)
  storage.save(data)
  sendState(w)
}

function grpDel(w, gid) {
  for (const t of w.tabs) if (t.group === gid) t.group = ''
  w.groups = w.groups.filter(g => g.id !== gid)
  storage.save(data)
  sendState(w)
}

function grpCollapse(w, gid, on) {
  const g = grpById(w, gid)
  if (!g) return
  g.collapsed = on === undefined ? !g.collapsed : !!on
  sendState(w)
}

function grpRename(w, gid, name) {
  const g = grpById(w, gid)
  const n = String(name || '').trim().slice(0, 40)
  if (!g || !n) return
  g.name = n
  storage.save(data)
  sendState(w)
}

function grpColor(w, gid) {
  const g = grpById(w, gid)
  if (!g) return
  g.color = GRP_COLORS[(GRP_COLORS.indexOf(g.color) + 1) % GRP_COLORS.length]
  storage.save(data)
  sendState(w)
}

function persist() {
  data.windows = windows
    .filter(w => !w.isPrivate && !w.win.isDestroyed())
    .map(w => {
      const maxed = w.win.isMaximized() || w.win.isFullScreen()
      const b = maxed ? null : w.win.getBounds()
      return {
        bounds: b,
        tabs: w.tabs.map(t => {
          if (!/^https?:/i.test(t.url) && !t.pinned) return null
          const g = grpById(w, t.group)
          return { url: t.url, pinned: t.pinned ? 1 : 0, group: g ? g.name : '' }
        }).filter(Boolean),
        groups: w.groups.map(g => ({ name: g.name, color: g.color, collapsed: g.collapsed ? 1 : 0 })),
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
  const left = railW(w)
  for (const t of w.tabs) {
    t.view.setBounds({ x: left, y: top, width: Math.max(0, wd - left), height: Math.max(0, ht - top) })
  }
}

function railW(w) {
  if (!settings.vtab || !w || w.vidFs) return 0
  return RAIL_W
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
  if (typeof patch.search === 'string' && engineById(patch.search)) settings.search = patch.search
  if (typeof patch.homepage === 'string') settings.homepage = patch.homepage.trim()
  if (typeof patch.downloadDir === 'string') settings.downloadDir = patch.downloadDir
  if (typeof patch.bmBar === 'boolean') settings.bmBar = patch.bmBar
  if (typeof patch.restore === 'boolean') settings.restore = patch.restore
  if (typeof patch.vtab === 'boolean') settings.vtab = patch.vtab
  if (typeof patch.adblock === 'boolean') {
    settings.adblock = patch.adblock
    adblock.on = patch.adblock
  }
  if (patch.privacy && typeof patch.privacy === 'object') settings.privacy = patch.privacy
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
    const sr = siteRule(hostOfUrl(wc.getURL()))
    if (sr && sr.popups === 'deny') return { action: 'deny' }
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
      autoplayPolicy: (settings.privacy && settings.privacy.autoplay || 'allow') === 'allow'
        ? 'no-user-gesture-required'
        : (settings.privacy && settings.privacy.autoplay === 'block'
          ? 'user-gesture-required'
          : 'document-user-activation-required'),
    },
  })
  const t = { id, view, url: url || START_URL, title: '', loading: false, favicon: '', pinned: false, group: '' }
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
  const g = next.group ? grpById(w, next.group) : null
  if (g && g.collapsed) g.collapsed = false
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

const FILTER_LISTS = [
  { id: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'ruadlist', url: 'https://easylist-downloads.adblockplus.org/ruadlist.txt' },
]

let filterState = 'idle'

function filtersDir() {
  return path.join(app.getPath('userData'), 'filters')
}

function siteRule(host) {
  if (!host) return null
  const h = String(host).toLowerCase()
  return siteRules[h] || siteRules[regDomain(h)] || null
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch (_) {
    return ''
  }
}

function adsAllowed(docUrl) {
  const r = siteRule(hostOfUrl(docUrl))
  return !!(r && r.ads === 'allow')
}

const SR_KEYS = ['camera', 'microphone', 'notifications', 'location', 'clipboard', 'screen', 'popups', 'ads', 'js', 'cookies', 'images']

function normHost(host) {
  let h = String(host || '').trim().toLowerCase()
  if (!h) return ''
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].split('?')[0].split('#')[0].replace(/^www\./, '')
  if (h.includes('@')) h = h.split('@').pop()
  if (h.includes(':') && h[0] !== '[') h = h.split(':')[0]
  if (h === 'localhost') return h
  return /^[a-z0-9._-]{3,}$/.test(h) && h.includes('.') ? h : ''
}

function srSend(host, patch) {
  const h = normHost(host)
  if (!h || !patch || typeof patch !== 'object') return null
  const cur = Object.assign({}, siteRules[h] || {})
  for (const k of SR_KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v === 'allow' || v === 'deny' || v === true || v === false) cur[k] = (v === true ? 'allow' : v === false ? 'deny' : v)
    else delete cur[k]
  }
  if (Object.keys(cur).length) siteRules[h] = cur
  else delete siteRules[h]
  storage.save(data)
  return Object.assign({ host: h }, cur)
}

function srDel(host) {
  const h = normHost(host)
  if (h) delete siteRules[h]
  storage.save(data)
}

function srList() {
  return Object.keys(siteRules).sort().map(h => ({ host: h, rule: Object.assign({}, siteRules[h]) }))
}

async function clearSiteData(sesObj, host) {
  const h = String(host || '').trim().toLowerCase().replace(/^www\./, '')
  if (!h || !sesObj) return 0
  const parts = h.split('.')
  const doms = new Set([h])
  if (parts.length > 2) doms.add(parts.slice(-2).join('.'))
  let removed = 0
  for (const d of doms) {
    const list = await sesObj.cookies.get({ domain: d }).catch(() => [])
    for (const c of list) {
      const url = (c.secure ? 'https://' : 'http://') + String(c.domain || d).replace(/^\./, '') + (c.path || '/')
      try {
        await sesObj.cookies.remove(url, c.name)
        removed += 1
      } catch (_) {}
    }
  }
  const storages = ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'shadercache', 'websql']
  for (const d of doms) {
    for (const origin of ['https://' + d, 'http://' + d]) {
      try {
        await sesObj.clearStorageData({ origin, storages })
      } catch (_) {}
    }
  }
  return removed
}

const PERM_KINDS = {
  'clipboard-read': 'clipboard',
  'display-capture': 'screen',
  geolocation: 'location',
  notifications: 'notifications',
}

const SILENT_PERMS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'idle-detection', 'speaker-selection', 'mediaKeySystem', 'window-management'])

const PERM_LABELS = {
  camera: 'камеру',
  microphone: 'микрофон',
  notifications: 'уведомления',
  location: 'геолокацию',
  clipboard: 'буфер обмена',
  screen: 'захват экрана',
}

function permKind(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || []
    if (types.includes('video')) return 'camera'
    if (types.includes('audio')) return 'microphone'
    return 'camera'
  }
  return PERM_KINDS[permission] || ''
}

function permDecision(host, kind) {
  const r = siteRule(host)
  const v = r ? r[kind] : ''
  return v === 'allow' || v === 'deny' ? v : 'ask'
}

function hostFromReq(wc, details) {
  const raw = (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : '')
  return hostOfUrl(raw)
}

async function askPermission(wc, host, kind) {
  if (!host) return false
  const w = W_ofTab(wcToTab(wc))
  const opt = {
    type: 'question',
    buttons: ['разрешить', 'запретить'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: host + ' запрашивает ' + (PERM_LABELS[kind] || kind),
    detail: 'liber запомнит выбор. поменять можно в настройках, раздел «разрешения сайтов».',
  }
  let res = null
  try {
    res = w && !w.win.isDestroyed() ? await dialog.showMessageBox(w.win, opt) : await dialog.showMessageBox(opt)
  } catch (_) {
    return false
  }
  const ok = res.response === 0
  srSend(host, { [kind]: ok ? 'allow' : 'deny' })
  return ok
}

function docUrlOfDetails(details) {
  let doc = ''
  try {
    doc = details.frame ? details.frame.url : ''
  } catch (_) {}
  if (!doc) {
    const t = tabByWcId(details.webContentsId)
    if (t) doc = t.url
  }
  return doc
}

function tabByWcId(id) {
  for (const w of windows) {
    for (const t of w.tabs) {
      try {
        if (t.view.webContents.id === id) return t
      } catch (_) {}
    }
  }
  return null
}

async function fetchFilterList(list) {
  const dir = filtersDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
  const file = path.join(dir, list.id + '.txt')
  let stat = null
  try { stat = fs.statSync(file) } catch (_) {}
  if (stat && Date.now() - stat.mtimeMs < 5 * 86400000) {
    try { return fs.readFileSync(file, 'utf8') } catch (_) {}
  }
  const s = ses || session.defaultSession
  try {
    const res = await s.fetch(list.url, { cache: 'no-store' })
    if (res.ok) {
      const text = await res.text()
      if (text.length > 2000) {
        try { fs.writeFileSync(file, text) } catch (_) {}
        return text
      }
    }
  } catch (_) {}
  try { return fs.readFileSync(file, 'utf8') } catch (_) {}
  return null
}

async function loadFilters(force) {
  if (filterState === 'loading') return adblock.stats()
  filterState = 'loading'
  if (force) {
    try {
      for (const f of fs.readdirSync(filtersDir())) {
        if (f.endsWith('.txt')) fs.unlinkSync(path.join(filtersDir(), f))
      }
    } catch (_) {}
  }
  const texts = []
  for (const l of FILTER_LISTS) {
    const t = await fetchFilterList(l)
    if (t) texts.push(t)
  }
  if (!texts.length) {
    filterState = 'failed'
    return adblock.stats()
  }
  adblock.clear()
  for (const text of texts) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 5000) {
      const end = Math.min(i + 5000, lines.length)
      for (let j = i; j < end; j++) adblock.addLine(lines[j].trim())
      if (end < lines.length) await new Promise(r => setImmediate(r))
    }
  }
  adblock.finish()
  filterState = 'ready'
  for (const w of windows) {
    for (const t of w.tabs) {
      try { t.view.webContents.send('ads:cosmetic-refresh') } catch (_) {}
    }
  }
  return adblock.stats()
}

function setupSession(s) {
  s.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (SILENT_PERMS.has(permission)) return cb(true)
    const kind = permKind(permission, details)
    if (!kind) return cb(false)
    const host = hostFromReq(wc, details)
    const dec = permDecision(host, kind)
    if (dec === 'allow') return cb(true)
    if (dec === 'deny') return cb(false)
    askPermission(wc, host, kind).then(ok => cb(ok)).catch(() => cb(false))
  })
  s.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (SILENT_PERMS.has(permission)) return true
    const kind = permKind(permission, details)
    if (!kind) return false
    const host = hostOfUrl(origin) || hostFromReq(wc, details)
    return permDecision(host, kind) === 'allow'
  })
  s.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(srcs => cb(srcs.length ? { video: srcs[0], audio: 'loopback' } : {}))
      .catch(() => cb({}))
  })
  s.on('will-download', onWillDownload)
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const doc = docUrlOfDetails(details)
    const sr = siteRule(hostOfUrl(doc)) || siteRule(hostOfUrl(details.url))
    if (sr) {
      if (details.resourceType === 'script' && sr.js === 'deny') return cb({ cancel: true })
      if (details.resourceType === 'image' && sr.images === 'deny') return cb({ cancel: true })
    }
    if (details.resourceType === 'mainFrame' || !adblock.ready || !adblock.on) return cb({})
    if (sr && sr.ads === 'allow') return cb({})
    cb(adblock.check(details.url, details.resourceType, doc) ? { cancel: true } : {})
  })
  s.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const h = details.requestHeaders || {}
    if (settings.privacy && settings.privacy.dnt) h['DNT'] = '1'
    if (settings.privacy && settings.privacy.thirdParty && details.frame) {
      const tHost = hostOfUrl(String(details.frame.top && details.frame.top.url || ''))
      const rHost = hostOfUrl(details.url)
      if (tHost && rHost && regDomain(tHost) !== regDomain(rHost)) {
        for (const k of Object.keys(h)) if (k.toLowerCase() === 'cookie') delete h[k]
      }
    }
    const sr = siteRule(hostOfUrl(details.url))
    if (sr && sr.cookies === 'deny') {
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'cookie') delete h[k]
    }
    cb({ requestHeaders: details.requestHeaders })
  })
  s.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, cb) => {
    const headers = details.responseHeaders || {}
    if (settings.privacy && settings.privacy.thirdParty && details.frame) {
      const tHost = hostOfUrl(String(details.frame.top && details.frame.top.url || ''))
      const rHost = hostOfUrl(details.url)
      if (tHost && rHost && regDomain(tHost) !== regDomain(rHost)) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'set-cookie') delete headers[k]
      }
    }
    const sr = siteRule(hostOfUrl(details.url))
    if (sr && sr.cookies === 'deny') {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'set-cookie') delete headers[k]
      }
    }
    if (details.resourceType === 'mainFrame' && sr && sr.js === 'deny') {
      const key = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy')
      if (key) headers[key] = headers[key].map(v => v + ", script-src 'none'")
      else headers['Content-Security-Policy'] = ["script-src 'none'"]
    }
    cb({ responseHeaders: headers })
  })
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
  const w = { win: bw, tabs: [], activeId: null, expanded: false, vidFs: false, closedTabs: [], groups: [], isPrivate: !!o.private, ses: s }
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
  for (const sg of (Array.isArray(o.groups) ? o.groups : [])) {
    if (!sg || !sg.name) continue
    const g = grpNew(w, sg.name)
    if (sg.color) g.color = sg.color
    if (sg.collapsed) g.collapsed = true
  }
  for (const it of (o.tabs && o.tabs.length ? o.tabs : [null])) {
    const raw = typeof it === 'string' ? it : (it && (it.url || it.u)) || START_URL
    const id = newTab(raw, w)
    if (it && typeof it === 'object') {
      const t = w.tabs.find(x => x.id === id)
      if (t) {
        if (it.pinned || it.p) t.pinned = true
        const want = it.group || it.g
        if (want && t) {
          const g = w.groups.find(x => x.name === want)
          if (g) t.group = g.id
        }
      }
    }
  }
  if (w.tabs.some(t => t.pinned)) w.tabs = w.tabs.filter(t => t.pinned).concat(w.tabs.filter(t => !t.pinned))
  if (w.groups.length) grpReorder(w)
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
ipcMain.handle('tab:pin', (e, id, on) => {
  const t = tabById(id)
  const w = W_ofTab(t)
  if (w) setPinned(w, id, on)
})
ipcMain.handle('tab:reorder', (e, ids) => {
  const t = tabById(Array.isArray(ids) ? ids[0] : null)
  const w = t ? W_ofTab(t) : wOfEvent(e)
  if (!w || !Array.isArray(ids)) return
  const byId = new Map(w.tabs.map(x => [x.id, x]))
  const ordered = []
  for (const id of ids) { const x = byId.get(id); if (x) ordered.push(x) }
  const pinned = ordered.filter(x => x.pinned)
  const rest = ordered.filter(x => !x.pinned)
  w.tabs = pinned.concat(rest).concat(w.tabs.filter(x => !ordered.includes(x)))
  sendState(w)
})
ipcMain.handle('grp:new', (e, name, tabId) => {
  const t = tabId ? tabById(tabId) : null
  const w = t ? W_ofTab(t) : wOfEvent(e)
  if (!w) return
  const g = grpNew(w, name)
  if (t) grpAssign(w, t.id, g.id)
  else sendState(w)
})
ipcMain.handle('grp:assign', (e, tabId, gid) => {
  const w = W_ofTab(tabById(tabId))
  if (w) grpAssign(w, tabId, gid)
})
ipcMain.handle('grp:collapse', (e, gid, on) => {
  const w = wOfEvent(e)
  if (w) grpCollapse(w, gid, on)
})
ipcMain.handle('grp:rename', (e, gid, name) => {
  const w = wOfEvent(e)
  if (w) grpRename(w, gid, name)
})
ipcMain.handle('grp:color', (e, gid) => {
  const w = wOfEvent(e)
  if (w) grpColor(w, gid)
})
ipcMain.handle('grp:del', (e, gid) => {
  const w = wOfEvent(e)
  if (w) grpDel(w, gid)
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
ipcMain.handle('bm:export', async (e) => {
  const w = wOfEvent(e)
  try {
    const res = await dialog.showSaveDialog(w && !w.win.isDestroyed() ? w.win : null, {
      title: 'экспорт закладок',
      defaultPath: path.join(app.getPath('downloads'), 'liber-bookmarks-' + new Date().toISOString().slice(0, 10) + '.html'),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (res.canceled || !res.filePath) return ''
    fs.writeFileSync(res.filePath, bmExportHtml(), 'utf8')
    return res.filePath
  } catch (_) {
    return ''
  }
})
ipcMain.handle('bm:import', async (e) => {
  const w = wOfEvent(e)
  try {
    const res = await dialog.showOpenDialog(w && !w.win.isDestroyed() ? w.win : null, {
      title: 'импорт закладок',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths.length) return null
    return bmImportHtml(fs.readFileSync(res.filePaths[0], 'utf8'))
  } catch (_) {
    return null
  }
})
ipcMain.handle('settings:export', async (e) => {
  const w = wOfEvent(e)
  try {
    const res = await dialog.showSaveDialog(w && !w.win.isDestroyed() ? w.win : null, {
      title: 'экспорт настроек Liber',
      defaultPath: path.join(app.getPath('downloads'), 'liber-settings-' + new Date().toISOString().slice(0, 10) + '.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePath) return ''
    const out = {
      settings: data.settings,
      siteRules: data.siteRules,
      engines: data.engines,
      privacy: data.settings && data.settings.privacy,
      version: app.getVersion(),
      exported: new Date().toISOString()
    }
    fs.writeFileSync(res.filePath, JSON.stringify(out, null, 2), 'utf8')
    return res.filePath
  } catch (_) {
    return ''
  }
})
ipcMain.handle('settings:import', async (e) => {
  const w = wOfEvent(e)
  try {
    const res = await dialog.showOpenDialog(w && !w.win.isDestroyed() ? w.win : null, {
      title: 'импорт настроек Liber',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths.length) return null
    const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'))
    const merged = Object.assign({}, data.settings, raw.settings || {})
    if (raw.siteRules) data.siteRules = raw.siteRules
    if (raw.engines) data.engines = raw.engines
    data.settings = merged
    applySettings(merged)
    storage.save(data)
    sendSettings()
    eachW(applyLayout)
    return true
  } catch (_) {
    return null
  }
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
ipcMain.handle('freq:list', () => {
  const hide = new Set((settings.freqHide || []).map(String).map(h => h.toLowerCase()))
  const map = new Map()
  for (const h of data.history) {
    const host = siteHostOf(h.url)
    if (!host || hide.has(host.toLowerCase())) continue
    const d = map.get(host) || { host, count: 0, url: h.url, title: h.title, date: h.date }
    d.count += 1
    if (h.date > d.date) { d.url = h.url; d.title = h.title; d.date = h.date }
    map.set(host, d)
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 8)
})
ipcMain.handle('freq:hide', (e, host) => {
  if (!host) return
  const h = String(host).toLowerCase()
  if (!settings.freqHide) settings.freqHide = []
  if (!settings.freqHide.includes(h)) settings.freqHide.push(h)
  data.settings = settings
  storage.save(data)
  sendSettings()
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
ipcMain.handle('ads:cosmetic', (e, host) => {
  if (!adblock.ready || !adblock.on) return ''
  const t = wcToTab(e.sender)
  if (t && adsAllowed(t.url)) return ''
  return adblock.cosmeticFor(host)
})
ipcMain.handle('ads:stats', () => adblock.stats())
ipcMain.handle('ads:refresh', () => loadFilters(true))
ipcMain.handle('sr:list', () => srList())
ipcMain.handle('sr:set', (e, host, patch) => srSend(host, patch))
ipcMain.handle('sr:del', (e, host) => { srDel(host); return true })
ipcMain.handle('site:info', (e) => {
  const w = wOfEvent(e)
  const t = (w && activeTab(w)) || wcToTab(e.sender)
  const u = (t && t.url) || ''
  let host = ''
  let proto = ''
  try {
    const p = new URL(u)
    host = p.hostname.toLowerCase()
    proto = p.protocol
  } catch (_) {}
  const local = !host || (proto !== 'https:' && proto !== 'http:')
  const base = local ? '' : normHost(host)
  const exact = local ? null : siteRules[host]
  const parent = local ? null : siteRules[regDomain(host)]
  return {
    url: u,
    host: local ? '' : host,
    base,
    ruleHost: local ? '' : (exact ? host : parent ? regDomain(host) : base),
    secure: !local && proto === 'https:',
    local,
    blocked: local ? 0 : adblock.pageCount(host),
    blockedAll: adblock.blocked,
    adblockOn: !!(adblock.on && adblock.ready),
    rule: Object.assign({}, exact || parent || {}),
  }
})
ipcMain.handle('site:clear-data', async (e) => {
  const w = wOfEvent(e)
  const t = (w && activeTab(w)) || wcToTab(e.sender)
  const host = t ? hostOfUrl(t.url) : ''
  if (!host) return -1
  return clearSiteData((w && w.ses) || ses, host)
})
ipcMain.handle('bypass:info', () => bypass.info())
ipcMain.handle('bypass:reprobe', async () => {
  await bypass.reprobe()
  return bypass.info()
})
ipcMain.handle('data:site-list', async (e) => {
  const w = wOfEvent(e)
  const s = (w && w.ses) || ses
  const cookies = await s.cookies.get({}).catch(() => [])
  const map = new Map()
  for (const c of cookies) {
    const d = String(c.domain || '').replace(/^\./, '')
    if (!d) continue
    const it = map.get(d) || { host: d, cookies: 0, session: 0, secure: 0 }
    it.cookies += 1
    if (!c.expirationDate) it.session += 1
    if (c.secure) it.secure += 1
    map.set(d, it)
  }
  return [...map.values()].sort((a, b) => b.cookies - a.cookies)
})
ipcMain.handle('data:site-clear', async (e, host) => {
  const w = wOfEvent(e)
  return clearSiteData((w && w.ses) || ses, host)
})
ipcMain.handle('data:site-clear-all', async (e) => {
  const w = wOfEvent(e)
  const s = (w && w.ses) || ses
  const cookies = await s.cookies.get({}).catch(() => [])
  let removed = 0
  for (const c of cookies) {
    const url = (c.secure ? 'https://' : 'http://') + String(c.domain || '').replace(/^\./, '') + (c.path || '/')
    try {
      await s.cookies.remove(url, c.name)
      removed += 1
    } catch (_) {}
  }
  try {
    await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'shadercache', 'websql'] })
  } catch (_) {}
  try { await s.clearHistory() } catch (_) {}
  return removed
})
ipcMain.handle('eng:list', () => engList())
ipcMain.handle('eng:save', (e, p) => engSave(p))
ipcMain.handle('eng:del', (e, id) => engDel(id))
ipcMain.handle('st:get', () => ({
  search: settings.search,
  engines: engList(),
  homepage: settings.homepage,
  bmBar: settings.bmBar,
  restore: settings.restore,
  adblock: adblock.on,
  blocked: adblock.blocked,
  filterState,
  rules: adblock.rules,
  downloadsDir: dlDirOf(),
  engine: bypass.status(),
  engineInfo: bypass.info(),
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
    if (adblock.on) loadFilters(false).catch(() => {})

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
      console.log('ST tab reorder:')
      const order0 = w0.tabs.map(t => t.id)
      await w0.win.webContents.executeJavaScript(`(function(ids){ window.liber.tabOrder(ids) })(${JSON.stringify(order0.slice().reverse())})`)
      await wait(500)
      const order1 = w0.tabs.map(t => t.id)
      console.log('ST tabs reversed:', JSON.stringify(order1), '| ok:', JSON.stringify(order1) === JSON.stringify(order0.slice().reverse()))
      await w0.win.webContents.executeJavaScript(`(function(ids){ window.liber.tabOrder(ids) })(${JSON.stringify(order0)})`)
      await wait(300)
      console.log('ST tabs restored:', JSON.stringify(w0.tabs.map(t => t.id)) === JSON.stringify(order0))
      console.log('ST home:')
      const hmId = newTab(internalPage('start'), w0)
      await wait(1500)
      const hmTab = w0.tabs[w0.tabs.length - 1]
      console.log('ST home tiles:', await hmTab.view.webContents.executeJavaScript(`JSON.stringify({ n: document.querySelectorAll('.ftile').length, first: (document.querySelector('.fhost') || {}).textContent || '' })`))
      closeTab(w0, hmId)
      await wait(300)
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
      console.log('ST settings cards:', await stTab.view.webContents.executeJavaScript(`JSON.stringify({ imp: !!document.getElementById('imp'), impText: (document.getElementById('imp').textContent || '').slice(0, 30), impRows: document.querySelectorAll('#imp .kv').length, pwcount: document.getElementById('pwcount').textContent, ab: !!document.getElementById('adblock'), absText: (document.getElementById('abs').textContent || '').slice(0, 24), sradd: !!document.getElementById('sradd') })`))
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
      console.log('ST bms ui:', await bmsTab.view.webContents.executeJavaScript(`JSON.stringify({ side: document.querySelectorAll('.fbtn').length, sels: document.querySelectorAll('.mini-sel').length, rows: document.querySelectorAll('.item').length, exp: !!document.getElementById('bmexp'), imp: !!document.getElementById('bmimp') })`))
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
      console.log('ST adblock:')
      const abT0 = Date.now()
      while (!adblock.ready && Date.now() - abT0 < 90000) await wait(1000)
      console.log('ST ab wait ms:', Date.now() - abT0, 'ready:', adblock.ready, 'state:', filterState, 'rules:', adblock.rules)
      console.log('ST ab checks:', JSON.stringify({
        ga: adblock.check('https://www.google-analytics.com/analytics.js', 'script', 'https://example.com/'),
        dbl: adblock.check('https://ad.doubleclick.net/ddm/ad/N1', 'xhr', 'https://example.com/'),
        yandex: adblock.check('https://an.yandex.ru/meta/123', 'script', 'https://example.com/'),
        clean: adblock.check('https://cdn.example.com/app.js', 'script', 'https://example.com/'),
        frame: adblock.check('https://example.com/', 'mainFrame', 'https://example.com/'),
        parse: adblock.check('http://example.com/x', 'image', 'not-a-url'),
      }))
      await wc0.loadURL('https://example.com/')
      await wait(1800)
      const abBefore = adblock.blocked
      await wc0.executeJavaScript(`(() => { const i = document.createElement('img'); i.src = 'https://counter.yadro.ru/hit?t1'; document.body.appendChild(i); const s = document.createElement('script'); s.src = 'https://mc.yandex.ru/metrika/tag.js'; document.body.appendChild(s); return 1 })()`)
      await wait(2500)
      console.log('ST ab live:', adblock.blocked - abBefore, JSON.stringify(adblock.stats().top.slice(0, 3)))
      const abSel = (adblock.block.cosmeticGeneric.find(s => /^\.[a-z][a-z0-9_-]{2,30}$/i.test(s)) || '').slice(1)
      const abCss = await wc0.executeJavaScript(`JSON.stringify({ styles: document.querySelectorAll('style').length, sel: ${JSON.stringify(abSel)}, disp: (() => { if (!${JSON.stringify(abSel)}) return 'nosel'; const el = document.createElement('div'); el.className = ${JSON.stringify(abSel)}; document.body.appendChild(el); const d = getComputedStyle(el).display; el.remove(); return d })() })`)
      console.log('ST ab cosmetic:', abCss)
      console.log('ST site rules:')
      const nodeHttp = require('http')
      const hits = { doc: 0, js: 0, img: 0 }
      const srv = nodeHttp.createServer((req, res) => {
        const p = String(req.url || '').split('?')[0]
        if (p === '/favicon.ico') { res.statusCode = 204; return res.end() }
        if (p === '/js.js') {
          hits.js += 1
          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Set-Cookie', 'abjs=1; Path=/')
          return res.end('window.__ran = (window.__ran || 0) + 1')
        }
        if (p === '/img.png') {
          hits.img += 1
          res.setHeader('Content-Type', 'image/png')
          return res.end(Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000', 'hex'))
        }
        if (p !== '/') { res.statusCode = 404; return res.end() }
        hits.doc += 1
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Set-Cookie', 'abdoc=1; Path=/')
        res.end('<!doctype html><html><body><p>site rules</p><script>window.__inline = 1<\/script><script src="/js.js"><\/script><img src="/img.png"></body></html>')
      })
      await new Promise(r => srv.listen(0, '127.0.0.1', r))
      const lurl = 'http://127.0.0.1:' + srv.address().port + '/'
      const clearTestCookies = async () => {
        for (const c of await ses.cookies.get({ url: lurl }).catch(() => [])) await ses.cookies.remove(lurl, c.name).catch(() => {})
      }
      const probe = async () => JSON.parse(await wc0.executeJavaScript(`JSON.stringify({ inline: typeof window.__inline, ran: typeof window.__ran, imgs: document.images.length })`))
      await wc0.loadURL(lurl)
      await wait(1600)
      console.log('ST sr clean:', JSON.stringify(hits), JSON.stringify(await probe()), 'cookies:', (await ses.cookies.get({ url: lurl })).map(c => c.name).sort().join(','))
      srSend('127.0.0.1', { js: 'deny', images: 'deny', cookies: 'deny', popups: 'deny', camera: 'deny' })
      await clearTestCookies()
      await wc0.loadURL(lurl)
      await wait(1800)
      console.log('ST sr restricted:', JSON.stringify(hits), JSON.stringify(await probe()), 'cookies:', (await ses.cookies.get({ url: lurl })).map(c => c.name).sort().join(','))
      const tabsBefore = w0.tabs.length
      await wc0.executeJavaScript(`window.open('https://example.com/?popup')`)
      await wait(900)
      console.log('ST sr popup blocked:', w0.tabs.length === tabsBefore, w0.tabs.length)
      console.log('ST sr perms:', JSON.stringify({ cam: permDecision('127.0.0.1', 'camera'), loc: permDecision('127.0.0.1', 'location'), kind: permKind('media', { mediaTypes: ['audio'] }) }))
      const srId = newTab(internalPage('settings'), w0)
      await wait(1300)
      const srTab = w0.tabs[w0.tabs.length - 1]
      console.log('ST sr ui:', await srTab.view.webContents.executeJavaScript(`JSON.stringify({ rows: document.querySelectorAll('#srlist .srrow').length, host: (document.querySelector('#srlist .srrow .k') || {}).textContent || '', sum: ((document.querySelector('#srlist .srrow .v') || {}).textContent || '').slice(0, 60), als: !!document.getElementById('adblock'), engsel: document.querySelectorAll('#search option').length, engrows: document.querySelectorAll('#englist .kv').length })`))
      closeTab(w0, srId)
      await wait(400)
      switchTab(w0, w0.tabs.find(t => t.view.webContents === wc0).id)
      await wait(300)
      console.log('ST sr ads allow:', adsAllowed(lurl), '->', (srSend('127.0.0.1', { ads: 'allow' }), adsAllowed(lurl)))
      console.log('ST data:')
      try {
        await wc0.executeJavaScript('document.cookie = "stest=1; path=/";')
        await wc0.loadURL(lurl)
        await wait(1200)
        const dtId = newTab(internalPage('settings'), w0)
        await wait(2000)
        const dtTab = w0.tabs[w0.tabs.length - 1]
        console.log('ST data list:', await dtTab.view.webContents.executeJavaScript(`JSON.stringify({ count: document.getElementById('datacount').textContent, rows: document.querySelectorAll('#datalist .datarow').length, hosts: [...document.querySelectorAll('#datalist .dh')].map(e=>e.textContent) })`))
        await dtTab.view.webContents.executeJavaScript(`(function(){ const b = document.querySelector('#datalist .da'); if(b){ b.click(); return 1 } return 0 })()`)
        await wait(1200)
        console.log('ST data clear one:', await dtTab.view.webContents.executeJavaScript(`JSON.stringify({ rows: document.querySelectorAll('#datalist .datarow').length, res: document.getElementById('datares').textContent })`))
        closeTab(w0, dtId)
        await wait(400)
      } catch (e) { console.log('ST data err:', String(e.message || e)) }
      srDel('127.0.0.1')
      await wc0.executeJavaScript(`window.open('https://example.com/?popup')`)
      await wait(900)
      console.log('ST sr popup after reset:', w0.tabs.length > tabsBefore, w0.tabs.length)
      while (w0.tabs.length > tabsBefore) closeTab(w0, w0.tabs[w0.tabs.length - 1].id)
      console.log('ST sr rules roundtrip:', JSON.stringify(srSend('a.example.com', { js: 'deny' })), JSON.stringify(srList()), (srDel('a.example.com'), JSON.stringify(srList())))
      console.log('ST site panel:')
      const spc0 = adblock.pageCount('127.0.0.1')
      adblock.check('https://ads.doubleclick.net/pixel.gif', 'image', lurl)
      console.log('ST site panel count:', spc0, '->', adblock.pageCount('127.0.0.1'), '| rules:', adblock.rules)
      await wc0.loadURL(lurl)
      await wait(1500)
      switchTab(w0, w0.tabs.find(t => t.view.webContents === wc0).id)
      await wait(500)
      await js(`(function(){ document.getElementById('lock').click(); return 1 })()`)
      await wait(600)
      console.log('ST site panel ui:', await js(`JSON.stringify({ shown: document.getElementById('sitepanel').classList.contains('show'), host: (document.querySelector('#sitepanel .sphost') || {}).textContent || '', sub: (document.querySelector('#sitepanel .spsub') || {}).textContent || '', stat: (document.querySelector('#sitepanel .spstat') || {}).textContent || '', rows: document.querySelectorAll('#sitepanel .sprow').length, acts: [...document.querySelectorAll('#sitepanel .spa')].map(b => b.textContent).join('|'), x: Math.round(document.getElementById('sitepanel').getBoundingClientRect().left), y: Math.round(document.getElementById('sitepanel').getBoundingClientRect().top) })`))
      await js(`(function(){ document.querySelectorAll('#sitepanel .sprow')[0].querySelectorAll('.spb')[2].click(); return 1 })()`)
      await wait(600)
      console.log('ST site panel deny:', await js(`JSON.stringify({ on: document.querySelectorAll('#sitepanel .sprow')[0].querySelectorAll('.spb')[2].classList.contains('on'), sole: document.querySelectorAll('#sitepanel .sprow')[0].querySelectorAll('.spb.on').length })`), JSON.stringify(srList().filter(r => r.host === '127.0.0.1')))
      const cookiesBefore = (await ses.cookies.get({ url: lurl })).length
      await js(`(function(){ document.querySelectorAll('#sitepanel .spa')[0].click(); return 1 })()`)
      await wait(1600)
      console.log('ST site data clear:', cookiesBefore, '->', (await ses.cookies.get({ url: lurl })).length, '| note:', await js(`JSON.stringify({ shown: document.getElementById('sitepanel').classList.contains('show') })`))
      await js(`(function(){ document.getElementById('lock').click(); return 1 })()`)
      await wait(500)
      console.log('ST site panel reopen:', await js(`JSON.stringify({ shown: document.getElementById('sitepanel').classList.contains('show'), marked: document.querySelectorAll('#sitepanel .sprow')[0].querySelectorAll('.spb.on')[0].textContent })`))
      await js(`(function(){ document.getElementById('bar').click(); return 1 })()`)
      await wait(400)
      console.log('ST site panel outside:', await js(`JSON.stringify({ shown: document.getElementById('sitepanel').classList.contains('show') })`))
      await js(`(async function(){ document.getElementById('lock').click(); await new Promise(r => setTimeout(r, 400)); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 1 })()`)
      await wait(400)
      console.log('ST site panel esc:', await js(`JSON.stringify({ shown: document.getElementById('sitepanel').classList.contains('show') })`))
      srDel('127.0.0.1')
      await clearTestCookies()
      console.log('ST privacy:')
      applySettings({ privacy: { dnt: true, thirdParty: true, autoplay: 'gesture', clearOnExit: true } })
      await wait(300)
      console.log('ST privacy applied:', JSON.stringify(settings.privacy))
      applySettings({ privacy: { dnt: false, thirdParty: false, autoplay: 'allow', clearOnExit: false } })
      srv.close()
      console.log('ST engines:')
      console.log('ST eng base:', JSON.stringify(engList().map(e => e.id + (e.builtin ? '*' : ''))), '| d ->', keywordEngine('d') ? keywordEngine('d').label : '-')
      console.log('ST eng keyword url:', toUrl('d котики'))
      console.log('ST eng rejects:', engSave({ label: 'x', url: 'https://x.com/search' }) === null, engSave({ label: 'y', url: 'https://y.com/s?q=%s', keyword: 'g' }) === null)
      engSave({ label: 'startpage', url: 'https://www.startpage.com/sp/search?query=%s', keyword: 's' })
      const cust = engList().find(e => !e.builtin)
      console.log('ST eng added:', JSON.stringify(cust), '| url:', toUrl('s привет мир'))
      engSave({ id: cust.id, label: 'startpage eu', url: 'https://eu.startpage.com/sp/search?query=%s', keyword: 's' })
      console.log('ST eng edited:', JSON.stringify(engList().find(e => !e.builtin)))
      applySettings({ search: cust.id })
      console.log('ST eng default:', engine().label, settings.search === cust.id, toUrl('котики').slice(0, 45))
      console.log('ST eng removed:', JSON.stringify(engDel(cust.id).map(e => e.id)), '| default now:', settings.search, '| stored:', data.engines.length)
      console.log('ST bm html export:')
      data.bookmarks = [
        { url: 'https://a.example.com/1', title: 'тест 1', date: Date.now() },
        { url: 'https://b.example.com/2?x=1&y=2', title: 'тест & <2>', folder: 'работа', date: Date.now() },
      ]
      data.bmFolders = ['работа']
      const bmHtml = bmExportHtml()
      console.log('ST bm html:', bmHtml.split('\n').length, 'lines |', bmHtml.includes('HREF="https://b.example.com/2?x=1&amp;y=2"'), bmHtml.includes('>тест &amp; &lt;2&gt;</A>'), bmHtml.includes('<H3 ADD_DATE='))
      data.bookmarks = []
      data.bmFolders = []
      const bmImp = bmImportHtml(bmHtml)
      console.log('ST bm import:', JSON.stringify(bmImp), JSON.stringify(data.bookmarks.map(b => b.title + '|' + (b.folder || '-') + '|' + !!b.date)))
      console.log('ST bm import again:', JSON.stringify(bmImportHtml(bmHtml)), 'total:', data.bookmarks.length)
      const nested = '<DL><p><DT><H3>top</H3><DL><p><DT><H3>inner</H3><DL><p><DT><A HREF="https://n.example.com/">nest</A><DT><A HREF="javascript:void(0)">skip</A></DL><p></DL><p><DT><A HREF="https://r.example.com/">root</A></DL><p>'
      console.log('ST bm nested:', JSON.stringify(bmImportHtml(nested)), JSON.stringify(data.bookmarks.map(b => b.title + '|' + (b.folder || '-'))))
      data.bookmarks = []
      data.bmFolders = []
      storage.save(data)
      console.log('ST pinned tabs:')
      const pinA = w0.tabs[0].id
      const pinB = newTab('https://example.com/?pin', w0)
      const pinC = newTab('https://example.com/?normal', w0)
      setPinned(w0, pinB, true)
      setPinned(w0, pinC, true)
      setPinned(w0, pinB, false)
      console.log('ST pin order:', JSON.stringify(w0.tabs.map(t => (t.pinned ? 'P' : '-') + (t.url.includes('pin') ? 'b' : t.url.includes('normal') ? 'c' : 'a'))))
      await wait(400)
      const pinState = await js(`JSON.stringify([...document.querySelectorAll('.tab')].map(e => e.className.includes('pinned') ? 'P' : '-'))`)
      console.log('ST pin ui:', pinState, await js(`document.querySelectorAll('.tab.pinned .title').length`), await js(`document.querySelectorAll('.tab.pinned').length`))
      persist()
      const savedTabs = storage.load().windows[0].tabs
      console.log('ST pin persisted:', JSON.stringify(savedTabs))
      closeTab(w0, pinB)
      closeTab(w0, pinC)
      await wait(400)
      const rw = createWindow({ tabs: savedTabs, bounds: { width: 1000, height: 700 } })
      await wait(1500)
      console.log('ST pin restored:', JSON.stringify(rw.tabs.map(t => (t.pinned ? 'P' : '-') + (t.url.includes('pin') ? 'b' : t.url.includes('normal') ? 'c' : 'a'))), windows.length)
      rw.win.close()
      await wait(500)
      console.log('ST windows after pin test:', windows.length)
      console.log('ST tab groups:')
      const gA = grpNew(w0, 'работа')
      const gTabs = w0.tabs.filter(t => !t.pinned).slice(0, 2)
      grpAssign(w0, gTabs[0].id, gA.id)
      grpAssign(w0, gTabs[1].id, gA.id)
      console.log('ST grp order:', JSON.stringify(w0.tabs.map(t => (t.pinned ? 'P' : t.group === gA.id ? 'G' : '-'))))
      await wait(500)
      console.log('ST grp ui:', await js(`JSON.stringify({ chips: document.querySelectorAll('.grp').length, name: (document.querySelector('.grp .gname') || {}).textContent, grped: document.querySelectorAll('.tab.grped').length })`))
      grpCollapse(w0, gA.id)
      await wait(500)
      console.log('ST grp collapsed:', await js(`JSON.stringify({ chips: document.querySelectorAll('.grp').length, tabs: document.querySelectorAll('.tab').length, cnt: (document.querySelector('.grp .gcnt') || {}).textContent })`))
      grpRename(w0, gA.id, 'работа 2')
      grpColor(w0, gA.id)
      console.log('ST grp edited:', JSON.stringify(w0.groups.map(g => g.name + '/' + g.color + '/' + (g.collapsed ? 'off' : 'on'))))
      persist()
      const savedG = storage.load().windows[0]
      console.log('ST grp persisted:', JSON.stringify(savedG.groups), JSON.stringify(savedG.tabs.slice(0, 2)))
      const rw2 = createWindow({ tabs: savedG.tabs, groups: savedG.groups, bounds: { width: 1000, height: 700 } })
      await wait(1600)
      console.log('ST grp restored:', JSON.stringify(rw2.groups.map(g => g.name + '/' + (g.collapsed ? 'off' : 'on'))), rw2.tabs.filter(t => t.group).length, 'windows:', windows.length)
      rw2.win.close()
      await wait(500)
      grpDel(w0, gA.id)
      console.log('ST grp deleted:', w0.groups.length, w0.tabs.filter(t => t.group).length, 'windows:', windows.length)
      console.log('ST vtab:')
      applySettings({ vtab: true })
      await wait(800)
      console.log('ST vtab ui:', await js(`JSON.stringify({ cls: document.body.classList.contains('vtab'), tabs: document.querySelectorAll('.tab').length, pos: getComputedStyle(document.getElementById('tabs')).position, w: Math.round(document.getElementById('tabs').getBoundingClientRect().width) })`))
      const vTab = activeTab(w0)
      console.log('ST vtab bounds:', vTab ? JSON.stringify(vTab.view.getBounds()) : '-', JSON.stringify(w0.win.getContentSize()))
      applySettings({ vtab: false })
      await wait(800)
      console.log('ST vtab off:', await js(`JSON.stringify({ cls: document.body.classList.contains('vtab'), pos: getComputedStyle(document.getElementById('tabs')).position })`), vTab ? JSON.stringify(vTab.view.getBounds()) : '-')
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

  app.on('before-quit', (e) => {
    if (!(settings.privacy && settings.privacy.clearOnExit)) return
    e.preventDefault()
    ;(async () => {
      for (const s of [...liveSessions, ses]) {
        try {
          const cookies = await s.cookies.get({}).catch(() => [])
          for (const c of cookies) {
            const url = (c.secure ? 'https://' : 'http://') + String(c.domain || '').replace(/^\./, '') + (c.path || '/')
            try { await s.cookies.remove(url, c.name) } catch (_) {}
          }
          await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'shadercache', 'websql'] }).catch(() => {})
        } catch (_) {}
      }
      try {
        data.history = []
        storage.save(data)
      } catch (_) {}
      app.quit()
    })()
  })
  app.on('window-all-closed', () => app.quit())
}
