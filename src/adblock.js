const TYPE_MASK = { script: 1, image: 2, stylesheet: 4, subdocument: 8, xmlhttprequest: 16, media: 32, font: 64, websocket: 128, ping: 256, other: 512, document: 1024 }

const RES_MAP = { script: 'script', image: 'image', stylesheet: 'stylesheet', subFrame: 'subdocument', xhr: 'xmlhttprequest', media: 'media', font: 'font', websocket: 'websocket', ping: 'ping', mainFrame: 'document' }

const SKIP_OPTS = new Set(['document', 'doc', 'popup', 'popunder', 'csp', 'redirect', 'redirect-rule', 'removeparam', 'rewrite', 'inline-script', 'inline-font', 'generichide', 'elemhide', 'specifichide', 'genericblock', 'match-case', 'empty', 'mp4', 'webrtc', 'object-subrequest', 'permissions'])

const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'com.au', 'com.br', 'com.cn', 'co.kr', 'com.tr', 'com.ua', 'in.ua', 'co.il', 'com.mx', 'co.in', 'com.pl', 'com.ar', 'com.tw', 'co.za', 'com.hk', 'com.ru', 'net.ru', 'org.ru', 'com.by', 'com.kz', 'com.uz'])

const GENERIC_COSMETIC_MAX = 8000
const SHORT_MAX = 4000

function regDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.')
  if (parts.length <= 2) return parts.join('.')
  const last2 = parts.slice(-2).join('.')
  if (TWO_PART.has(last2)) return parts.slice(-3).join('.')
  return last2
}

