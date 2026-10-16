/** Real processes + browser + HTTP MCP + Noise. No direct writes to databases or replicated logs. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const frontendRequire = createRequire(join(root, 'frontend/package.json'))
const { chromium } = frontendRequire('playwright')
const DHT = createRequire(join(root, 'packages/memory/package.json'))('hyperdht')
const state = await mkdtemp(join(tmpdir(), 'hub-sharing-e2e-state-'))
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'hub-sharing-e2e-results-'))
await mkdir(output, { recursive: true })
const hubs = [], clients = [], checks = [], browserErrors = [], secrets = []
let browser, bootstrap, projectId, phrase, backupFile, originalInvitation, failure
const startedAt = new Date().toISOString()
const safe = message => secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), String(message))
async function until(label, fn, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result } catch (error) { last = error }
    await delay(300)
  }
  throw new Error(`Timeout: ${label}${last ? ` (${safe(last.message)})` : ''}`)
}
async function step(name, fn) {
  const started = Date.now()
  console.log(`RUN ${name}`)
  try { await fn(); checks.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); console.log(`PASS ${name}`) }
  catch (error) { checks.push({ name, status: 'failed', elapsed_ms: Date.now() - started, error: safe(error.message) }); throw error }
}
async function freePort() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port
  await new Promise(r => s.close(r)); return port
}
async function newHub(name) {
  const directory = join(state, name); await mkdir(directory, { recursive: true })
  const port = await freePort(), base = `http://127.0.0.1:${port}`, bootstrapToken = randomBytes(32).toString('hex')
  secrets.push(bootstrapToken)
  const env = { ...process.env, AGENTHUB_HUB_HOST: '127.0.0.1', AGENTHUB_HUB_PORT: String(port), AGENTHUB_LOCAL_MODE: '1',
    AGENTHUB_STARTER_CATALOG: '0', AGENTHUB_DATABASE_PATH: join(directory, 'hub.db'), AGENTHUB_MEMORY_DIR: join(directory, 'memory'),
    AGENTHUB_LOG_DIR: join(directory, 'logs'), AGENTHUB_MEMORY_WORKER: '1', AGENTHUB_OAUTH_REDIRECT_URL: `${base}/api/oauth/callback`, AGENTHUB_CONSOLE_DIST: join(root, 'frontend/dist'), AGENTHUB_JWT_SECRET: randomBytes(32).toString('hex'),
    AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: bootstrapToken, AGENTHUB_OAUTH_DIR: join(directory, 'oauth'), AGENTHUB_STDIN_LIFELINE: '1' }
  const hub = { name, directory, base, child: null, logs: '', page: null, token: null, identity: null }
  hubs.push(hub)
  hub.start = async () => {
    hub.child = spawn(process.execPath, [join(root, 'packages/core/dist/server.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    for (const stream of [hub.child.stdout, hub.child.stderr]) stream.on('data', data => { hub.logs = (hub.logs + data.toString()).slice(-30_000) })
    await until(`${name} starts`, async () => {
      if (hub.child.exitCode !== null) throw new Error(`Hub stopped: ${safe(hub.logs)}`)
      return (await globalThis.fetch(base + '/health')).ok
    }, 20_000)
    const auth = await globalThis.fetch(base + '/api/auth/desktop-session', { method: 'POST', headers: { authorization: `Bearer ${bootstrapToken}` } })
    assert.equal(auth.status, 200); hub.token = (await auth.json()).access_token; secrets.push(hub.token)
  }
  hub.stop = async (crash = false) => {
    if (!hub.child || hub.child.exitCode !== null || hub.child.signalCode) return
    const child = hub.child, exited = new Promise(r => child.once('exit', r))
    if (crash) hub.child.kill('SIGKILL'); else hub.child.stdin.end()
    await Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL') })])
    await exited
  }
  hub.request = async (path, body, expected = 200, method = 'POST') => {
    const res = await globalThis.fetch(base + '/api/' + path, { method, headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: globalThis.AbortSignal.timeout(30_000) })
    const value = res.status === 204 ? null : await res.json()
    assert.equal(res.status, expected, `${name} ${path}: ${res.status}, ${safe(value?.detail ?? '')}`); return value
  }
  hub.admin = (operation, input = {}, expected) => hub.request('memory/sharing/call', { operation, ...input }, expected)
  hub.memory = (operation, input = {}, expected) => hub.request('memory/call', { operation, input }, expected)
  hub.status = () => hub.memory('shared_status', { project_id: projectId })
  await hub.start()
  await network(hub, false) // isolated discovery until the test connects the partitions
  await hub.request('memory/ai', { extraction: 'disabled', extraction_model: '', extraction_reasoning_effort: '', embeddings_enabled: false, embedding_model: 'google/embeddinggemma-300m', ollama_url: 'http://127.0.0.1:11434', remote_processing_enabled: false, identity_auto_merge: false, project_auto_assign: false }, 200, 'PUT')
  await hub.request('memory/embeddings/native/cancel', {})
  for (const module of ['ocr', 'decoder', 'vision', 'audio', 'speech']) await hub.request(`memory/media/${module}/cancel`, {})
  await hub.admin('rename', { name })
  hub.identity = (await hub.admin('status')).identity
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
  await context.addInitScript(token => globalThis.localStorage.setItem('agenthub.token', token), hub.token)
  hub.page = await context.newPage(); hub.page.on('pageerror', error => browserErrors.push(safe(error.message)))
  return hub
}
async function mcp(hub, agentId) {
  // Only read this isolated test Hub's MCP credential; never inspect the person's real vault.
  const credential = await readFile(join(hub.directory, 'memory/secrets/memory-mcp'), 'utf8'); secrets.push(credential)
  const client = new Client({ name: `e2e-${agentId}`, version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.base + '/api/memory/mcp'), { requestInit: { headers: { authorization: credential } } }))
  clients.push(client)
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args, _meta: { 'agenthub/agent': { agent_id: agentId, cli_kind: 'codex_cli', client: 'e2e', session_id: `session-${agentId}-e2e`, cwd: null } } })
    assert.notEqual(result.isError, true, `MCP ${name}: ${safe(JSON.stringify(result.content))}`)
    return result.content.filter(c => c.type === 'text').map(c => JSON.parse(c.text))
  }
}
async function network(hub, reachable) { return hub.admin('network', { settings: { bind_host: '127.0.0.1', bootstrap: [reachable ? `127.0.0.1:${bootstrap.address().port}` : '127.0.0.1:1'] } }) }
async function projectPage(hub) { await hub.page.goto(`${hub.base}/#/projects/${projectId}?tab=sharing`) }
async function visibleAction(hub, name) {
  const button = hub.page.getByRole('button', { name, exact: true })
  await button.waitFor()
  const box = await button.boundingBox(), viewport = hub.page.viewportSize()
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${name} must be visible without scrolling`)
  return button
}
async function screenshot(hub, name) {
  await hub.page.screenshot({ path: join(output, name), fullPage: true,
    mask: [hub.page.locator('input[type=password]'), hub.page.locator('textarea[aria-label="Frase de recuperación del proyecto"]')] })
}
async function entities(hub, kind) { return hub.memory('list_entities', { project_id: projectId, kind, limit: 200 }) }
async function publish(hub, entityId) { return hub.memory('publish_source', { project_id: projectId, entity_id: entityId }) }
async function invite(owner, guest, role = 'maintainer') {
  const invitation = await owner.admin('member', { project_id: projectId, identity: guest.identity, role, invite: false })
  await guest.admin('join', { invitation })
}
try {
  browser = await chromium.launch({ headless: true })
  const probe = createSocket('udp4'); await new Promise(r => probe.bind(0, '127.0.0.1', r)); const port = probe.address().port
  // bootstrapper's second argument is the advertised address, not the bind host.
  // Bind explicitly so an active desktop Hub/public DHT cannot affect loopback discovery.
  await new Promise(r => probe.close(r)); bootstrap = DHT.bootstrapper(port, '127.0.0.1', { host: '127.0.0.1' }); await bootstrap.ready()
  const a = await newHub('Ana'), b = await newHub('Bruno')
  let sourceA, sourceB, agentA, agentB, otherAgentB, publicMessage, privateMessage
  await step('Authenticated UI, factory skills and invitation bound to identity', async () => {
    assert.equal((await globalThis.fetch(a.base + '/api/memory/sharing/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":"status"}' })).status, 401)
    const skills = await a.request('catalog/skills', undefined, 200, 'GET')
    assert.ok(skills.find(s => s.slug === 'memory').body.includes('hub-collaboration'))
    assert.ok(skills.find(s => s.slug === 'hub-collaboration').body.includes('memory_read_messages'))
    projectId = (await a.memory('create_entity', { kind: 'project', title: 'Proyecto P2P · E2E' })).id
    await a.page.setViewportSize({ width: 900, height: 700 })
    await a.page.goto(`${a.base}/#/projects/${projectId}`)
    await (await visibleAction(a, 'Compartir proyecto')).click()
    await screenshot(a, 'share-entry.png')
    await a.page.setViewportSize({ width: 1440, height: 1080 })
    await a.page.getByRole('button', { name: 'Habilitar proyecto compartido' }).click()
    const input = a.page.getByLabel('Frase de recuperación del proyecto', { exact: true }); await input.waitFor()
    phrase = await input.inputValue(); secrets.push(phrase); assert.equal(phrase.split(' ').length, 24)
    await a.page.getByRole('button', { name: 'Ya guardé la frase' }).click()
    await a.page.goto(`${a.base}/#/settings`)
    await a.page.getByRole('button', { name: 'Ver palabras de recuperación' }).click()
    await until('owner can reveal saved phrase after reload', async () => await a.page.getByLabel('Frase de recuperación del proyecto', { exact: true }).inputValue() === phrase)
    await a.page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).first().click()
    await projectPage(a)
    await a.page.getByText('Invitar o cambiar permisos', { exact: true }).click()
    await a.page.getByLabel('Identidad pública del invitado').fill(JSON.stringify(b.identity))
    await a.page.getByRole('button', { name: 'Crear invitación' }).click()
    const code = a.page.getByLabel('Invitación para compartir'); await code.waitFor(); const invitation = await code.inputValue(); originalInvitation = JSON.parse(invitation)
    await b.page.setViewportSize({ width: 900, height: 700 })
    await b.page.goto(`${b.base}/#/projects`)
    await visibleAction(b, 'Unirme a un proyecto')
    await screenshot(b, 'join-entry.png')
    await (await visibleAction(b, 'Unirme a un proyecto')).click()
    await b.page.setViewportSize({ width: 1440, height: 1080 })
    await b.page.getByLabel('Invitación', { exact: true }).fill(invitation)
    await b.page.getByRole('button', { name: 'Unirme al proyecto', exact: true }).click(); await b.page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal((await b.status()).members.find(m => m.identity.id === b.identity.id).role, 'maintainer')
    await b.admin('recovery_phrase', { project_id: projectId }, 403)
    await projectPage(b)
    await b.page.getByRole('heading', { name: 'Participantes', exact: true }).waitFor()
    assert.equal(await b.page.getByRole('button', { name: 'Ver palabras de recuperación' }).count(), 0)
    await b.admin('member', { project_id: projectId, identity: a.identity, role: 'owner', invite: true }, 403)
  })
  await step('Independent imports deduplicate and complementary contributions cross real P2P', async () => {
    for (const [index, hub] of [a, b].entries()) {
      const source = await hub.memory('import_source', { kind: 'meeting', title: 'Planificación compartida', external_id: `meeting-${index}`, account: `account-${index}`,
        url: 'https://example.test/meeting/common', text: 'La entrega es el viernes y Ana revisa.', project_ids: [projectId] })
      if (index === 0) sourceA = source; else sourceB = source
      await hub.memory('import_source', { kind: 'note', title: `Aporte ${hub.name}`, external_id: `contribution-${index}`, text: index ? 'Ana revisa.' : 'La entrega es el viernes.', project_ids: [projectId] })
    }
    // Configure discovery through the UI on one participant, API on the other.
    await a.page.goto(`${a.base}/#/settings`)
    await a.page.getByText('Red P2P · opciones avanzadas', { exact: true }).click()
    await a.page.getByLabel('Nodos de descubrimiento propios', { exact: false }).fill(`127.0.0.1:${bootstrap.address().port}`)
    await a.page.getByLabel('Dirección IPv4 de escucha').fill('127.0.0.1')
    await a.page.getByRole('button', { name: 'Guardar descubrimiento', exact: true }).click(); await network(b, true)
    await until('both hubs converge', async () => {
      const counts = [(await entities(a, 'note')).total, (await entities(b, 'note')).total]
      if (counts.every(n => n === 2)) return true
      const states = await Promise.all([a, b].map(async h => ({ name: h.name, network: (await h.admin('status')).network })))
      throw new Error(JSON.stringify({ counts, states }))
    })
    await until('per-member receipt is confirmed', async () => (await a.admin('status')).network.peers.some(p => p.project_id === projectId && p.member_id === b.identity.id && p.state === 'synced' && p.total > 0))
    await projectPage(a)
    await until('progress bar reaches 100', async () => await a.page.getByRole('progressbar', { name: 'Recepción de Bruno' }).getAttribute('value') === '100')
    assert.equal(await a.page.getByText('Identidad y conexión P2P', { exact: true }).count(), 0)
    await screenshot(a, 'member-progress.png')
    for (const hub of [a, b]) {
      assert.equal((await entities(hub, 'meeting')).total, 1)
      const publication = (await hub.status()).publications.find(p => p.versions[0]?.title === 'Planificación compartida'); assert.equal(publication.conflict, false)
      assert.equal(new Set(publication.contributors.map(c => c.author)).size, 2)
    }
    await publish(a, sourceA.entity_id); await publish(b, sourceB.entity_id)
    assert.equal((await entities(a, 'meeting')).total, 1); assert.equal((await entities(b, 'meeting')).total, 1)
  })
  await step('Tasks, typed collections and original attachment cross the peer connection', async () => {
    const task = await b.memory('save_task', { project_id: projectId, title: 'Tarea de Bruno', origin: 'manual', status: 'in_progress' }); await publish(b, task.id)
    const collection = await b.memory('create_entity', { kind: 'collection', title: 'Equipo', project_ids: [projectId], data: { fields: [{ key: 'name', label: 'Nombre', type: 'text', required: true }] } })
    await b.memory('add_record', { collection_id: collection.id, values: { name: 'Ana' }, idempotency_key: 'ana' }); await publish(b, collection.id)
    await a.memory('import_file', { title: 'Archivo del proyecto', filename: 'evidence.txt', data_base64: globalThis.Buffer.from('Archivo de evidencia original E2E.').toString('base64'), project_ids: [projectId] })
    await until('task and collection reach Ana', async () => (await a.memory('list_tasks', { project_id: projectId })).total === 1 && (await entities(a, 'collection')).total === 1)
    const importedCollection = (await entities(a, 'collection')).items[0]
    assert.equal((await a.memory('list_records', { collection_id: importedCollection.id })).items[0].values.name, 'Ana')
    await until('file reaches Bruno', async () => (await entities(b, 'document')).items.find(e => e.title === 'Archivo del proyecto'))
    const doc = (await entities(b, 'document')).items.find(e => e.title === 'Archivo del proyecto')
    const version = (await b.memory('get_entity', { id: doc.id })).sources[0].current_version_id
    const got = await b.memory('get_file', { version_id: version, include_content: true })
    assert.equal(globalThis.Buffer.from(got.data_base64, 'base64').toString(), 'Archivo de evidencia original E2E.')
  })
  await step('MCP notice is lazy, private routing works and reading clears only that agent', async () => {
    agentB = await mcp(b, 'bruno-agent'); otherAgentB = await mcp(b, 'other-agent')
    agentA = await mcp(a, 'ana-agent')
    await a.memory('send_message', { project_id: projectId, text: 'No se permite desde la consola', expires_at: new Date(Date.now() + 60_000).toISOString() }, 403)
    publicMessage = (await agentA('send_message', { project_id: projectId, text: 'Mensaje público E2E', expires_at: new Date(Date.now() + 3_600_000).toISOString() }))[0]
    privateMessage = (await agentA('send_message', { project_id: projectId, text: 'Privado sólo para el agente de Bruno', to_member: b.identity.id, to_agent: 'bruno-agent', expires_at: new Date(Date.now() + 3_600_000).toISOString() }))[0]
    await until('messages cross P2P', async () => (await b.memory('read_messages', { project_id: projectId })).items.some(m => m.id === privateMessage.id))
    const response = await agentB('list_tasks', { project_id: projectId })
    const notice = response.find(c => c.collaboration_notice)?.collaboration_notice
    assert.equal(notice.pending, 2); assert.equal(notice.tool, 'memory_read_messages')
    assert.ok(!JSON.stringify(notice).includes('Privado sólo'))
    assert.ok(!(await agentB('list_tasks', { project_id: projectId })).some(c => c.collaboration_notice))
    const others = (await otherAgentB('read_messages', { project_id: projectId }))[0].items
    assert.ok(others.some(m => m.id === publicMessage.id)); assert.ok(!others.some(m => m.id === privateMessage.id))
    const pending = (await agentB('read_messages', { project_id: projectId, unread_only: true }))[0].items
    assert.equal(pending.length, 2)
    assert.equal((await agentB('read_messages', { project_id: projectId, unread_only: true }))[0].total, 0)
    await agentB('ack_message', { project_id: projectId, message_id: privateMessage.id, state: 'handled' })
    await projectPage(b); await b.page.getByRole('button', { name: 'Foro de agentes', exact: true }).click()
    await b.page.getByText('Mensaje público E2E', { exact: true }).waitFor()
    assert.equal(await b.page.getByRole('button', { name: 'Enviar', exact: true }).count(), 0)
    assert.equal(await b.page.getByRole('button', { name: 'Marcar atendido', exact: true }).count(), 0)
    await b.page.getByRole('heading', { name: 'Foro de agentes' }).scrollIntoViewIfNeeded(); await screenshot(b, 'messages.png')
  })
  await step('Reader cannot write; revocation propagates; owner can readmit', async () => {
    await a.admin('member', { project_id: projectId, identity: b.identity, role: 'reader', invite: false })
    await until('reader policy arrives', async () => (await b.status()).members.find(m => m.identity.id === b.identity.id).role === 'reader')
    await b.memory('send_message', { project_id: projectId, text: 'No debe publicarse', expires_at: new Date(Date.now() + 60_000).toISOString() }, 403)
    await a.admin('member', { project_id: projectId, identity: b.identity, role: 'reader', invite: false, revoke: true })
    await until('revocation arrives', async () => (await b.status()).members.find(m => m.identity.id === b.identity.id).revoked)
    await b.memory('read_messages', { project_id: projectId }, 403)
    await invite(a, b)
  })
  await step('Concurrent offline edits retain alternatives and resolve explicitly', async () => {
    await network(a, false); await network(b, false)
    for (const [i, hub, source] of [[0, a, sourceA], [1, b, sourceB]]) {
      await hub.memory('import_source', { kind: 'meeting', title: 'Planificación compartida', external_id: `meeting-${i}`, account: `account-${i}`,
        url: 'https://example.test/meeting/common', text: i ? 'Cambio de Bruno: entregar el lunes.' : 'Cambio de Ana: entregar el martes.', project_ids: [projectId] })
      await publish(hub, source.entity_id)
    }
    await network(a, true); await network(b, true)
    const conflict = await until('conflict appears on Ana', async () => (await a.status()).publications.find(p => p.conflict))
    assert.equal(conflict.versions.length, 2)
    const versions = await Promise.all(conflict.versions.map(v => a.memory('shared_version', { project_id: projectId, event_id: v.event_id })))
    assert.ok(versions.some(v => v.payload.fragments[0].text.includes('lunes'))); assert.ok(versions.some(v => v.payload.fragments[0].text.includes('martes')))
    await until('Bruno also sees both concurrent edits', async () => (await b.status()).publications.find(p => p.key === conflict.key)?.conflict)
    await a.memory('resolve_shared', { project_id: projectId, key: conflict.key, event_id: conflict.versions[0].event_id })
    await until('resolution reaches Bruno', async () => !(await b.status()).publications.some(p => p.conflict))
  })
  await step('Crash/restart preserves identity and sync resumes without reconfiguration', async () => {
    await b.stop(true)
    const offline = await a.memory('import_source', { kind: 'note', title: 'Durante la caída', external_id: 'offline-note', text: 'Dato generado mientras Bruno estaba apagado.', project_ids: [projectId] }); await publish(a, offline.entity_id)
    await b.start()
    assert.equal((await b.admin('status')).identity.id, b.identity.id)
    await until('catch-up after crash', async () => {
      if ((await entities(b, 'note')).items.some(e => e.title === 'Durante la caída')) return true
      throw new Error(JSON.stringify({ publications: (await b.status()).publications.map(p => p.versions.map(v => v.title)), network: (await b.admin('status')).network }))
    })
  })
  await step('TTL message is visible and then expires', async () => {
    const expires = new Date(Date.now() + 22_000).toISOString()
    const ephemeral = (await agentA('send_message', { project_id: projectId, text: 'Mensaje efímero E2E', expires_at: expires }))[0]
    await until('ephemeral message arrives before expiry', async () => (await b.memory('read_messages', { project_id: projectId })).items.some(m => m.id === ephemeral.id), 18_000)
    await until('ephemeral message disappears', async () => Date.now() > Date.parse(expires) && !(await b.memory('read_messages', { project_id: projectId })).items.some(m => m.id === ephemeral.id), 30_000)
  })
  await step('UI downloads encrypted archive and exporter reopens without phrase', async () => {
    await a.page.goto(`${a.base}/#/settings`)
    const downloading = a.page.waitForEvent('download'); await a.page.getByRole('button', { name: 'Descargar respaldo cifrado' }).click()
    backupFile = join(state, 'project.hubproject'); await (await downloading).saveAs(backupFile)
    const raw = await readFile(backupFile, 'utf8'), archive = JSON.parse(raw)
    assert.ok(!raw.includes('Dato generado mientras')); assert.ok(!raw.includes(phrase))
    assert.equal((await a.admin('restore', { archive })).recovered_as_owner, false)
    await screenshot(a, 'sharing-settings.png')
  })
  let c, d
  await step('With zero peers, a new identity restores through UI as owner', async () => {
    for (const client of clients.splice(0)) await client.close()
    await a.stop(); await b.stop()
    c = await newHub('Carla recupera'); const archive = JSON.parse(await readFile(backupFile, 'utf8'))
    await c.admin('join', { invitation: originalInvitation }, 403)
    await c.admin('restore', { archive }, 403)
    const corrupted = globalThis.structuredClone(archive); corrupted.body.ciphertext = 'AAAA'
    await c.admin('restore', { archive: corrupted, phrase }, 422)
    await c.page.goto(`${c.base}/#/projects`); await c.page.getByRole('button', { name: 'Unirme a un proyecto' }).click()
    await c.page.getByRole('button', { name: 'Tengo un respaldo' }).click(); await c.page.getByLabel('Archivo cifrado del proyecto').setInputFiles(backupFile)
    await c.page.getByLabel('Frase de recuperación (si no sos el exportador)').fill(phrase)
    await c.page.getByRole('button', { name: 'Restaurar proyecto', exact: true }).click(); await c.page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal((await c.status()).members.find(m => m.identity.id === c.identity.id).role, 'owner')
    assert.equal((await c.admin('status')).network.connected_peers, 0)
    assert.ok((await entities(c, 'note')).items.some(e => e.title === 'Durante la caída'))
    assert.equal((await c.memory('list_tasks', { project_id: projectId })).total, 1)
    const messages = (await c.memory('read_messages', { project_id: projectId })).items
    assert.ok(messages.some(m => m.id === publicMessage.id)); assert.ok(!messages.some(m => m.id === privateMessage.id))
    await c.page.goto(`${c.base}/#/settings`)
    await c.page.getByRole('button', { name: 'Ver palabras de recuperación' }).click()
    await until('restored owner retains phrase', async () => await c.page.getByLabel('Frase de recuperación del proyecto', { exact: true }).inputValue() === phrase)
    await c.page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).first().click()
    await screenshot(c, 'restored-owner.png')
  })
  await step('Recovered single node revives the network and serves a new invited peer', async () => {
    d = await newHub('Diego nuevo'); await invite(c, d, 'reader')
    await d.admin('recovery_phrase', { project_id: projectId }, 403)
    await network(c, true); await network(d, true)
    await until('new peer gets complete restored publications', async () => (await d.status()).publications.length === (await c.status()).publications.length)
    assert.ok((await entities(d, 'note')).items.some(e => e.title === 'Durante la caída'))
    assert.equal((await d.memory('list_tasks', { project_id: projectId })).total, 1)
    assert.equal((await entities(d, 'collection')).total, 1)
    await projectPage(d); await d.page.getByRole('heading', { name: 'Participantes', exact: true }).scrollIntoViewIfNeeded(); await screenshot(d, 'revived-peer.png')
    assert.deepEqual(browserErrors, [])
  })
} catch (error) {
  failure = safe(error.stack ?? error.message)
  console.error(failure)
  for (const hub of hubs) if (hub.child && hub.child.exitCode === null && !hub.child.signalCode) { const status = await hub.admin('status').catch(() => null); console.error(hub.name, JSON.stringify(status?.network)) }
  for (const hub of hubs) if (hub.page && !hub.page.isClosed()) await screenshot(hub, `failure-${hub.name.replaceAll(' ', '-')}.png`).catch(() => {})
} finally {
  for (const client of clients) await client.close().catch(() => {})
  await browser?.close()
  for (const hub of hubs) { await hub.stop(); if (failure) await writeFile(join(output, `${hub.name.replaceAll(' ', '-')}.log`), safe(hub.logs)) }
  await bootstrap?.destroy()
  await rm(state, { recursive: true, force: true })
  const report = { started_at: startedAt, finished_at: new Date().toISOString(), status: failure ? 'failed' : 'passed',
    topology: 'Separate Node core/worker processes, separate SQLite/vaults, browser UI, HTTP MCP clients and real Noise sockets via loopback HyperDHT bootstrap',
    limits: ['All peers on one machine; external NAT/firewalls not exercised', 'MCP clients simulate agent tool calls; no model inference or paid provider'], checks, ...(failure ? { error: failure } : {}) }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(output, 'REPORT.md'), `# Shared projects E2E\n\n${report.status.toUpperCase()} · ${startedAt}\n\n${report.topology}\n\n${checks.map(c => `- ${c.status === 'passed' ? '[x]' : '[ ]'} ${c.name} (${(c.elapsed_ms / 1000).toFixed(1)} s)`).join('\n')}\n\nLimits: ${report.limits.join('; ')}.\n${failure ? '\n```\n' + failure + '\n```\n' : ''}`)
  console.log(`E2E ${report.status}: ${checks.filter(c => c.status === 'passed').length}/${checks.length} stages. Evidence: ${output}`)
  if (failure) process.exitCode = 1
}
