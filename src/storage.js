const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEFAULTS = { windows: [], bookmarks: [], bmFolders: [], history: [], downloads: [], settings: {} }

function file() {
  return path.join(app.getPath('userData'), 'state.json')
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch (_) {
    return { ...DEFAULTS }
  }
}

function save(data) {
  try {
    const f = file()
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.writeFileSync(f, JSON.stringify(data))
    try { fs.unlinkSync(tmp) } catch (_) {}
  } catch (_) {}
}

module.exports = { load, save }
