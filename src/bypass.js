const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const EXE = path.join(__dirname, '..', 'engine', 'ciadpi.exe')
const PORT = 1079
const MAX_FAILS = 30
const PROBE_TIMEOUT = 12000
const PROBE_HOSTS = ['youtube.com']

const STRATEGIES = [
  {
    name: 'базовый',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '3+s', '--auto=torst', '--timeout', '3'],
  },
  {
    name: 'мягкий',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '2+8s', '--disorder', '1+8s', '--auto=torst', '--timeout', '3'],
  },
  {
    name: 'жёсткий',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '3+s', '--timeout', '3'],
  },
  {
    name: 'фейк TLS',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--fake', '1+s', '--fake-tls-mod', 'rand', '--auto=torst', '--timeout', '3'],
  },
  {
    name: 'TLS запись',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--tlsrec', '1+s', '--auto=torst', '--timeout', '3'],
  },
  {
    name: 'фейк + запись',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '3+s', '--fake', '1+s', '--fake-tls-mod', 'rand', '--tlsrec', '1+s', '--auto=torst', '--timeout', '3'],
  },
  {
    name: 'ssl_err авто',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '3+s', '--auto=ssl_err', '--timeout', '3'],
  },
  {
    name: 'без авто',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '3+s', '--auto=none', '--timeout', '5'],
  },
  {
    name: 'агрессивный',
    args: ['-i', '127.0.0.1', '-p', String(PORT), '--split', '1+s', '--disorder', '1+s', '--fake', '1+s', '--fake-tls-mod', 'rand', '--tlsrec', '1+s', '--auto=ssl_err', '--timeout', '5'],
  },
]

let proc = null
let onFlag = false
let fails = 0
let started = false
let liveIdx = 0
let liveArgs = STRATEGIES[0].args
let liveName = STRATEGIES[0].name
let liveWorking = false
const listeners = []

function broadcast() {
  for (const fn of listeners) fn(onFlag)
}

function pipe(stream) {
  stream.on('data', () => {})
}

function waitPort(timeout) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeout)
    const tryConn = () => {
      const sock = new net.Socket()
      sock.once('connect', () => { sock.destroy(); clearTimeout(timer); resolve(true) })
      sock.once('error', () => { sock.destroy(); setTimeout(tryConn, 150) })
      sock.connect(PORT, '127.0.0.1')
    }
    tryConn()
  })
}

function tlsClientHello(host) {
  const sni = Buffer.from(host, 'utf8')
  const body = Buffer.alloc(42 + sni.length)
  body[0] = 0x03 // client_version major
  body[1] = 0x03 // client_version minor
  // random (32 bytes) - fill with fixed pattern
  for (let i = 2; i < 34; i++) body[i] = 0x41
  body[34] = 0x00 // session id length
  body[35] = 0x00
  body[36] = 0x00 // cipher suites length (high)
  body[37] = 0x2a // cipher suites length (low) = 42
  // cipher suites (42 bytes) - TLS_AES_128_GCM_SHA256 etc.
  const suites = [0x13, 0x01, 0x13, 0x02, 0x13, 0x03, 0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30, 0xcc, 0xa9, 0xcc, 0xa8, 0xc0, 0x13, 0xc0, 0x14, 0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f, 0x00, 0x35, 0x00, 0x0a, 0xff, 0xff]
  Buffer.from(suites).copy(body, 38)
  body[80] = 0x01 // compression methods length
  body[81] = 0x00 // null compression
  // extensions length
  const extLen = 5 + 2 + 2 + sni.length // server_name extension
  body[82] = (extLen >> 8) & 0xff
  body[83] = extLen & 0xff
  body[84] = 0x00 // extension type server_name (0x0000)
  body[85] = 0x00
  body[86] = (3 + sni.length) >> 8 // extension data length
  body[87] = (3 + sni.length) & 0xff
  body[88] = 0x00 // sni list length (high)
  body[89] = sni.length // sni list length (low)
  sni.copy(body, 90)
  // TLS record header
  const record = Buffer.alloc(5 + body.length)
  record[0] = 0x16 // handshake
  record[1] = 0x03
  record[2] = 0x03
  record[3] = (body.length >> 8) & 0xff
  record[4] = body.length & 0xff
  body.copy(record, 5)
  return record
}

