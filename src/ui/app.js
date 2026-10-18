const tabsEl = document.getElementById('tabs')
const addEl = document.getElementById('add')
const backEl = document.getElementById('back')
const reldEl = document.getElementById('reld')
const omni = document.getElementById('omni')
const sugEl = document.getElementById('sug')
const bmbarEl = document.getElementById('bmbar')
const starEl = document.getElementById('star')
const cntEl = document.getElementById('cnt')
const engineEl = document.getElementById('engine')
const dlsEl = document.getElementById('dls')
const lockEl = document.getElementById('lock')
const spEl = document.getElementById('sitepanel')
const moreEl = document.getElementById('more')
const menuEl = document.getElementById('menu')
const tmenuEl = document.getElementById('tmenu')
const tsearchEl = document.getElementById('tsearch')
const tsqEl = document.getElementById('tsq')
const tslistEl = document.getElementById('tslist')

const isPriv = location.search.includes('priv=1')
if (isPriv) {
  document.body.classList.add('priv')
  const tag = document.createElement('span')
  tag.className = 'privtag'
  tag.textContent = 'инкогнито'
  document.querySelector('.logo').after(tag)
}

window.addEventListener('error', e => {
  window.__liberErr = String(e.message) + ' @' + (e.filename || '') + ':' + (e.lineno || 0)
})

let state = null
let bms = []
let bmf = []
let settings = { bmBar: true, search: 'ddg', homepage: '', vtab: false }
let findMode = false
let sugTimer = null
let sugItems = []
let sugSel = -1
let comp = null
let lastVal = ''
let grew = false
let spInfo = null

function activeTab() {
  return state && state.tabs.find(t => t.active)
}

function looksUrl(q) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(q)
}

function tabEl(t) {
  const d = document.createElement('div')
  d.className = 'tab' + (t.active ? ' on' : '') + (t.loading ? ' ld' : '') + (t.muted ? ' mut' : '') + (t.pinned ? ' pinned' : '')
  d.dataset.id = t.id
  d.title = t.title || ''
  if (t.muted) {
    const m = document.createElement('span')
    m.className = 'mt'
    m.textContent = '🔇'
    d.append(m)
  } else if (t.favicon) {
    const f = document.createElement('img')
    f.src = t.favicon
    d.append(f)
  } else if (t.pinned) {
    const p = document.createElement('span')
    p.className = 'pinm'
    p.textContent = '📌'
    d.append(p)
  }
  if (!t.pinned) {
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t.loading ? '…' : (t.title || 'Новая вкладка')
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.addEventListener('click', e => { e.stopPropagation(); window.liber.closeTab(t.id) })
    d.append(title, x)
  }
  if (t.audible) {
    const a = document.createElement('span')
    a.className = 'aud'
    a.textContent = '🔊'
    d.append(a)
  }
  d.addEventListener('click', () => window.liber.switchTab(t.id))
  d.addEventListener('contextmenu', e => {
    e.preventDefault()
    showTabMenu(t, e.clientX, e.clientY)
  })
  return d
}

function popMenu(el, x, y, rows) {
  el.replaceChildren(...rows.map(r => {
    if (!r) {
      const s = document.createElement('div')
      s.className = 'msep'
      return s
    }
    const d = document.createElement('div')
    d.className = 'mrow' + (r.disabled ? ' dis' : '')
    d.textContent = r.label
    if (r.hint) {
      const h = document.createElement('span')
      h.className = 'hint'
      h.textContent = r.hint
      d.append(h)
    }
    if (!r.disabled && r.action) d.addEventListener('click', () => { closeMenus(); r.action() })
    return d
  }))
  el.classList.add('show')
  const r = el.getBoundingClientRect()
  el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'
  el.style.top = Math.max(52, Math.min(y, innerHeight - r.height - 8)) + 'px'
}

function closeMenus() {
  menuEl.classList.remove('show')
  tmenuEl.classList.remove('show')
}

