const { contextBridge, ipcRenderer } = require('electron')

const JUNK = /(^|[\s_-])(ad|ads|advert|banner|comment|sidebar|related|share|social|promo|navi|nav|menu|footer|header|popup|subscribe|newsletter|cookie|breadcrumb|widget|rating)([\s_-]|$)/i

function readerArticle() {
  const blocks = document.querySelectorAll('article, main, [role=main], [itemprop=articleBody], .post, .article, .entry, #content, .content, section, div')
  let best = null
  let bestScore = 0
  for (const el of blocks) {
    const txt = el.innerText || ''
    if (txt.length < 350) continue
    const mark = el.id + ' ' + (typeof el.className === 'string' ? el.className : '')
    if (JUNK.test(mark)) continue
    const links = [...el.querySelectorAll('a')].reduce((n, a) => n + (a.innerText || '').length, 0)
    const paras = el.querySelectorAll('p').length
    const score = txt.length * (1 - Math.min(0.85, links / Math.max(1, txt.length))) + paras * 60
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  if (!best) return null
  const clone = best.cloneNode(true)
  for (const n of clone.querySelectorAll('script,style,noscript,iframe,svg,video,audio,form,button,input,select,textarea,nav,aside,footer,header,link')) n.remove()
  for (const n of [...clone.querySelectorAll('*')]) {
    const mark = n.id + ' ' + (typeof n.className === 'string' ? n.className : '')
    if (n.tagName !== 'IMG' && JUNK.test(mark)) {
      n.remove()
      continue
    }
    if (!n.textContent.trim() && !n.querySelector('img') && !['IMG', 'BR', 'HR', 'TD', 'TH'].includes(n.tagName)) n.remove()
  }
  return { title: document.title, html: clone.innerHTML }
}

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
  ipcRenderer.on('reader-mode', () => {
    const a = readerArticle()
    if (a) ipcRenderer.send('reader-open', a)
  })
  let cosmeticStyle = null
  const applyCosmetic = () => {
    ipcRenderer.invoke('ads:cosmetic', location.hostname).then(css => {
      if (!css) return
      try {
        if (!cosmeticStyle) {
          cosmeticStyle = document.createElement('style')
          ;(document.head || document.documentElement).appendChild(cosmeticStyle)
        }
        if (cosmeticStyle.textContent !== css) cosmeticStyle.textContent = css
      } catch (_) {}
    }).catch(() => {})
  }
  if (document.documentElement) applyCosmetic()
  else document.addEventListener('DOMContentLoaded', applyCosmetic, { once: true })
  ipcRenderer.on('ads:cosmetic-refresh', applyCosmetic)
}

if (location.protocol === 'file:' || location.protocol === 'liber:') {
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
    readerGet: id => ipcRenderer.invoke('reader:get', id),
    readerBack: () => ipcRenderer.invoke('reader:back'),
    adsStats: () => ipcRenderer.invoke('ads:stats'),
    adsRefresh: () => ipcRenderer.invoke('ads:refresh'),
    srList: () => ipcRenderer.invoke('sr:list'),
    srSet: (host, patch) => ipcRenderer.invoke('sr:set', host, patch),
    srDel: host => ipcRenderer.invoke('sr:del', host),
  })
}