function socksConnectWithTLS(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    let done = false
    let step = 0
    let buf = Buffer.alloc(0)
    let gotServerHello = false
    const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('timeout')) } }, timeout)
    const finish = ok => { if (!done) { done = true; clearTimeout(timer); try { sock.destroy() } catch (_) {}; resolve(ok) } }
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    sock.on('data', data => {
      buf = Buffer.concat([buf, data])
      if (step === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false)
        buf = buf.slice(2)
        step = 1
        const hb = Buffer.from(host, 'utf8')
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.from([port >> 8, port & 0xff]),
        ])
        sock.write(req)
      } else if (step === 1) {
        if (buf.length < 4) return
        if (buf[1] !== 0x00) return finish(false)
        step = 2
        buf = buf.slice(4)
        sock.write(tlsClientHello(host))
      } else {
        // step 2: waiting for ServerHello (0x16 0x03 0x03 ... 0x02)
        if (buf.length >= 5 && buf[0] === 0x16 && buf[1] === 0x03 && buf[3] > 0 && buf[4] === 0x02) {
          gotServerHello = true
          finish(true)
        }
      }
    })
    sock.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err) } })
    sock.on('close', () => { if (!done && !gotServerHello) { done = true; clearTimeout(timer); reject(new Error('closed')) } })
    sock.connect(PORT, '127.0.0.1')
  })
}

function probeStrategy(strategy) {
  return new Promise(resolve => {
    let done = false
    const p = spawn(EXE, strategy.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = ok => { if (done) return; done = true; try { p.kill() } catch (_) {}; resolve({ strategy, ok }) }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT)
    p.on('spawn', async () => {
      try {
        if (!(await waitPort(3000))) return finish(false)
        for (const host of PROBE_HOSTS) {
          try {
            if (await socksConnectWithTLS(host, 443, 4000)) return finish(true)
          } catch (_) {}
        }
        finish(false)
      } catch (_) { finish(false) }
    })
    p.on('error', () => finish(false))
  })
}

async function probeAll() {
  for (const strategy of STRATEGIES) {
    const res = await probeStrategy(strategy)
    if (res.ok) return { args: strategy.args, name: strategy.name, working: true }
  }
  return { args: STRATEGIES[0].args, name: STRATEGIES[0].name, working: false }
}

async function start(onChange) {
  if (onChange) listeners.push(onChange)
  started = true
  if (!fs.existsSync(EXE)) return
  const chosen = await probeAll()
  liveArgs = chosen.args
  liveName = chosen.name
  liveWorking = chosen.working
  spawnEngine()
  broadcast()
}

function spawnEngine() {
  if (proc) return
  proc = spawn(EXE, liveArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.on('spawn', () => { onFlag = true; fails = 0; broadcast() })
  proc.on('error', () => { onFlag = false; broadcast() })
  pipe(proc.stdout)
  pipe(proc.stderr)
  proc.on('exit', () => {
    proc = null
    if (onFlag) { onFlag = false; broadcast() }
    if (!started) return
    if (fails < MAX_FAILS) {
      fails += 1
      setTimeout(spawnEngine, 2000)
    }
  })
}

async function reprobe() {
  if (proc) { try { proc.kill() } catch (_) {}; proc = null; onFlag = false; broadcast() }
  const chosen = await probeAll()
  liveArgs = chosen.args
  liveName = chosen.name
  liveWorking = chosen.working
  spawnEngine()
  broadcast()
}

function status() {
  return onFlag
}

function port() {
  return onFlag ? PORT : 0
}

function info() {
  return { name: liveName, working: liveWorking, port: onFlag ? PORT : 0 }
}

function getStrategies() {
  return STRATEGIES.map((s, i) => ({ i, name: s.name, active: i === liveIdx, working: i === liveIdx && liveWorking }))
}

async function setStrategy(idx) {
  idx = Number(idx)
  if (!Number.isInteger(idx) || idx < 0 || idx >= STRATEGIES.length) return false
  liveIdx = idx
  liveArgs = STRATEGIES[idx].args
  liveName = STRATEGIES[idx].name
  liveWorking = false
  if (proc) { try { proc.kill() } catch (_) {}; proc = null; onFlag = false; broadcast() }
  spawnEngine()
  broadcast()
  return true
}

module.exports = { start, status, port, info, getStrategies, setStrategy, reprobe }