function renderTsearch() {
  const q = tsqEl.value.trim().toLowerCase()
  const list = (state ? state.tabs : []).filter(t => !q || ((t.title || '') + ' ' + (t.url || '')).toLowerCase().includes(q))
  tslistEl.replaceChildren(...list.map(t => {
    const d = document.createElement('div')
    d.className = 'tsrow' + (t.active ? ' on' : '')
    const tt = document.createElement('span')
    tt.className = 'tt'
    tt.textContent = t.title || t.url
    const uu = document.createElement('span')
    uu.className = 'tu'
    uu.textContent = t.url
    d.append(tt, uu)
    d.addEventListener('click', () => { window.liber.switchTab(t.id); closeTabSearch() })
    return d
  }))
}

function openTabSearch() {
  closeMenus()
  tsearchEl.classList.add('show')
  tsqEl.value = ''
  renderTsearch()
  tsqEl.focus()
}

function closeTabSearch() {
  tsearchEl.classList.remove('show')
}

tsqEl.addEventListener('input', renderTsearch)

function showTabMenu(t, x, y) {
  const items = [
    { label: 'обновить', action: () => window.liber.reload(t.id) },
    { label: 'дублировать', action: () => window.liber.dupTab(t.id) },
    { label: t.pinned ? 'открепить вкладку' : 'закрепить вкладку', action: () => window.liber.pinTab(t.id, !t.pinned) },
    { label: t.muted ? 'включить звук' : 'выключить звук', action: () => window.liber.muteTab(t.id) },
    null,
    { label: 'закрыть', hint: 'Ctrl+W', action: () => window.liber.closeTab(t.id) },
    { label: 'закрыть другие', action: () => window.liber.closeOthers(t.id) },
    { label: 'закрыть вправо', action: () => window.liber.closeRight(t.id) },
  ]
  if (state) {
    const groups = state.groups || []
    if (groups.length || t.group) items.push(null)
    for (const g of groups) {
      if (g.id === t.group) continue
      items.push({ label: g.collapsed ? 'в свёрнутую группу «' + g.name + '»' : 'в группу «' + g.name + '»', action: () => window.liber.grpAssign(t.id, g.id) })
    }
    if (t.group) items.push({ label: 'убрать из группы', action: () => window.liber.grpAssign(t.id, '') })
    items.push({ label: 'новая группа для вкладки', action: () => window.liber.grpNew('', t.id) })
  }
  popMenu(tmenuEl, x, y, items)
}

function grpChip(g) {
  const c = document.createElement('div')
  c.className = 'grp' + (g.collapsed ? ' off' : '')
  c.style.setProperty('--gc', g.color)
  c.title = g.name + ' · вкладок: ' + g.count
  const dot = document.createElement('span')
  dot.className = 'gdot'
  const name = document.createElement('span')
  name.className = 'gname'
  name.textContent = g.name
  c.append(dot, name)
  if (g.collapsed) {
    const cnt = document.createElement('span')
    cnt.className = 'gcnt'
    cnt.textContent = String(g.count)
    c.append(cnt)
  }
  c.addEventListener('click', () => window.liber.grpCollapse(g.id))
  c.addEventListener('contextmenu', e => {
    e.preventDefault()
    showGrpMenu(g, e.clientX, e.clientY)
  })
  return c
}

function showGrpMenu(g, x, y) {
  popMenu(tmenuEl, x, y, [
    { label: g.collapsed ? 'развернуть группу' : 'свернуть группу', action: () => window.liber.grpCollapse(g.id) },
    { label: 'переименовать', action: () => renameGroup(g) },
    { label: 'сменить цвет', action: () => window.liber.grpColor(g.id) },
    null,
    { label: 'разгруппировать', action: () => window.liber.grpDel(g.id) },
  ])
}

function renameGroup(g) {
  const chip = [...tabsEl.querySelectorAll('.grp')].find(c => c.style.getPropertyValue('--gc') === g.color && c.querySelector('.gname') && c.querySelector('.gname').textContent === g.name)
  if (!chip) return
  const nameEl = chip.querySelector('.gname')
  const inp = document.createElement('input')
  inp.className = 'ginp'
  inp.value = g.name
  inp.size = Math.max(5, Math.min(18, g.name.length + 2))
  nameEl.replaceWith(inp)
  inp.focus()
  inp.select()
  let done = false
  const commit = ok => {
    if (done) return
    done = true
    if (ok && inp.value.trim() && inp.value.trim() !== g.name) window.liber.grpRename(g.id, inp.value.trim())
    else render(state)
  }
  inp.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') commit(true)
    else if (e.key === 'Escape') commit(false)
  })
  inp.addEventListener('blur', () => commit(true))
}

