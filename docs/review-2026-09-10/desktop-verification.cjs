// Full Electron entrypoint + real services + sandboxed renderer. Disposable state/home.
// npm run build && node_modules/.bin/electron docs/review-2026-09-10/desktop-verification.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-desktop-verification-'))
const home = path.join(scratch, 'home')
const evidence = { checks: [], scratch, corePids: [] }
let failed = false
let win
function record(check, value = true) { evidence.checks.push({check, value}); console.log(JSON.stringify({check,value})) }
async function until(check, label = 'UI') {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(100) }
  throw new Error('Timeout: ' + label)
}
(async () => {
  for (const dir of ['.claude','.codex','.kiro']) fs.mkdirSync(path.join(home,dir), {recursive:true})
  const listener = net.createServer().listen(0,'127.0.0.1')
  await once(listener,'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  process.env.AGENTHUB_HUB_PORT = String(port)
  process.env.AGENTHUB_DESKTOP_STATE_DIR = path.join(scratch,'state')
  process.env.AGENTHUBD_HOME_DIR = home
  await import(path.join(process.cwd(),'desktop/dist/main.js'))
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win && !win.webContents.isLoading() }, 'window')
  const evaluate = text => win.webContents.executeJavaScript(text)
  const hasText = text => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)
  const click = async (text) => {
    assert(await evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b)return false; b.click(); return true})()`), 'button: '+text)
    await delay(100)
  }
  const fill = async (id,value) => {
    await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)}); const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`)
    await delay(50)
  }
  const api = async (route,method='GET',body) => {
    const token = await evaluate('window.agentHub.getSession()')
    const r = await fetch(`http://127.0.0.1:${port}/api${route}`, {method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
    assert(r.ok, `${method} ${route}: ${r.status}`)
    return r.status===204?null:r.json()
  }
  await until(() => hasText('Agregar MCP'))
  assert.equal(await evaluate('typeof window.agentHub.syncNow'),'function')
  assert.equal(await evaluate('typeof window.require'),'undefined')
  record('sandboxed_preload_bridge')
  evidence.corePids.push((await evaluate('window.agentHub.getCoreStatus()')).pid)
  await evaluate('window.agentHub.syncNow()')
  await until(async () => (await api('/local/overview')).clients.length === 3,'client detection')
  await until(async () => (await api('/local/overview')).clients.every(c=>c.synchronized),'sync confirmation')
  record('three_clients_detected_and_synchronized')
  await click('Agregar MCP')
  await fill('server-slug','desktop-check')
  await fill('server-name','Escalidrau')
  await fill('server-transport','http')
  await fill('server-url',process.env.AGENTHUB_TEST_MCP_URL || 'http://127.0.0.1:3580/mcp')
  await click('Crear server')
  await until(async () => (await api('/catalog/servers'))[0]?.tools.length > 0,'probe')
  await until(() => hasText('Probar conexión'))
  record('create_and_probe_from_ui',(await api('/catalog/servers'))[0].tools.length)
  await evaluate(`document.querySelector('[role="switch"]').click()`)
  await until(async () => (await api('/local/overview')).rows.filter(r=>r.resource_type==='mcp_server').every(r=>Object.values(r.cells).every(c=>!c.exposed)),'OFF')
  record('global_off_from_ui')
  await until(() => hasText('Apagado'))
  await evaluate(`document.querySelector('[role="switch"]').click()`)
  await until(async () => (await api('/local/overview')).rows.filter(r=>r.resource_type==='mcp_server').every(r=>Object.values(r.cells).every(c=>c.exposed)),'ON')
  record('global_on_from_ui')
  await evaluate('window.agentHub.syncNow()')
  await delay(1800)
  fs.writeFileSync(path.join(__dirname,'desktop-catalog.png'),(await win.webContents.capturePage()).toPNG())
  await evaluate('location.hash="#/skills"')
  await until(() => hasText('Agregar skill'))
  await click('Agregar skill')
  await fill('skill-slug','desktop-check-skill')
  await fill('skill-name','Desktop check')
  await fill('skill-description','A disposable skill for the desktop check.')
  await fill('skill-body','Read-only test instructions.')
  await click('Crear skill')
  await until(async () => (await api('/catalog/skills')).length===1,'skill')
  await until(() => fs.existsSync(path.join(home,'.codex/skills/desktop-check-skill/SKILL.md')),'skill files')
  record('skill_created_and_distributed')
  fs.mkdirSync(path.join(home,'.gemini'),{recursive:true})
  await until(async () => (await api('/local/overview')).clients.length===4,'late installed CLI')
  record('new_cli_detected_while_running')
  for (const [route,title] of [['clients','Clientes'],['activity','Actividad'],['settings','Ajustes']]) {
    await evaluate(`location.hash=${JSON.stringify('#/'+route)}`)
    await until(() => evaluate(`document.querySelector('h1')?.textContent===${JSON.stringify(title)}`))
    record('route_'+route)
    if(route==='clients') { await delay(1700); fs.writeFileSync(path.join(__dirname,'desktop-clients.png'),(await win.webContents.capturePage()).toPNG()) }
  }
  assert.equal(typeof await evaluate('window.agentHub.getAutostart()'),'boolean')
  record('autostart_readable')
  await evaluate('window.agentHub.restartCore()')
  await until(() => hasText('Agregar MCP'),'service restart')
  evidence.corePids.push((await evaluate('window.agentHub.getCoreStatus()')).pid)
  assert.equal((await api('/catalog/servers')).length,1)
  record('restart_preserves_catalog_and_session')
  win.close()
  assert.equal(win.isVisible(),false)
  record('window_close_keeps_service_running',(await api('/local/overview')).clients.length)
  const server = (await api('/catalog/servers'))[0]
  await api('/policy/rules','PUT',{scope:'user',resource_type:'mcp_server',resource_id:server.id,state:'off',reset_clients:true})
  // Quit immediately after saving: the final OFF must reach offline snapshots.
  evidence.verifyFinalOff = true
})().catch(error => {
  failed=true
  record('failure',error.stack)
}).finally(() => {
  fs.writeFileSync(path.join(__dirname,'desktop-verification.json'),JSON.stringify(evidence,null,2)+'\n')
  process.exitCode=failed?1:0
  app.quit()
})
app.on('will-quit', () => {
  if (evidence.verifyFinalOff) {
    const snapshots = path.join(scratch,'state','snapshots')
    const files = fs.readdirSync(snapshots).filter(f=>f.endsWith('.json'))
    const off = files.every(file=>JSON.parse(fs.readFileSync(path.join(snapshots,file),'utf8')).servers.length===0)
    record('quit_flushes_latest_off_to_disk', off)
    if (!off) process.exitCode=1
  }
  fs.writeFileSync(path.join(__dirname,'desktop-verification.json'),JSON.stringify(evidence,null,2)+'\n')
  fs.rmSync(scratch,{recursive:true,force:true})
})
