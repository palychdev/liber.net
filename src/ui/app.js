const tabsEl = document.getElementById('tabs')
const addEl = document.getElementById('add')
const backEl = document.getElementById('back')
const reldEl = document.getElementById('reld')
const omni = document.getElementById('omni')
const omniwrap = document.getElementById('omniwrap')
const sugEl = document.getElementById('sug')
const bmbarEl = document.getElementById('bmbar')
const starEl = document.getElementById('star')
const cntEl = document.getElementById('cnt')
const engineEl = document.getElementById('engine')
const dlsEl = document.getElementById('dls')

window.addEventListener('error', e => {
  window.__liberErr = String(e.message) + ' @' + (e.filename || '') + ':' + (e.lineno || 0)
})

let state = null
let bms = []
let findMode = false
let sugTimer = null
let sugItems = []

function activeTab() {
  return state && state.tabs.find(t => t.active)
}

function tabEl(t) {
  const d = document.createElement('div')
  d.className = 'tab' + (t.active ? ' on' : '') + (t.loading ? ' ld' : '')
  if (t.favicon) {
    const f = document.createElement('img')
    f.src = t.favicon
    d.append(f)
  }
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = t.loading ? '…' : (t.title || 'Новая вкладка')
  const x = document.createElement('span')
  x.className = 'x'
  x.textContent = '✕'
  x.addEventListener('click', e => { e.stopPropagation(); window.liber.closeTab(t.id) })
  d.append(title, x)
  d.addEventListener('click', () => window.liber.switchTab(t.id))
  return d
}

function hideSug() {
  sugEl.classList.remove('show')
  sugItems = []
  window.liber.chrome(false)
}

function renderSug(items) {
  sugItems = items
  if (!items.length) { hideSug(); return }
  sugEl.replaceChildren(...items.map(it => {
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
    return d
  }))
  sugEl.classList.add('show')
  window.liber.chrome(true)
}

function querySug() {
  if (findMode) return
  const q = omni.value
  clearTimeout(sugTimer)
  sugTimer = setTimeout(async () => {
    if (findMode || omni.value !== q) return
    const items = await window.liber.suggest(q)
    if (omni.value === q && document.activeElement === omni) renderSug(items)
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
  if (a) window.liber.findStop(a.id)
  querySug()
}

function enterFind() {
  findMode = true
  starEl.style.display = 'none'
  omni.placeholder = 'найти на странице'
  omni.value = ''
  omni.focus()
}

function renderBm(list) {
  bms = list
  bmbarEl.classList.toggle('show', bms.length > 0)
  document.body.classList.toggle('hasbm', bms.length > 0)
  bmbarEl.replaceChildren(...bms.map(b => {
    const btn = document.createElement('button')
    btn.className = 'bmi'
    btn.textContent = b.title || b.url
    btn.addEventListener('click', () => window.liber.newTab(b.url))
    return btn
  }))
}

function render(s) {
  state = s
  tabsEl.replaceChildren(...s.tabs.map(tabEl))
  engineEl.classList.toggle('off', !s.engine)
  dlsEl.textContent = s.dls > 0 ? '↓ ' + (s.dlsName || s.dls) + (s.dlsPct ? ' ' + s.dlsPct + '%' : '') : ''
  starEl.classList.toggle('on', !!s.isBm)
  starEl.textContent = s.isBm ? '★' : '☆'
  const a = activeTab(s) ? activeTab(s) : null
  if (a && document.activeElement !== omni) {
    omni.value = a.url && !/^file:/i.test(a.url) ? a.url : ''
  }
}

window.liber.state(render)
window.liber.onBm(renderBm)
window.liber.onOmni(() => { omni.focus(); omni.select(); querySug() })
window.liber.onFind(() => enterFind())
window.liber.onHideSug(() => hideSug())
window.liber.onFindRes(r => { cntEl.textContent = findMode ? `${r.active}/${r.count}` : '' })

addEl.addEventListener('click', () => window.liber.newTab())
reldEl.addEventListener('click', () => { const a = activeTab(); if (a) window.liber.reload(a.id) })
backEl.addEventListener('click', () => { const a = activeTab(); if (a) window.liber.back(a.id) })

starEl.addEventListener('click', () => {
  const a = activeTab()
  if (a && a.url && /^https?:/i.test(a.url)) window.liber.bmToggle(a.url, a.title)
})

omni.addEventListener('focus', () => { omni.select(); querySug() })
omni.addEventListener('input', querySug)
omni.addEventListener('blur', () => setTimeout(() => {
  if (!document.hasFocus()) return
  if (!sugEl.contains(document.activeElement)) hideSug()
}, 160))
omni.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (findMode) exitFind()
    else { omni.value = ''; hideSug(); omni.blur() }
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const a = activeTab()
  if (findMode) {
    if (a) window.liber.find(a.id, omni.value, true)
  } else if (a) {
    window.liber.go(a.id, omni.value)
    hideSug()
  }
})

window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const k = e.key.toLowerCase()
  const a = activeTab()
  if (e.shift && k === 'o') { e.preventDefault(); window.liber.page('bms') }
  else if (k === 't') { e.preventDefault(); window.liber.newTab() }
  else if (k === 'w') { e.preventDefault(); if (a) window.liber.closeTab(a.id) }
  else if (k === 'l') { e.preventDefault(); omni.focus(); omni.select() }
  else if (k === 'f') { e.preventDefault(); enterFind() }
  else if (k === 'h') { e.preventDefault(); window.liber.page('hist') }
  else if (k === 'd' && a && /^https?:/i.test(a.url || '')) {
    e.preventDefault()
    window.liber.bmToggle(a.url, a.title)
  }
  else if (!findMode && ['+', '=', '-'].includes(e.key)) {
    e.preventDefault()
    if (a) window.liber.zoom(a.id, e.key === '-' ? -1 : 1)
  }
  else if (k === '0') { e.preventDefault(); if (a) window.liber.zoom(a.id, 0) }
})

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && findMode) exitFind()
})

for (const b of document.querySelectorAll('.wb')) {
  b.addEventListener('click', () => window.liber.call(b.dataset.m))
}