function renderTabs(s) {
  const groups = new Map((s.groups || []).map(g => [g.id, g]))
  const out = []
  const started = new Set()
  for (const t of s.tabs) {
    const g = t.group ? groups.get(t.group) : null
    if (g && !started.has(g.id)) {
      started.add(g.id)
      out.push(grpChip(g))
    }
    if (g && g.collapsed && !t.active) continue
    const el = tabEl(t)
    if (g) {
      el.classList.add('grped')
      el.style.setProperty('--gc', g.color)
    }
    out.push(el)
  }
  tabsEl.replaceChildren(...out)
}

function showMainMenu(x, y) {
  const a = activeTab()
  const z = (state && state.zoom) || 100
  popMenu(menuEl, x, y, [
    { label: 'новая вкладка', hint: 'Ctrl+T', action: () => window.liber.newTab() },
    { label: 'новое окно', hint: 'Ctrl+N', action: () => window.liber.newWindow(false) },
    { label: 'новое окно инкогнито', hint: 'Ctrl+Shift+N', action: () => window.liber.newWindow(true) },
    null,
    { label: settings.vtab ? 'вкладки сверху' : 'вкладки слева', action: () => window.liber.stSet({ vtab: !settings.vtab }) },
    null,
    { label: 'история', hint: 'Ctrl+H', action: () => window.liber.page('hist') },
    { label: 'загрузки', hint: 'Ctrl+J', action: () => window.liber.page('dls') },
    { label: 'закладки', hint: 'Ctrl+Shift+O', action: () => window.liber.page('bms') },
    null,
    { label: 'найти на странице', hint: 'Ctrl+F', action: () => enterFind() },
    { label: 'поиск по вкладкам', hint: 'Ctrl+Shift+A', action: () => openTabSearch() },
    { label: 'сохранить страницу', hint: 'Ctrl+S', action: () => a && window.liber.save(a.id) },
    { label: 'печать', hint: 'Ctrl+P', action: () => a && window.liber.print(a.id) },
    { label: 'просмотр кода', hint: 'Ctrl+U', action: () => a && window.liber.source(a.id) },
    { label: 'режим чтения', hint: 'F9', action: () => window.liber.reader() },
    { label: 'перевести страницу', action: () => window.liber.translate() },
    { label: 'свернуть / развернуть масштаб ' + z + '%', disabled: true },
    { label: 'сбросить масштаб', hint: 'Ctrl+0', action: () => a && window.liber.zoom(a.id, 0) },
    null,
    { label: 'очистить данные', hint: 'Ctrl+Shift+Del', action: () => window.liber.page('settings') },
    { label: 'настройки', action: () => window.liber.page('settings') },
    { label: 'о браузере', action: () => window.liber.page('settings') },
    null,
    { label: 'полный экран', hint: 'F11', action: () => window.liber.full() },
    { label: 'закрыть окно', action: () => window.liber.call('close') },
  ])
}

function hideSug() {
  sugEl.classList.remove('show')
  sugItems = []
  sugSel = -1
  comp = null
  window.liber.chrome(false)
}

function renderSug(items) {
  sugItems = []
  const q = omni.value.trim()
  const rows = []
  if (!findMode && q && !looksUrl(q)) {
    const s = document.createElement('div')
    s.className = 'sugit search'
    s.textContent = 'искать «' + q + '»'
    s.addEventListener('click', () => { const a = activeTab(); hideSug(); if (a) window.liber.go(a.id, q) })
    rows.push(s)
    sugItems.push({ q })
  }
  for (const it of items) {
    const d = document.createElement('div')
    d.className = 'sugit'
    if (it.bm) {
      const b = document.createElement('span')
      b.className = 'b'
      b.textContent = '★'
      d.append(b)
    }
    const t = document.createElement('span')
    t.className = 't'
    t.textContent = it.title
    const u = document.createElement('span')
    u.className = 'u'
    u.textContent = it.url
    d.append(t, u)
    d.addEventListener('click', () => {
      const a = activeTab()
      hideSug()
      if (a) window.liber.go(a.id, it.url)
    })
    rows.push(d)
    sugItems.push(it)
  }
  if (!rows.length) { hideSug(); return }
  sugSel = -1
  sugEl.replaceChildren(...rows)
  sugEl.classList.add('show')
  window.liber.chrome(true)
}

