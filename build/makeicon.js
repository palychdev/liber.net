const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8')
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const cell = 320
const cols = 3
const sheetY = Math.ceil(sizes.length / cols) * cell + 20
const sheetH = 220
const sheetW = 560

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

function ico(frames) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  const dir = Buffer.alloc(16 * frames.length)
  let off = 6 + 16 * frames.length
  frames.forEach((f, i) => {
    const e = i * 16
    const dim = f.size >= 256 ? 0 : f.size
    dir.writeUInt8(dim, e)
    dir.writeUInt8(dim, e + 1)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(f.png.length, e + 8)
    dir.writeUInt32LE(off, e + 12)
    off += f.png.length
  })
  return Buffer.concat([head, dir, ...frames.map(f => f.png)])
}

app.whenReady().then(async () => {
  const tiles = sizes.map((size, i) => {
    const x = (i % cols) * cell
    const y = Math.floor(i / cols) * cell
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px">${svg}</div>`
  }).join('')

  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:100%;height:100%}
  </style><div style="position:relative;width:${cell * cols}px;height:${sheetY + sheetH}px">
    ${tiles}<div id="sheet" style="position:absolute;left:0;top:${sheetY}px;width:${sheetW}px;height:${sheetH}px"></div>
  </div>`

  const devDir = path.join(root, '_dev')
  fs.mkdirSync(devDir, { recursive: true })
  const file = path.join(devDir, 'icon-tmp.html')
  fs.writeFileSync(file, html)

  const win = new BrowserWindow({
    width: cell * cols,
    height: sheetY + sheetH,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })

  let frame = null
  win.webContents.on('paint', (e, dirty, image) => { frame = image })
  win.webContents.setFrameRate(5)

  const shot = async (x, y, w, h) => {
    await new Promise(r => setTimeout(r, 500))
    if (!frame) throw new Error('no paint frame')
    return frame.crop({ x, y, width: w, height: h })
  }

  await win.loadFile(file, { query: { n: String(Date.now()) } })
  await new Promise(r => setTimeout(r, 800))

  const frames = []
  for (let i = 0; i < sizes.length; i++) {
    const x = (i % cols) * cell
    const y = Math.floor(i / cols) * cell
    const img = frame.crop({ x, y, width: sizes[i], height: sizes[i] })
    frames.push({ size: sizes[i], png: img.toPNG() })
  }
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(frames))
  for (const f of frames) fs.writeFileSync(path.join(devDir, 'icon-' + f.size + '.png'), f.png)

  console.log('icon.ico: ' + frames.map(f => f.size).join(','))
  win.destroy()
  app.quit()
})

setTimeout(() => { console.log('TIMEOUT'); process.exit(3) }, 40000)
