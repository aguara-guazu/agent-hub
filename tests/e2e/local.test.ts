import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const CORE = join(ROOT, 'packages/core/dist/server.js')
const DAEMON = join(ROOT, 'packages/daemon/dist/cli.js')
import { DaemonApp, loadConfig } from '@agenthub/daemon'
const children: ChildProcess[] = []
const roots: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  await new Promise((resolveDone) => setTimeout(resolveDone, 50))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveDone) => server.listen(0, '127.0.0.1', resolveDone))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolveDone) => server.close(() => resolveDone()))
  return port
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* todavía arrancando */ }
    await new Promise((resolveDone) => setTimeout(resolveDone, 50))
  }
  throw new Error(`timeout esperando ${url}`)
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  let output = ''
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
  child.stderr?.on('data', (chunk) => { output += String(chunk) })
  const code = await new Promise<number | null>((resolveDone) => child.once('exit', resolveDone))
  return { code, output }
}

describe('hub local TypeScript completo', () => {
  it('crea sesión Electron, auto-enrola el daemon y sirve el gateway stdio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenthub-e2e-'))
    roots.push(root)
    const home = join(root, 'home')
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const bootstrap = 'bootstrap-e2e-' + 'x'.repeat(32)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTHUB_HUB_HOST: '127.0.0.1',
      AGENTHUB_HUB_PORT: String(port),
      AGENTHUB_LOCAL_MODE: '1',
      // La prueba cuenta servers; el catálogo inicial de fábrica se prueba aparte.
      AGENTHUB_STARTER_CATALOG: '0',
      AGENTHUB_DATABASE_PATH: join(state, 'hub.db'),
      AGENTHUB_JWT_SECRET: 'jwt-e2e-' + 'y'.repeat(32),
      AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: bootstrap,
    }
    const core = run(process.execPath, [CORE], env)
    await waitFor(`${base}/health`)

    const rejected = await fetch(`${base}/api/auth/desktop-session`, {
      method: 'POST', headers: { Authorization: 'Bearer equivocado' },
    })
    expect(rejected.status).toBe(401)
    const session = await fetch(`${base}/api/auth/desktop-session`, {
      method: 'POST', headers: { Authorization: `Bearer ${bootstrap}` },
    })
    expect(session.status).toBe(200)
    const token = (await session.json() as { access_token: string }).access_token
    expect(token.split('.')).toHaveLength(3)
    const api = async (route: string, method = 'GET', payload?: unknown): Promise<any> => {
      const response = await fetch(base + '/api' + route, {method, headers: {Authorization: `Bearer ${token}`, ...(payload ? {'Content-Type':'application/json'} : {})}, ...(payload ? {body: JSON.stringify(payload)} : {})})
      expect(response.ok, method + ' ' + route).toBe(true)
      return response.status === 204 ? null : response.json()
    }

    const daemon = run(process.execPath, [DAEMON, 'run', '--local', '--home', home, '--state-dir', state, '--max-cycles', '1'], {
      ...env,
      AGENTHUBD_LOCAL: '1',
      AGENTHUBD_URL: base,
      AGENTHUBD_HOME_DIR: home,
      AGENTHUBD_STATE_DIR: state,
    })
    const result = await exitOf(daemon)
    expect(result.code, result.output).toBe(0)
    expect(existsSync(join(state, 'credentials.json'))).toBe(true)

    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
    }
    expect(Object.keys(config.mcpServers)).toEqual(['hub'])
    expect(config.mcpServers.hub?.args).toContain('gateway')
    const agentsPayload = JSON.parse(readFileSync(join(state, 'agents.json'), 'utf8')) as { agents: Array<{ id: string }> }
    const agents = agentsPayload.agents
    expect(agents).toHaveLength(1)

    const transport = new StdioClientTransport({
      command: config.mcpServers.hub!.command,
      args: config.mcpServers.hub!.args,
      env: { ...getDefaultEnvironment(), ...(config.mcpServers.hub!.env ?? {}) },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'e2e', version: '1.0.0' })
    await client.connect(transport)
    expect((await client.listTools()).tools).toEqual([])
    const synchronizer = new DaemonApp(loadConfig({home, stateDir:state, controlPlaneUrl:base, local:true}), {maxAttempts:1})
    const server = await api('/catalog/servers', 'POST', {slug:'notes', display_name:'Notes', transport:'stdio', command:process.execPath, args:[join(ROOT,'testdata/dist/mcp_servers/notesServer.js')], requires_host_access:true})
    const probe = await api(`/catalog/servers/${server.id}/probe`, 'POST')
    expect(probe.last_probe_error).toBe('')
    expect(probe.tools).toHaveLength(2)
    await synchronizer.syncOnce({apply:true})
    expect((await client.listTools()).tools).toHaveLength(2)
    const name = (await client.listTools()).tools.find(t=>t.name.endsWith('list_notes'))!.name
    expect((await client.callTool({name, arguments:{}})).isError).not.toBe(true)
    const skill = await api('/catalog/skills','POST',{slug:'e2e-skill', display_name:'E2E', description:'Disposable local test', body:'Read only.'})
    await synchronizer.syncOnce({apply:true})
    // Repeated atomic snapshot writes must not detach policy updates from a live session.
    for (const state of ['off','on','off','on']) {
      await api('/policy/rules','PUT',{scope:'user',resource_type:'mcp_server',resource_id:server.id,state,reset_clients:true})
      // Deliberately do not run the daemon: a saved OFF already governs new calls.
      expect((await client.listTools()).tools).toHaveLength(state==='on'?2:0)
      expect(Boolean((await client.callTool({name,arguments:{}})).isError)).toBe(state==='off')
      await synchronizer.syncOnce({apply:true})
    }
    await api(`/machines/agents/${agents[0]!.id}`,'PATCH',{enabled:false})
    expect((await client.listTools()).tools).toHaveLength(0)
    expect((await client.callTool({name,arguments:{}})).isError).toBe(true)
    await synchronizer.syncOnce({apply:true})
    expect(existsSync(join(home,'.claude/skills/e2e-skill/SKILL.md'))).toBe(false)
    await api(`/machines/agents/${agents[0]!.id}`,'PATCH',{enabled:true})
    // Detect clients installed after enrolment and distribute the same catalogue.
    for (const directory of ['.codex','.gemini','.kiro']) mkdirSync(join(home,directory),{recursive:true})
    await synchronizer.syncOnce({apply:true})
    const overview = await api('/local/overview')
    expect(overview.clients).toHaveLength(4)
    expect(overview.clients.every((c:any)=>c.synchronized && c.server_count===1 && c.skill_count===1)).toBe(true)
    const codex = overview.clients.find((c:any)=>c.cli_kind==='codex_cli')
    await api('/policy/rules','PUT',{scope:'client',scope_id:codex.id,resource_type:'skill',resource_id:skill.id,state:'off'})
    await synchronizer.syncOnce({apply:true})
    expect(existsSync(join(home,'.codex/skills/e2e-skill/SKILL.md'))).toBe(false)
    expect(existsSync(join(home,'.gemini/skills/e2e-skill/SKILL.md'))).toBe(true)
    expect(existsSync(join(home,'.claude/skills/e2e-skill/SKILL.md'))).toBe(true)
    // Global control explicitly clears existing per-client overrides.
    await api('/policy/rules','PUT',{scope:'client',scope_id:agents[0]!.id,resource_type:'mcp_server',resource_id:server.id,state:'on'})
    await api('/policy/rules','PUT',{scope:'user',resource_type:'mcp_server',resource_id:server.id,state:'off',reset_clients:true})
    expect((await client.listTools()).tools).toHaveLength(0)
    const logs = await api('/audit/tool-calls')
    expect(logs.some((l:any)=>l.decision==='allow')).toBe(true)
    expect(logs.some((l:any)=>l.decision==='deny')).toBe(true)
    await client.close()

    core.kill('SIGTERM')
  }, 30_000)
})