function selectSug(i) {
  const rows = [...sugEl.children]
  if (!rows.length) return
  sugSel = (i + rows.length) % rows.length
  rows.forEach((r, n) => r.classList.toggle('sel', n === sugSel))
}

function tryComplete(q, items) {
  if (!grew || !q || q.length < 3) return
  grew = false
  const strip = u => u.replace(/^https?:\/\//i, '')
  for (const it of items) {
    const s = strip(it.url)
    if (s.length > q.length && s.toLowerCase().startsWith(q.toLowerCase())) {
      omni.value = s
      comp = { base: q, full: s }
      try { omni.setSelectionRange(q.length, s.length) } catch (_) {}
      return
    }
  }
}

function querySug() {
  if (findMode) return
  const q = omni.value
  clearTimeout(sugTimer)
  sugTimer = setTimeout(async () => {
    if (findMode || omni.value !== q) return
    const items = await window.liber.suggest(q)
    if (omni.value === q && document.activeElement === omni) {
      renderSug(items)
      tryComplete(q, items)
    }
  }, 140)
}

function exitFind() {
  if (!findMode) return
  findMode = false
  cntEl.textContent = ''
  omni.placeholder = 'адрес или поиск'
  starEl.style.display = ''
  const a = activeTab()
  omni.value = ''
  lastVal = ''
  if (a) window.liber.findStop(a.id)
  querySug()
}

function enterFind() {
  findMode = true
  starEl.style.display = 'none'
  omni.placeholder = 'найти на странице'
  omni.value = ''
  lastVal = ''
  omni.focus()
}

function renderBm(payload) {
  if (payload) {
    if (Array.isArray(payload)) {
      bms = payload
      bmf = []
    } else {
      bms = payload.items || []
      bmf = payload.folders || []
    }
  }
  const vis = bms.length > 0 && settings.bmBar !== false
  bmbarEl.classList.toggle('show', vis)
  document.body.classList.toggle('hasbm', vis)
  const rows = []
  for (const b of bms.filter(x => !x.folder)) {
    rows.push(bmButton(b))
  }
  for (const f of bmf) {
    const list = bms.filter(x => x.folder === f)
    if (!list.length) continue
    const d = document.createElement('button')
    d.className = 'bmi fold'
    d.textContent = '📁 ' + f
    d.addEventListener('click', e => {
      e.stopPropagation()
      showFolder(e.clientX, e.clientY, list)
    })
    rows.push(d)
  }
  bmbarEl.replaceChildren(...rows)
}

function bmButton(b) {
  const btn = document.createElement('button')
  btn.className = 'bmi'
  btn.textContent = b.title || b.url
  btn.addEventListener('click', () => window.liber.newTab(b.url))
  return btn
}

function showFolder(x, y, list) {
  popMenu(tmenuEl, x, y, list.map(b => ({ label: b.title || b.url, action: () => window.liber.newTab(b.url) })))
}

function renderLock(a) {
  const u = (a && a.url) || ''
  if (/^https:/i.test(u)) {
    let host = ''
    try { host = new URL(u).host } catch (_) {}
    lockEl.textContent = '🔒'
    lockEl.title = 'соединение защищено • ' + host
    lockEl.className = 'lock ok'
  } else if (/^http:/i.test(u)) {
    let host = ''
    try { host = new URL(u).host } catch (_) {}
    lockEl.textContent = '⚠'
    lockEl.title = 'соединение не защищено • ' + host
    lockEl.className = 'lock warn'
  } else {
    lockEl.textContent = ''
    lockEl.title = ''
    lockEl.className = 'lock'
  }
}

const SP_PERMS = [
  ['camera', 'камера'],
  ['microphone', 'микрофон'],
  ['notifications', 'уведомления'],
  ['location', 'геолокация'],
  ['clipboard', 'буфер обмена'],
  ['screen', 'захват экрана'],
  ['popups', 'всплывающие окна'],
  ['ads', 'реклама'],
  ['js', 'javascript'],
  ['cookies', 'куки'],
  ['images', 'картинки']
]

function hideSitePanel() {
  spEl.classList.remove('show')
  spInfo = null
}

async function openSitePanel() {
  spInfo = await window.liber.siteInfo()
  renderSitePanel()
}

function renderSitePanel() {
  const info = spInfo
  if (!info) return
  const r = lockEl.getBoundingClientRect()
  spEl.style.left = Math.max(8, Math.min(r.left - 10, innerWidth - 340)) + 'px'
  spEl.style.top = Math.round(r.bottom + 8) + 'px'
  const head = document.createElement('div')
  head.className = 'sphead'
  if (info.local) {
    const h = document.createElement('div')
    h.className = 'sphost'
    h.textContent = 'страница Liber'
    const sub = document.createElement('div')
    sub.className = 'spsub'
    sub.textContent = 'внутренняя страница, сайта нет'
    head.append(h, sub)
    spEl.replaceChildren(head)
    spEl.classList.add('show')
    return
  }
  const h = document.createElement('div')
  h.className = 'sphost'
  h.textContent = (info.secure ? '🔒 ' : '⚠ ') + info.host
  const sub = document.createElement('div')
  sub.className = 'spsub' + (info.secure ? '' : ' warn')
  sub.textContent = info.secure ? 'соединение защищено' : 'соединение не защищено'
  head.append(h, sub)
  const stat = document.createElement('div')
  stat.className = 'spstat'
  stat.textContent = info.adblockOn
    ? 'заблокировано на сайте: ' + info.blocked
    : 'блокировка рекламы выключена'
  const list = document.createElement('div')
  list.className = 'splist'
  for (const [k, label] of SP_PERMS) {
    const v = info.rule[k] || ''
    const row = document.createElement('div')
    row.className = 'sprow'
    const n = document.createElement('span')
    n.className = 'spn'
    n.textContent = label
    row.append(n)
    for (const p of [['', '—', 'по умолчанию'], ['allow', '✓', 'разрешить'], ['deny', '✕', 'запретить']]) {
      const b = document.createElement('button')
      b.className = 'spb ' + (p[0] === 'allow' ? 'yes' : p[0] === 'deny' ? 'no' : 'def') + (v === p[0] ? ' on' : '')
      b.textContent = p[1]
      b.title = p[2]
      b.addEventListener('click', async () => {
        await window.liber.srSet(info.ruleHost || info.base, { [k]: p[0] })
        const r = Object.assign({}, spInfo.rule)
        if (p[0]) r[k] = p[0]
        else delete r[k]
        spInfo.rule = r
        renderSitePanel()
      })
      row.append(b)
    }
    list.append(row)
  }
  if (info.ruleHost && info.ruleHost !== info.base) {
    const note = document.createElement('div')
    note.className = 'spnote'
    note.textContent = 'действуют общие правила для ' + info.ruleHost
    list.append(note)
  }
  const acts = document.createElement('div')
  acts.className = 'spact'
  const clear = document.createElement('button')
  clear.className = 'spa'
  clear.textContent = 'очистить данные сайта'
  clear.addEventListener('click', async () => {
    if (clear.disabled) return
    clear.disabled = true
    clear.textContent = 'очистка…'
    const n = await window.liber.siteClearData()
    clear.textContent = n > 0 ? 'удалено куки: ' + n : 'данные очищены'
    setTimeout(hideSitePanel, 700)
  })
  const open = document.createElement('button')
  open.className = 'spa'
  open.textContent = 'настройки сайтов'
  open.addEventListener('click', () => { hideSitePanel(); window.liber.page('settings') })
  acts.append(clear, open)
  spEl.replaceChildren(head, stat, list, acts)
  spEl.classList.add('show')
}

function render(s) {
  state = s
  renderTabs(s)
  document.body.classList.toggle('vtab', !!s.vtab)
  engineEl.classList.toggle('off', !s.engine)
  dlsEl.textContent = s.dls > 0 ? '↓ ' + (s.dlsName || s.dls) + (s.dlsPct ? ' ' + s.dlsPct + '%' : '') : ''
  dlsEl.classList.toggle('busy', s.dls > 0)
  starEl.classList.toggle('on', !!s.isBm)
  starEl.textContent = s.isBm ? '★' : '☆'
  const a = activeTab(s) ? activeTab(s) : null
  renderLock(a)
  if (spInfo && spInfo.url !== ((a && a.url) || '')) hideSitePanel()
  if (a && document.activeElement !== omni && !comp) {
    omni.value = a.url && !/^file:/i.test(a.url) ? a.url : ''
    lastVal = omni.value
  }
}

document.addEventListener('click', e => {
  if (!spEl.classList.contains('show')) return
  if (spEl.contains(e.target)) return
  hideSitePanel()
})

let dragTab = null
tabsEl.addEventListener('mousedown', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  if (e.button === 1) { e.preventDefault(); window.liber.closeTab(tab.dataset.id); return }
  if (e.button !== 0 || e.target.closest('.x')) return
  e.preventDefault()
  dragTab = { el: tab }
  tab.classList.add('drag')
  window.addEventListener('mousemove', onTabMove)
  window.addEventListener('mouseup', onTabUp)
})
function onTabMove(e) {
  if (!dragTab) return
  const cur = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tab')
  if (cur && cur !== dragTab.el && cur.parentElement === tabsEl) {
    const rect = cur.getBoundingClientRect()
    const vertical = document.body.classList.contains('vtab')
    const after = vertical ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2
    tabsEl.insertBefore(dragTab.el, after ? cur.nextSibling : cur)
  }
}
function onTabUp() {
  window.removeEventListener('mousemove', onTabMove)
  window.removeEventListener('mouseup', onTabUp)
  if (!dragTab) return
  dragTab.el.classList.remove('drag')
  const ids = [...tabsEl.children].map(c => c.dataset.id).filter(Boolean)
  if (ids.length) window.liber.tabOrder(ids)
  dragTab = null
}

