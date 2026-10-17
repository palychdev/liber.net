const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const EXE = path.join(__dirname, '..', 'engine', 'ciadpi.exe')
const ARGS = [
  '-i', '127.0.0.1',
  '-p', '1079',
  '--split', '1+s',
  '--disorder', '3+s',
  '--auto=torst',
  '--timeout', '3',
]
const PORT = 1079
const MAX_FAILS = 30

let proc = null
let onFlag = false
let fails = 0
let started = false
const listeners = []

function broadcast() {
  for (const fn of listeners) fn(onFlag)
}

function pipe(stream) {
  stream.on('data', () => {})
}

function spawnEngine() {
  if (proc) return
  proc = spawn(EXE, ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

function start(onChange) {
  if (onChange) listeners.push(onChange)
  started = true
  if (!fs.existsSync(EXE)) return
  spawnEngine()
}

function status() {
  return onFlag
}

function port() {
  return onFlag ? PORT : 0
}

module.exports = { start, status, port }
