const { spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const EXE = path.join(__dirname, '..', 'engine', 'ciadpi.exe')
const PORT = 1079
const MAX_FAILS = 30
const PROBE_TIMEOUT = 6000
const PROBE_HOSTS = ['youtube.com', 'instagram.com', 'discord.com']

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
]

let proc = null
let onFlag = false
let fails = 0
let started = false
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

function socksConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    let done = false
    let step = 0
    let buf = Buffer.alloc(0)
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
        const hello = [
          0x16, 0x03, 0x01, 0x00, 0x00, 0x03, 0x03, 0x00,
          0x00, 0x00, 0x20, 0x00, 0x00, 0x13, 0x01, 0x00,
          0x00, 0x00, 0x0a, 0x13, 0x01, 0x13, 0x02, 0x13,
          0x03, 0xff, 0x01, 0x00,
        ]
        hello[4] = hello.length - 4
        sock.write(Buffer.from(hello))
      } else {
        finish(true)
      }
    })
    sock.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err) } })
    sock.on('close', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('closed')) } })
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
        if (!(await waitPort(2500))) return finish(false)
        for (const host of PROBE_HOSTS) {
          try {
            if (await socksConnect(host, 443, 3000)) return finish(true)
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

module.exports = { start, status, port, info, reprobe }