window.liber.state(render)
window.liber.onBm(renderBm)
window.liber.onSettings(s => { settings = Object.assign(settings, s); document.body.classList.toggle('vtab', !!settings.vtab); renderBm() })
window.liber.onOmni(() => { omni.focus(); omni.select(); querySug() })
window.liber.onFind(() => enterFind())
window.liber.onHideSug(() => hideSug())
window.liber.onTabSearch(() => openTabSearch())
window.liber.onFindRes(r => { cntEl.textContent = findMode ? `${r.active}/${r.count}` : '' })
window.liber.onOmniPaste(text => {
  if (!text) return
  const a = activeTab()
  omni.value = text
  lastVal = text
  if (a) window.liber.go(a.id, text)
  hideSug()
})

addEl.addEventListener('click', () => window.liber.newTab())
lockEl.addEventListener('click', e => {
  e.stopPropagation()
  if (spEl.classList.contains('show')) hideSitePanel()
  else openSitePanel()
})
reldEl.addEventListener('click', () => { const a = activeTab(); if (a) window.liber.reload(a.id) })
backEl.addEventListener('click', () => { const a = activeTab(); if (a) window.liber.back(a.id) })
dlsEl.addEventListener('click', () => window.liber.page('dls'))
engineEl.addEventListener('click', () => window.liber.page('settings'))
moreEl.addEventListener('click', e => { e.stopPropagation(); showMainMenu(e.clientX, e.clientY) })