function hostChain(host) {
  const out = []
  let h = String(host || '').toLowerCase()
  while (h) {
    out.push(h)
    const i = h.indexOf('.')
    if (i < 0) break
    h = h.slice(i + 1)
  }
  return out
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternRe(p, anchorStart, anchorEnd) {
  let out = ''
  for (const ch of String(p)) {
    if (ch === '*') out += '.*'
    else if (ch === '^') out += '(?:[^a-z0-9._%-]|$)'
    else out += escapeRe(ch)
  }
  try {
    return new RegExp((anchorStart ? '^' : '') + out + (anchorEnd ? '$' : ''), 'i')
  } catch (_) {
    return null
  }
}

function longestRun(s) {
  const runs = String(s).toLowerCase().match(/[a-z0-9._%-]{4,}/g)
  if (!runs) return ''
  let best = ''
  for (const r of runs) if (r.length > best.length) best = r
  return best
}

function parseFrom(val) {
  const include = []
  const exclude = []
  for (let d of String(val || '').split('|')) {
    d = d.trim().toLowerCase()
    if (!d) continue
    if (d[0] === '~') exclude.push(d.slice(1))
    else include.push(d)
  }
  return { include, exclude }
}

function parseOptions(s) {
  const o = { types: 0, neg: 0, thirdParty: 0, from: null }
  for (let part of String(s || '').split(',')) {
    part = part.trim()
    if (!part) continue
    let neg = false
    if (part[0] === '~') {
      neg = true
      part = part.slice(1)
    }
    const eq = part.indexOf('=')
    const name = (eq >= 0 ? part.slice(0, eq) : part).toLowerCase()
    if (SKIP_OPTS.has(name)) return { skip: true }
    if (name === 'third-party' || name === '3p') o.thirdParty = neg ? 2 : 1
    else if (name === 'domain' || name === 'from') o.from = parseFrom(part.slice(eq + 1))
    else if (name === 'important' || name === 'all') continue
    else if (TYPE_MASK[name]) {
      if (neg) o.neg |= TYPE_MASK[name]
      else o.types |= TYPE_MASK[name]
    }
  }
  return o
}

function ruleHits(r, mask, third, docHost) {
  if (r.types && !(r.types & mask)) return false
  if (r.neg && (r.neg & mask)) return false
  if (r.thirdParty === 1 && !third) return false
  if (r.thirdParty === 2 && third) return false
  if (r.from) {
    const dh = docHost || ''
    for (const d of r.from.exclude) if (dh === d || dh.endsWith('.' + d)) return false
    if (r.from.include.length) {
      let ok = false
      for (const d of r.from.include) {
        if (dh === d || dh.endsWith('.' + d)) {
          ok = true
          break
        }
      }
      if (!ok) return false
    }
  }
  return true
}

function validSelector(s) {
  if (!s || s.length > 300) return false
  if (/[{};]/.test(s)) return false
  if (s[0] === '+' || s[0] === '>' || s[0] === '~' || s[0] === ',' || s[0] === '[' || s[0] === ':' || s[0] === '#') return false
  if (/:(has-text|contains|style|remove|upward|xpath|matches-css|matches-attr|min-text-length|others|watch-attr|if-not|if|abp-|adguard-|not\(.*:(has-text|contains))/.test(s)) return false
  return true
}

function domainsOk(s) {
  return !!s && !s.includes('~') && !s.includes('#') && !s.includes('*')
}

function domainsOf(s) {
  const out = []
  for (const d of String(s || '').split(',')) {
    const t = d.trim().toLowerCase()
    if (t) out.push(t)
  }
  return out
}

class FilterSet {
  constructor() {
    this.host = new Map()
    this.index = new Map()
    this.short = []
    this.cosmetic = new Map()
    this.cosmeticGeneric = []
  }

  addHost(host, rule) {
    let arr = this.host.get(host)
    if (!arr) {
      arr = []
      this.host.set(host, arr)
    }
    arr.push(rule)
  }

  addGeneric(rule, pattern) {
    const tok = longestRun(pattern)
    if (tok.length >= 6) {
      const key = tok.slice(0, 6)
      let arr = this.index.get(key)
      if (!arr) {
        arr = []
        this.index.set(key, arr)
      }
      arr.push(rule)
    } else if (this.short.length < SHORT_MAX) {
      this.short.push(rule)
    }
  }

  addCosmetic(domains, selector) {
    if (domains.length) {
      for (const d of domains) {
        let arr = this.cosmetic.get(d)
        if (!arr) {
          arr = []
          this.cosmetic.set(d, arr)
        }
        arr.push(selector)
      }
    } else if (this.cosmeticGeneric.length < GENERIC_COSMETIC_MAX) {
      this.cosmeticGeneric.push(selector)
    }
  }
}

class Adblock {
  constructor() {
    this.on = true
    this.ready = false
    this.rules = 0
    this.blocked = 0
    this.sites = new Map()
    this.cosmeticCache = new Map()
    this.allow = new FilterSet()
    this.block = new FilterSet()
  }

  addLine(line) {
    if (!line || line[0] === '!' || line[0] === '[') return
    const ei = line.indexOf('#@#')
    const hi = line.indexOf('##')
    if (ei >= 0 && (hi < 0 || ei < hi)) {
      const doms = line.slice(0, ei)
      const sel = line.slice(ei + 3).trim()
      if (sel && (!doms || domainsOk(doms))) this.allow.addCosmetic(domainsOf(doms), sel)
      return
    }
    if (hi >= 0) {
      const doms = line.slice(0, hi)
      const sel = line.slice(hi + 2).trim()
      if (sel && (!doms || domainsOk(doms))) this.block.addCosmetic(domainsOf(doms), sel)
      return
    }
    if (line.includes('#?#')) return
    let set = this.block
    if (line.startsWith('@@')) {
      set = this.allow
      line = line.slice(2)
    }
    let opts = null
    const di = line.lastIndexOf('$')
    if (di > 0 && /^[a-z0-9~=.,|_*-]+$/i.test(line.slice(di + 1))) {
      opts = parseOptions(line.slice(di + 1))
      if (opts.skip) return
      line = line.slice(0, di)
    }
    if (!line) return
    const rule = {
      re: null,
      types: opts ? opts.types : 0,
      neg: opts ? opts.neg : 0,
      thirdParty: opts ? opts.thirdParty : 0,
      from: opts ? opts.from : null,
    }
    if (line.length > 2 && line[0] === '/' && line[line.length - 1] === '/') {
      rule.re = patternRe(line.slice(1, -1), false, false)
      if (rule.re) {
        set.addGeneric(rule, longestRun(line.slice(1, -1)))
        this.rules += 1
      }
      return
    }
    let anchorStart = false
    let anchorEnd = false
    let domain = false
    if (line.startsWith('||')) {
      domain = true
      line = line.slice(2)
    }
    if (!domain) {
      if (line[0] === '|') {
        anchorStart = true
        line = line.slice(1)
      }
      if (line[line.length - 1] === '|') {
        anchorEnd = true
        line = line.slice(0, -1)
      }
    } else if (line[line.length - 1] === '|') {
      anchorEnd = true
      line = line.slice(0, -1)
    }
    if (domain) {
      const cut = line.search(/[/^|*]/)
      const host = (cut >= 0 ? line.slice(0, cut) : line).toLowerCase()
      const tail = cut >= 0 ? line.slice(cut) : ''
      if (!host || host.includes(':')) return
      if (!tail || tail === '^') {
        set.addHost(host, rule)
      } else {
        rule.re = patternRe(tail, false, anchorEnd)
        if (!rule.re) return
        set.addHost(host, rule)
      }
      this.rules += 1
      return
    }
    rule.re = patternRe(line, anchorStart, anchorEnd)
    if (!rule.re) return
    set.addGeneric(rule, line)
    this.rules += 1
  }

  parse(text) {
    const lines = String(text || '').split('\n')
    for (const l of lines) this.addLine(l.trim())
  }

  finish() {
    this.ready = true
    this.cosmeticCache.clear()
  }

  clear() {
    this.allow = new FilterSet()
    this.block = new FilterSet()
    this.rules = 0
    this.ready = false
    this.cosmeticCache.clear()
  }

  cosmeticFor(host) {
    if (!this.ready) return ''
    const key = String(host || '').toLowerCase()
    const hit = this.cosmeticCache.get(key)
    if (hit !== undefined) return hit
    const sels = []
    for (const s of this.block.cosmeticGeneric) sels.push(s)
    const chain = hostChain(key)
    const ex = new Set()
    for (const c of chain) {
      const xs = this.allow.cosmetic.get(c)
      if (xs) for (const s of xs) ex.add(s)
    }
    for (const c of chain) {
      const xs = this.block.cosmetic.get(c)
      if (xs) for (const s of xs) sels.push(s)
    }
    const uniq = new Set()
    for (const s of sels) if (!ex.has(s) && validSelector(s)) uniq.add(s)
    const arr = [...uniq]
    let css = ''
    for (let i = 0; i < arr.length; i += 60) {
      const chunk = arr.slice(i, i + 60)
      if (chunk.length) css += chunk.join(',') + '{display:none!important}\n'
    }
    if (this.cosmeticCache.size > 150) this.cosmeticCache.clear()
    this.cosmeticCache.set(key, css)
    return css
  }

  check(url, type, docUrl) {
    if (!this.ready || !this.on) return false
    if (!url || !/^https?:/i.test(url)) return false
    const res = RES_MAP[type] || 'other'
    if (res === 'document') return false
    let u = null
    try {
      u = new URL(url)
    } catch (_) {
      return false
    }
    const host = u.hostname.toLowerCase()
    if (!host) return false
    let docHost = ''
    try {
      docHost = new URL(docUrl).hostname.toLowerCase()
    } catch (_) {}
    const mask = TYPE_MASK[res]
    const third = !docHost || regDomain(host) !== regDomain(docHost)
    const target = String(url).toLowerCase()
    if (filterHits(this.allow, host, target, mask, third, docHost)) return false
    if (filterHits(this.block, host, target, mask, third, docHost)) {
      this.blocked += 1
      const key = regDomain(host)
      this.sites.set(key, (this.sites.get(key) || 0) + 1)
      return true
    }
    return false
  }

  stats() {
    const top = [...this.sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    return { on: this.on, ready: this.ready, rules: this.rules, blocked: this.blocked, top }
  }
}

function filterHits(set, host, target, mask, third, docHost) {
  const chain = hostChain(host)
  for (const c of chain) {
    const arr = set.host.get(c)
    if (!arr) continue
    const at = target.indexOf(c)
    const after = at < 0 ? null : target.slice(at + c.length)
    for (const r of arr) {
      if (r.re) {
        if (after === null || !r.re.test(after)) continue
      }
      if (ruleHits(r, mask, third, docHost)) return true
    }
  }
  const short = set.short
  for (let i = 0; i < short.length; i++) {
    const r = short[i]
    if (r.re.test(target) && ruleHits(r, mask, third, docHost)) return true
  }
  for (let i = 0; i + 6 <= target.length; i++) {
    const c = target[i + 5]
    if (c < 'a' || c > 'z') {
      if (c < '0' || c > '9') continue
    }
    const arr = set.index.get(target.slice(i, i + 6))
    if (!arr) continue
    for (const r of arr) {
      if (r.re.test(target) && ruleHits(r, mask, third, docHost)) return true
    }
  }
  return false
}

module.exports = { Adblock, regDomain }
