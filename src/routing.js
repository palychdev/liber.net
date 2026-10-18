const net = require('net')

const PORT = 1078
const UP_HOST = '127.0.0.1'
const UP_PORT = 1079
const CONNECT_TIMEOUT = 20000

const RULES = [
  { re: /^([a-z0-9-]+\.)*discord\.(com|gg)$/, direct: true },
  { re: /^([a-z0-9-]+\.)*discordapp\.(com|net)$/, direct: true },
]

let server = null
const stats = { total: 0, direct: 0, upstream: 0, failed: 0 }

function ruleFor(host) {
  const h = String(host || '').toLowerCase()
  for (const r of RULES) if (r.re.test(h)) return r
  return null
}

function connectTo(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port })
    const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, CONNECT_TIMEOUT)
    s.once('connect', () => { clearTimeout(timer); s.setTimeout(0); resolve(s) })
    s.once('error', err => { clearTimeout(timer); reject(err) })
  })
}

function pipe(a, b, left) {
  a.on('error', () => b.destroy())
  b.on('error', () => a.destroy())
  a.on('close', () => b.destroy())
  b.on('close', () => a.destroy())
  a.pipe(b)
  b.pipe(a)
  if (left && left.length) b.write(left)
  a.resume()
}

function readReply(sock, state, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sock.removeListener('data', onData)
      sock.removeListener('error', onFail)
      sock.removeListener('close', onFail)
    }
    const onFail = () => { cleanup(); reject(new Error('socks')) }
    const onData = d => {
      state.buf = Buffer.concat([state.buf, d])
      const used = predicate(state.buf)
      if (used === 0) return
      if (used < 0) return onFail()
      cleanup()
      const rest = state.buf.subarray(used)
      state.buf = Buffer.alloc(0)
      resolve(rest)
    }
    sock.on('data', onData)
    sock.on('error', onFail)
    sock.on('close', onFail)
  })
}

async function upstreamConnect(host, port) {
  const up = await connectTo(UP_HOST, UP_PORT)
  const state = { buf: Buffer.alloc(0) }
  const name = Buffer.from(host, 'ascii')
  up.write(Buffer.from([0x05, 0x01, 0x00]))
  await readReply(up, state, b => (b.length < 2 ? 0 : b[0] === 0x05 && b[1] === 0x00 ? 2 : -1))
  up.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([port >> 8, port & 0xff]),
  ]))
  const rest = await readReply(up, state, b => {
    if (b.length < 4) return 0
    if (b[0] !== 0x05 || b[1] !== 0x00) return -1
    const need = 4 + (b[3] === 0x01 ? 4 : b[3] === 0x04 ? 16 : b[4] + 1) + 2
    return b.length < need ? 0 : need
  })
  if (rest.length) up.unshift(rest)
  return up
}

async function route(client, host, port, left) {
  const rule = ruleFor(host)
  if (process.env.LIBER_DEBUG) console.log('[route] ' + host + ':' + port + ' rule=' + (rule ? 'direct' : '-'))
  if (!rule && !net.isIP(host)) {
    try {
      const up = await upstreamConnect(host, port)
      stats.upstream++
      if (process.env.LIBER_DEBUG) console.log('[route] upstream ' + host + ':' + port)
      pipe(client, up, left)
      return
    } catch (_) {}
  }
  try {
    const target = await connectTo(host, port)
    stats.direct++
    if (process.env.LIBER_DEBUG) console.log('[route] direct ' + host + ':' + port)
    pipe(client, target, left)
  } catch (_) {
    stats.failed++
    if (process.env.LIBER_DEBUG) console.log('[route] fail ' + host + ':' + port)
    client.destroy()
  }
}

function serve(client) {
  client.on('error', () => {})
  let buf = Buffer.alloc(0)
  let stage = 0
  const onData = chunk => {
    buf = Buffer.concat([buf, chunk])
    if (stage === 0) {
      if (buf.length < 2) return
      if (buf[0] !== 0x05) return client.destroy()
      const need = 2 + buf[1]
      if (buf.length < need) return
      buf = buf.subarray(need)
      stage = 1
      client.write(Buffer.from([0x05, 0x00]))
    }
    if (stage === 1) {
      if (buf.length < 4) return
      if (buf[0] !== 0x05 || buf[1] !== 0x01) return client.destroy()
      const atyp = buf[3]
      let host = ''
      let p = 4
      if (atyp === 0x01) {
        if (buf.length < 10) return
        host = buf.subarray(4, 8).join('.')
        p = 8
      } else if (atyp === 0x04) {
        if (buf.length < 22) return
        host = buf.subarray(4, 20).toString('hex').match(/.{4}/g).map(w => parseInt(w, 16).toString(16)).join(':')
        p = 20
      } else if (atyp === 0x03) {
        if (buf.length < 5 + buf[4] + 2) return
        host = buf.subarray(5, 5 + buf[4]).toString('ascii')
        p = 5 + buf[4]
      } else return client.destroy()
      const port = buf.readUInt16BE(p)
      const left = buf.subarray(p + 2)
      client.removeListener('data', onData)
      client.pause()
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      stage = 2
      stats.total++
      route(client, host, port, left).catch(() => client.destroy())
    }
  }
  client.on('data', onData)
}

function start() {
  if (server) return PORT
  server = net.createServer(serve)
  server.on('error', () => {})
  try { server.listen(PORT, '127.0.0.1') } catch (_) {}
  return PORT
}

function stop() {
  if (!server) return
  try { server.close() } catch (_) {}
  server = null
}

module.exports = { start, stop, port: () => PORT, stats: () => Object.assign({}, stats), ruleFor }