starEl.addEventListener('click', () => {
  const a = activeTab()
  if (a && a.url && /^https?:/i.test(a.url)) window.liber.bmToggle(a.url, a.title)
})

omni.addEventListener('focus', () => { omni.select(); querySug() })
omni.addEventListener('input', () => {
  grew = omni.value.length > lastVal.length
  lastVal = omni.value
  if (comp && omni.value !== comp.full) comp = null
  querySug()
})
omni.addEventListener('blur', () => setTimeout(() => {
  if (!document.hasFocus()) return
  if (!sugEl.contains(document.activeElement)) hideSug()
}, 160))
omni.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (findMode) exitFind()
    else if (comp) { omni.value = comp.base; comp = null; lastVal = omni.value; hideSug() }
    else { omni.value = ''; hideSug(); omni.blur() }
    return
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectSug(sugSel + 1); return }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectSug(sugSel - 1); return }
  if (e.key === 'Tab' && comp) {
    e.preventDefault()
    omni.setSelectionRange(comp.full.length, comp.full.length)
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const a = activeTab()
  if (findMode) {
    if (a) window.liber.find(a.id, omni.value, true)
    return
  }
  const picked = sugSel >= 0 ? sugItems[sugSel] : null
  if (picked && picked.q) { hideSug(); if (a) window.liber.go(a.id, picked.q); return }
  if (picked && picked.url) { hideSug(); if (a) window.liber.go(a.id, picked.url); return }
  if (a) {
    window.liber.go(a.id, omni.value)
    hideSug()
  }
})

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (tsearchEl.classList.contains('show')) { closeTabSearch(); return }
    if (spEl.classList.contains('show')) { hideSitePanel(); return }
    closeMenus()
    if (findMode) exitFind()
    return
  }
  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl || e.altKey) {
    if (e.key === 'F11') { e.preventDefault(); window.liber.full() }
    else if (e.key === 'F6') { e.preventDefault(); omni.focus(); omni.select() }
    return
  }
  const k = e.key.toLowerCase()
  const a = activeTab()
  if (e.shiftKey) {
    if (k === 'o') { e.preventDefault(); window.liber.page('bms') }
    else if (k === 't') { e.preventDefault(); window.liber.reopen() }
    else if (k === 'n') { e.preventDefault(); window.liber.newWindow(true) }
    else if (k === 'a') { e.preventDefault(); openTabSearch() }
    else if (k === 'b') { e.preventDefault(); settings.bmBar = settings.bmBar === false; window.liber.stSet({ bmBar: settings.bmBar }); renderBm(bms) }
    else if (k === 'Delete') { e.preventDefault(); window.liber.page('settings') }
    else if (k === 'Tab') { e.preventDefault(); window.liber.cycle(-1) }
    else if (['+', '='].includes(e.key)) { e.preventDefault(); if (a) window.liber.zoom(a.id, 1) }
    else if (e.key === '-') { e.preventDefault(); if (a) window.liber.zoom(a.id, -1) }
    return
  }
  if (k === 't') { e.preventDefault(); window.liber.newTab() }
  else if (k === 'n') { e.preventDefault(); window.liber.newWindow(false) }
  else if (k === 'w') { e.preventDefault(); if (a) window.liber.closeTab(a.id) }
  else if (k === 'l') { e.preventDefault(); omni.focus(); omni.select() }
  else if (k === 'f') { e.preventDefault(); enterFind() }
  else if (k === 'h') { e.preventDefault(); window.liber.page('hist') }
  else if (k === 'j') { e.preventDefault(); window.liber.page('dls') }
  else if (k === 'u') { e.preventDefault(); if (a) window.liber.source(a.id) }
  else if (k === 's') { e.preventDefault(); if (a) window.liber.save(a.id) }
  else if (k === 'p') { e.preventDefault(); if (a) window.liber.print(a.id) }
  else if (k === 'd' && a && /^https?:/i.test(a.url || '')) {
    e.preventDefault()
    window.liber.bmToggle(a.url, a.title)
  }
  else if (k === 'r') { e.preventDefault(); if (a) window.liber.reload(a.id) }
  else if (k === 'Tab') { e.preventDefault(); window.liber.cycle(1) }
  else if (/^[1-8]$/.test(e.key)) { e.preventDefault(); window.liber.pick(Number(e.key) - 1) }
  else if (e.key === '9') { e.preventDefault(); window.liber.pick(-1) }
  else if (!findMode && ['+', '=', '-'].includes(e.key)) {
    e.preventDefault()
    if (a) window.liber.zoom(a.id, e.key === '-' ? -1 : 1)
  }
  else if (k === '0') { e.preventDefault(); if (a) window.liber.zoom(a.id, 0) }
})

tabsEl.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) tabsEl.scrollLeft += e.deltaY
}, { passive: true })

document.addEventListener('mousedown', e => {
  if (!menuEl.contains(e.target) && e.target !== moreEl) menuEl.classList.remove('show')
  if (!tmenuEl.contains(e.target)) tmenuEl.classList.remove('show')
  if (!tsearchEl.contains(e.target)) tsearchEl.classList.remove('show')
})

window.addEventListener('blur', closeMenus)

for (const b of document.querySelectorAll('.wb')) {
  b.addEventListener('click', () => window.liber.call(b.dataset.m))
}
