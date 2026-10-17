const tabsEl = document.getElementById('tabs')
const addEl = document.getElementById('add')
const backEl = document.getElementById('back')
const omni = document.getElementById('omni')
const engineEl = document.getElementById('engine')

let state = null

function activeTab(s) {
  return s.tabs.find(t => t.active)
}

function render(s) {
  state = s
  const parts = []
  for (const t of s.tabs) {
    const d = document.createElement('div')
    d.className = 'tab' + (t.active ? ' on' : '') + (t.loading ? ' ld' : '')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t.loading ? '…' : (t.title || 'Новая вкладка')
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.addEventListener('click', e => { e.stopPropagation(); window.liber.closeTab(t.id) })
    d.append(title, x)
    d.addEventListener('click', () => window.liber.switchTab(t.id))
    parts.push(d)
  }
  tabsEl.replaceChildren(...parts)
  engineEl.classList.toggle('off', !s.engine)
  const a = activeTab(s)
  if (a && document.activeElement !== omni) {
    omni.value = a.url && !a.url.startsWith('file:') ? a.url : ''
  }
}

window.liber.state(render)

addEl.addEventListener('click', () => window.liber.newTab())

backEl.addEventListener('click', () => {
  const a = state && activeTab(state)
  if (a) window.liber.back(a.id)
})

omni.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  const a = state && activeTab(state)
  if (a) window.liber.go(a.id, omni.value)
})

window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  if (e.key === 't') { e.preventDefault(); window.liber.newTab() }
  else if (e.key === 'w') {
    e.preventDefault()
    const a = state && activeTab(state)
    if (a) window.liber.closeTab(a.id)
  }
  else if (e.key === 'l') { e.preventDefault(); omni.focus(); omni.select() }
})

for (const b of document.querySelectorAll('.wb')) {
  b.addEventListener('click', () => window.liber.call(b.dataset.m))
}
