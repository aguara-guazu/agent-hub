// Run from repository root: node_modules/.bin/electron docs/review-2026-09-10/preload.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-preload-'))
const evidence = []
app.setPath('userData', scratch)
app.whenReady().then(async () => {
  const { windowOptions } = await import(path.join(process.cwd(), 'desktop/dist/window.js'))
  const window = new BrowserWindow(windowOptions(path.join(process.cwd(), 'desktop/dist/preload.js'), ''))
  window.webContents.on('preload-error', (_event, _path, error) => {
    evidence.push({ check: 'preload_error', message: error.message })
  })
  await window.loadURL('data:text/html,<title>Agent Hub preload review</title>')
  evidence.push({ check: 'desktop_bridge', type: await window.webContents.executeJavaScript('typeof window.agentHub') })
  console.log(JSON.stringify(evidence))
  fs.writeFileSync(path.join(__dirname, 'preload-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error.message)
  app.exit(1)
})
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }))
