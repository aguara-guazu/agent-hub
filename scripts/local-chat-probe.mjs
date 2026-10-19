/** Isolated transport experiment. Does not alter Agent Hub or global CLI settings. */
/* global fetch, AbortSignal */
import { Buffer } from 'node:buffer'
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers'
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const [mode, rootArg, client, binding, eventOverride] = process.argv.slice(2)
const root = resolve(rootArg || '/tmp/agenthub-local-chat-poc')
const configPath = join(root, 'connection.json')
const log = (event, data = {}) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n')
async function request(path, body) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  const response = await fetch(`${cfg.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ client, binding, ...body }), signal: AbortSignal.timeout(path === '/wait' ? 295_000 : 15_000),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return response.json()
}
async function stdinJson() { let text = ''; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text || '{}') }

if (mode === 'setup') {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const script = fileURLToPath(import.meta.url)
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`
  for (const kind of ['codex', 'claude']) {
    const key = randomUUID()
    const command = event => [process.execPath, script, 'hook', root, kind, key, event].map(quote).join(' ')
    const mcp = { command: process.execPath, args: [script, 'mcp', root, kind, key] }
    const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'].map(event =>
      [event, [{ hooks: [{ type: 'command', command: command(event), timeout: 10 }] }]]))
    const prompt = 'Authorized isolated Agent Hub collaboration probe. Call lab identity, state your assigned identity, then finish this turn and wait. Do not send messages yet. Future local probe notifications are authorized within this fixture: read lab inbox, handle the request, and reply via lab send. Never poll or start background work yourself.'
    let args
    if (kind === 'claude') {
      hooks.Stop[0].hooks.push({ type: 'command', command: command('Watch'), asyncRewake: true, timeout: 290 })
      writeFileSync(join(root, 'claude-settings.json'), JSON.stringify({ hooks }, null, 2), { mode: 0o600 })
      writeFileSync(join(root, 'claude-mcp.json'), JSON.stringify({ mcpServers: { lab: mcp } }, null, 2), { mode: 0o600 })
      args = ['claude', '--setting-sources', '', '--settings', join(root, 'claude-settings.json'), '--strict-mcp-config', '--mcp-config', join(root, 'claude-mcp.json'),
        '--tools', '', '--allowedTools', 'mcp__lab__*', '--permission-mode', 'dontAsk', '--no-chrome', '--disable-slash-commands', '--name', 'Agent Hub isolated chat probe', prompt]
    } else {
      args = ['codex', '--no-alt-screen', '--dangerously-bypass-hook-trust', '-C', root, '-s', 'read-only', '-c', 'approval_policy="never"',
        '-c', 'mcp_servers.hub.enabled=false', '-c', `mcp_servers.lab.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.lab.args=${JSON.stringify(mcp.args)}`,
        '-c', 'mcp_servers.lab.default_tools_approval_mode="approve"', '-c', `developer_instructions=${JSON.stringify('Authorized isolated collaboration probe. Use ONLY lab MCP tools; no real Hub, skills, shell, or unrelated files. Review the fixture when requested and reply via lab send to the exact peer identity. Finish after handling requests; never poll. Limit: 8 messages per session.')}`]
      for (const [event, groups] of Object.entries(hooks)) args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(groups[0].hooks[0].command)},timeout=10}]}]`)
      args.push(prompt)
    }
    writeFileSync(join(root, `${kind}-launch.sh`), `#!/bin/sh\ncd ${quote(root)}\nexec ${args.map(quote).join(' ')}\n`, { mode: 0o700 })
  }
  console.log(`Isolated launchers written to ${root}. Start the broker, then run each launcher in a terminal.`)
} else if (mode === 'broker') {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const token = randomUUID(), sessions = new Map(), messages = [], waits = new Map(), queueLocks = new Set()
  let fixture = 'export function add(a, b) { return a - b; }\n', revision = 0
  writeFileSync(join(root, 'add.mjs'), fixture)
  const view = s => ({ ...s, online: s.status !== 'closed' && s.lastSeen > Date.now() - 20_000 })
  function session(input) {
    const s = sessions.get(input.binding)
    if (!s || s.client !== input.client) throw new Error('Unregistered session')
    s.lastSeen = Date.now()
    return s
  }
  async function deliver(s) {
    const pending = messages.filter(m => m.to === s.id && !m.readAt)
    if (!pending.length) return
    const waiter = waits.get(s.id)
    if (waiter) { waits.delete(s.id); waiter({ pending: pending.map(m => m.id) }); return }
    if (s.client !== 'codex' || queueLocks.has(s.id) || s.status !== 'idle') return
    const undelivered = pending.filter(m => !m.notifiedAt)
    if (!undelivered.length) return
    queueLocks.add(s.id)
    const text = `Local collaboration probe: pending messages for ${s.id}. Call the lab inbox tool now, handle the request in this isolated fixture, and reply through lab send. Message IDs: ${undelivered.map(m => m.id).join(', ')}.`
    const child = spawn('codex', ['queue', '--thread', s.nativeId, '--message', text], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    child.on('error', error => { queueLocks.delete(s.id); log('queue_error', { id: s.id, error: error.message }) })
    child.on('close', code => {
      queueLocks.delete(s.id)
      log('queue_result', { id: s.id, nativeId: s.nativeId, code, output: output.slice(-2000) })
      if (code === 0) for (const m of undelivered) m.notifiedAt = Date.now()
    })
  }
  const server = createServer(async (req, res) => {
    const reply = (data, status = 200) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) } }
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply({ error: 'unauthorized' }, 401)
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 50_000) throw new Error('request too large') }
      const input = JSON.parse(raw || '{}')
      if (req.url === '/register') {
        if (!input.nativeId || !input.binding || !['codex', 'claude'].includes(input.client)) throw new Error('invalid registration')
        let s = sessions.get(input.binding)
        if (s && s.nativeId !== input.nativeId) throw new Error('binding already belongs to another session')
        if (!s) {
          s = { id: `${input.client}-${randomUUID().slice(0, 6)}`, client: input.client, nativeId: input.nativeId, cwd: input.cwd, status: 'starting', lastSeen: Date.now() }
          sessions.set(input.binding, s); log('registered', s)
        }
        s.lastSeen = Date.now()
        if (s.status === 'closed') s.status = 'starting'
        return reply(view(s))
      }
      if (req.url === '/status') return reply({ sessions: [...sessions.values()].map(view), messages, revision, fixture })
      if (req.url === '/seed') {
        const s = [...sessions.values()].find(s => s.id === input.to || s.client === input.to)
        if (!s) throw new Error('recipient missing')
        const m = { id: randomUUID(), from: 'probe-controller', to: s.id, text: input.text, createdAt: Date.now() }
        messages.push(m); log('sent', m); reply(m); void deliver(s); return
      }
      const s = session(input)
      if (req.url === '/lifecycle') {
        const status = ({ UserPromptSubmit: 'busy', PreToolUse: 'busy', Stop: 'idle', SessionEnd: 'closed' })[input.event]
        if (status) s.status = status
        log('lifecycle', { id: s.id, nativeId: s.nativeId, hook: input.event, status: s.status })
        reply({ ok: true }); if (s.status === 'idle') void deliver(s); return
      }
      if (req.url === '/heartbeat') return reply({ ok: true })
      if (req.url === '/wait') {
        log('waiting', { id: s.id })
        const old = waits.get(s.id); if (old) old({ replaced: true })
        const done = data => { clearTimeout(timer); reply(data) }
        const timer = setTimeout(() => { if (waits.get(s.id) === done) waits.delete(s.id); done({ timeout: true }) }, 280_000)
        waits.set(s.id, done)
        res.on('close', () => { clearTimeout(timer); if (waits.get(s.id) === done) waits.delete(s.id) })
        void deliver(s); return
      }
      if (req.url === '/tool') {
        const args = input.args || {}
        log('tool', { id: s.id, tool: input.name, args })
        if (input.name === 'identity') return reply({ self: view(s), peers: [...sessions.values()].filter(p => p.id !== s.id).map(view) })
        if (input.name === 'inbox') {
          const items = messages.filter(m => m.to === s.id && !m.readAt)
          for (const m of items) m.readAt = Date.now()
          log('read', { id: s.id, messages: items.map(m => m.id) }); return reply({ items })
        }
        if (input.name === 'send') {
          const recipient = [...sessions.values()].find(p => p.id === args.to)
          if (!recipient || recipient.id === s.id || typeof args.text !== 'string' || args.text.length > 8000) throw new Error('invalid message')
          if (messages.length >= 16) throw new Error('probe message budget exhausted')
          const m = { id: randomUUID(), from: s.id, to: recipient.id, text: args.text, createdAt: Date.now() }
          messages.push(m); log('sent', m); reply(m); void deliver(recipient); return
        }
        if (input.name === 'fixture_read') return reply({ revision, path: join(root, 'add.mjs'), code: fixture, specification: 'add(a,b) returns the numeric sum. add(2,3) must equal 5; add(-1,1) must equal 0.' })
        if (input.name === 'fixture_write') {
          if (s.client !== 'claude' || args.expected_revision !== revision || typeof args.code !== 'string' || args.code.length > 2000) throw new Error('invalid fixture revision')
          fixture = args.code; revision++; writeFileSync(join(root, 'add.mjs'), fixture)
          log('fixture_written', { id: s.id, revision, code: fixture }); return reply({ revision })
        }
        throw new Error('unknown tool')
      }
      throw new Error('unknown endpoint')
    } catch (e) { reply({ error: e.message }, 400) }
  })
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(configPath, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600 })
    console.log(`Probe broker ready: ${root}`)
  })
} else if (mode === 'hook') {
  const event = await stdinJson(), name = eventOverride || event.hook_event_name
  if (name === 'SessionStart') {
    const s = await request('/register', { nativeId: event.session_id, cwd: event.cwd })
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Isolated Agent Hub chat probe. Your auto-assigned identity is ${s.id}. Use only the lab MCP tools for this probe. identity discovers peers, inbox reads messages, send replies. Never access the real Hub or unrelated files. After a message is handled, finish your turn; do not poll or start background work yourself.` } }))
  } else if (name === 'Watch') {
    const result = await request('/wait', {})
    if (result.pending?.length) {
      console.error(`Agent Hub local probe: you have pending messages. Call lab inbox now, handle the requested fixture work, and reply using lab send. IDs: ${result.pending.join(', ')}.`)
      process.exitCode = 2
    }
  } else await request('/lifecycle', { event: name })
} else if (mode === 'mcp') {
  const mcp = new Server({ name: 'lab', version: '0.0.1' }, { capabilities: { tools: {} } })
  const object = properties => ({ type: 'object', properties, additionalProperties: false })
  const definitions = [
    { name: 'identity', description: 'Get your automatically registered identity and peers in the isolated probe.', inputSchema: object({}) },
    { name: 'inbox', description: 'Read and acknowledge pending messages addressed to this session.', inputSchema: object({}) },
    { name: 'send', description: 'Send a message to a peer identity in the isolated local probe.', inputSchema: { ...object({ to: { type: 'string' }, text: { type: 'string' } }), required: ['to', 'text'] } },
    { name: 'fixture_read', description: 'Read the isolated add function, specification and revision for code review.', inputSchema: object({}) },
    { name: 'fixture_write', description: 'Claude only: replace the isolated add function after review, requiring its current revision.', inputSchema: { ...object({ code: { type: 'string' }, expected_revision: { type: 'integer' } }), required: ['code', 'expected_revision'] } },
  ]
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await request('/tool', { name: req.params.name, args: req.params.arguments })) }] } }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] } }
  })
  const heartbeat = setInterval(() => request('/heartbeat', {}).catch(() => {}), 5000)
  heartbeat.unref()
  mcp.onclose = () => { clearInterval(heartbeat); process.exit(0) }
  await mcp.connect(new StdioServerTransport())
} else if (mode === 'status') console.log(JSON.stringify(await request('/status', {}), null, 2))
else if (mode === 'seed') console.log(JSON.stringify(await request('/seed', { to: client, text: binding })))
else throw new Error('Usage: local-chat-probe.mjs setup|broker|hook|mcp|status|seed ROOT [CLIENT BINDING EVENT]')
