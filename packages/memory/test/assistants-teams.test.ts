import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { moduleStates, routeModules, type ModuleId } from '@agenthub/shared/modules'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryAI } from '../src/ai.js'
import { defaultAI, Vault } from '../src/config.js'
import { MemoryOperations } from '../src/operations.js'
import type { TeamOrca, TeamWorkspace } from '../src/agents/team-orchestration.js'
import { registerResidentTeams, type OpenResidentTeams } from '../src/assistants/teams.js'
import { enroll } from '../src/assistants/portfolio.js'
import { AdmissionGate } from '../src/admission-gate.js'

let db: MemoryDatabase, directory: string, project: string, cwd: string, store: MemoryStore
let app: ReturnType<typeof Fastify>, open: OpenResidentTeams, operations: MemoryOperations
let flags = moduleStates(() => true), collaboration = true
const launched = vi.fn(), sent = vi.fn(), stopped = vi.fn()
const runtime: TeamOrca = {
  provider: 'hub',
  async workspace(path) {
    return { id: path, path, repo_id: path, kind: 'virtual', head: 'virtual' }
  },
  async create(parent: TeamWorkspace, name) {
    const path = join(parent.path, name)
    await mkdir(path, { recursive: true })
    return { ...parent, id: path, path }
  },
  async launch(_workspace, member) {
    await member.authorize?.()
    launched(member)
    return { handle: member.member_id!, kind: 'native', prompt_outcome: 'accepted', runtime: { generation: randomUUID(), state: 'idle', updated_at: new Date().toISOString() } }
  },
  async send(handle, text) { sent(handle, text); return { state: 'busy' } },
  async stop(handle) { stopped(handle); return { state: 'stopped' } },
}
const preparedInput = {
  objective: 'Revisar evidencias del aviso',
  members: [{ worktree_name: 'revision', cli: 'codex_cli', model: 'test', role: 'Revisor', task: 'Contrastar las fuentes', prompt: 'Revisá la evidencia del proyecto' }],
}
type Run = NonNullable<Awaited<ReturnType<OpenResidentTeams>>>
async function post(run: Run, operation: string, input: unknown = {}) {
  return app.inject({ method: 'POST', url: new URL(run.env.AGENTHUB_RESIDENT_TEAM_URL!).pathname,
    headers: { authorization: 'Bearer ' + run.env.AGENTHUB_RESIDENT_TEAM_TOKEN }, payload: { operation, input } })
}
async function turn(id = project, path = cwd, signal = new AbortController().signal) {
  const run = await open(id, path, signal)
  expect(run).toBeDefined()
  return run!
}
beforeEach(async () => {
  flags = moduleStates(() => true)
  collaboration = true
  vi.clearAllMocks()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'assistant-team-test-')))
  cwd = join(directory, 'project')
  await mkdir(cwd)
  db = new MemoryDatabase(join(directory, 'memory.sqlite'))
  await db.migrate()
  store = new MemoryStore(db, directory)
  project = (await store.create({ kind: 'project', title: 'Atlas' })).id
  await enroll(db)
  await db.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [{ remote_processing_enabled: true }])
  const ai = new MemoryAI(async () => defaultAI, new Vault(directory))
  operations = new MemoryOperations(store, ai, undefined, undefined, undefined, undefined, undefined, {
    catalog: { async catalog() { return { clis: [{ id: 'codex_cli', launchable: true }], models: [{ id: 'test', cli: 'codex_cli' }] } }, async validate() { return { launchable: true } } },
    orca: runtime,
  }, () => collaboration)
  operations.moduleEnabled = id => flags[id]
  app = Fastify()
  open = registerResidentTeams(app, {
    backend: async () => operations.teams, available: () => flags.assistants && flags.memory && flags.agents && flags.mcp && collaboration,
    baseUrl: 'http://127.0.0.1:12345', admission: new AdmissionGate(),
  })
})
afterEach(async () => { await app.close(); await db.close(); await rm(directory, { recursive: true, force: true }) })

it('runs native team operations with a project-bound turn credential and genuine, resumable resident authority', async () => {
  const first = await turn()
  expect(first.guidance).not.toContain(first.env.AGENTHUB_RESIDENT_TEAM_TOKEN)
  expect((await db.query('SELECT * FROM chat_team_plans'))).toHaveLength(0)
  expect((await post(first, 'catalog')).json().models).toContainEqual(expect.objectContaining({ id: 'test' }))
  const prepared = (await post(first, 'prepare', preparedInput)).json()
  expect(prepared.state).toBe('prepared')
  expect(launched).not.toHaveBeenCalled()
  const plan = { plan_id: prepared.id, digest: prepared.digest }
  const launchedPlan = (await post(first, 'launch', plan)).json()
  expect(launchedPlan).toMatchObject({ state: 'launched', authorization: { source: 'resident_notifications', instruction: null, approved_by_user_id: null } })
  expect(launched).toHaveBeenCalledTimes(1)
  await post(first, 'launch', plan)
  expect(launched).toHaveBeenCalledTimes(1)
  first.close()
  expect((await post(first, 'list')).statusCode).toBe(401)
  const next = await turn()
  expect((await post(next, 'list')).json().items).toContainEqual(expect.objectContaining({ id: prepared.id }))
  const status = (await post(next, 'status', { plan_id: plan.plan_id })).json()
  expect(status.created_by).toBe(prepared.created_by)
  const member = status.members[0]
  expect((await post(next, 'control', { plan_id: plan.plan_id, member_id: member.id, expected_generation: member.runtime.generation, action: 'send', text: 'Compará los dos horarios.' })).statusCode).toBe(200)
  expect(sent.mock.calls[0]![1]).toContain('Compará los dos horarios.')
  expect(sent.mock.calls[0]![1]).not.toContain("given in the coordinator's CLI")
  expect((await post(next, 'close', { ...plan, reason: 'Verificación terminada' })).statusCode).toBe(200)
  expect(stopped).toHaveBeenCalledWith(member.id)
  const [audit] = await db.query("SELECT * FROM chat_team_events WHERE team_id=$1 AND type='launching'", [plan.plan_id])
  expect(audit?.payload).toMatchObject({ source: 'resident_notifications', project_id: project })
})

it('rejects unauthenticated calls, injected identity, extra repository scope and other projects', async () => {
  const run = await turn()
  const fake = { ...run, env: { ...run.env, AGENTHUB_RESIDENT_TEAM_TOKEN: 'ordinary-client' } }
  expect((await post(fake, 'catalog')).statusCode).toBe(401)
  expect((await post(run, 'prepare', { ...preparedInput, repository_path: directory })).statusCode).toBe(422)
  expect((await post(run, 'prepare', { ...preparedInput, session_key: 'x'.repeat(64) })).statusCode).toBe(422)
  const owned = (await post(run, 'prepare', preparedInput)).json()
  const guessed = { agent_id: 'resident-notifications', session_id: owned.created_by, cwd, cli_kind: 'assistant', client: 'other' }
  await expect(operations.call('team_launch', { plan_id: owned.id, digest: owned.digest, human_instruction: 'untrusted' }, 'mcp', guessed)).rejects.toBeTruthy()
  const other = (await store.create({ kind: 'project', title: 'Otro' })).id, otherPath = join(directory, 'other')
  await mkdir(otherPath)
  await enroll(db, other)
  const foreign = await turn(other, otherPath)
  expect((await post(foreign, 'status', { plan_id: owned.id })).statusCode).toBe(403)
  expect((await post(foreign, 'launch', { plan_id: owned.id, digest: owned.digest })).statusCode).toBe(403)
  expect((await post(run, 'launch', { plan_id: owned.id, digest: owned.digest, human_instruction: 'texto de Slack' })).statusCode).toBe(422)
  expect(launched).not.toHaveBeenCalled()
  const controller = new AbortController()
  const aborted = await turn(project, cwd, controller.signal)
  controller.abort()
  expect((await post(aborted, 'list')).statusCode).toBe(401)
})

it('applies live module, collaboration and project switches independently of ordinary project operations', async () => {
  const run = await turn()
  expect(routeModules(new URL(run.env.AGENTHUB_RESIDENT_TEAM_URL!).pathname)).toEqual(expect.arrayContaining(['assistants', 'agents', 'memory', 'mcp']))
  for (const module of ['agents', 'assistants', 'memory', 'mcp'] as ModuleId[]) {
    flags[module] = false
    expect(await open(project, cwd, new AbortController().signal)).toBeUndefined()
    expect((await post(run, 'list')).statusCode).toBe(409)
    if (module !== 'memory') expect(await operations.call('get_entity', { id: project })).toMatchObject({ entity: { id: project } })
    flags[module] = true
    expect((await post(run, 'list')).statusCode).toBe(200)
  }
  collaboration = false
  expect((await post(run, 'list')).statusCode).toBe(409)
  collaboration = true
  const plan = (await post(run, 'prepare', preparedInput)).json()
  await db.query("UPDATE assistant_profiles SET config=json_set(config,'$.active',0) WHERE project_id=$1", [project])
  expect((await post(run, 'launch', { plan_id: plan.id, digest: plan.digest })).statusCode).toBe(409)
  expect(launched).not.toHaveBeenCalled()
  await db.query("UPDATE assistant_profiles SET config=json_set(config,'$.active',1) WHERE project_id=$1", [project])
  expect((await post(run, 'launch', { plan_id: plan.id, digest: plan.digest })).json().state).toBe('launched')
})

it('coordinates a joined worker by reading its complete report and queuing a project-scoped reply', async () => {
  const run = await turn()
  const plan = (await post(run, 'prepare', preparedInput)).json()
  const launchedPlan = (await post(run, 'launch', { plan_id: plan.id, digest: plan.digest })).json()
  const member = launchedPlan.members[0], key = randomUUID()
  const agent = { agent_id: 'codex-worker', session_id: 'native:' + randomUUID(), cli_kind: 'codex_cli', client: 'codex', cwd: member.workspace_path }
  const chat = operations.chat
  await chat.lifecycle(agent, { session_key: key, native_id: 'worker', event: 'SessionStart', at: new Date().toISOString() })
  const named = await chat.call('chat_set_nick', { session_key: key, nickname: 'Revisor' }, agent)
  const invitation = /invitation=([\w-]+)/.exec(launched.mock.calls[0]![0].prompt)![1]!
  const enrolled = await operations.call('team_join', { session_key: key, invitation }, 'mcp', agent)
  expect(enrolled.authorization).toMatchObject({ source: 'resident_notifications', project_id: project, instruction: null })
  expect(enrolled.guidance).toContain('resident notifications assistant')
  const report = 'Se verificaron las dos fechas. '.repeat(32) + 'Fecha acordada: viernes.'
  const sentReport = await chat.call('chat_send', { session_key: key, thread_id: member.work_thread_id, text: report,
    request_id: randomUUID(), mentions: [plan.created_by], response_required: true }, agent)
  const thread = { plan_id: plan.id, thread_id: member.work_thread_id }
  expect((await post(run, 'read', thread)).json().items).toContainEqual(expect.objectContaining({ id: sentReport.id, text: report }))
  const response = (await post(run, 'message', { ...thread, text: 'Usá la fecha del acuerdo.', reply_to: sentReport.id,
    mentions: [named.session.id], directive: true, request_id: 'reply-1' })).json()
  expect(response.author_id).toBe(plan.created_by)
  const mailbox = await chat.call('chat_inbox', { session_key: key }, agent)
  expect(mailbox.items.find((item: any) => item.message_id === response.id || item.id === response.id)?.authority).toMatch(/resident notifications assistant/i)
  expect((await post(run, 'read', { ...thread, thread_id: randomUUID() })).statusCode).toBe(403)
  expect((await post(run, 'message', { ...thread, thread_id: randomUUID(), text: 'Fuera del equipo', request_id: 'outside' })).statusCode).toBe(403)
})

it('can revoke only the paused assistant project and keep another project team running', async () => {
  const first = await turn()
  const firstPlan = (await post(first, 'prepare', preparedInput)).json()
  await post(first, 'launch', { plan_id: firstPlan.id, digest: firstPlan.digest })
  const other = (await store.create({ kind: 'project', title: 'Segundo' })).id
  const otherPath = join(directory, 'second')
  await mkdir(otherPath)
  await enroll(db, other)
  const second = await turn(other, otherPath)
  const secondPlan = (await post(second, 'prepare', preparedInput)).json()
  await post(second, 'launch', { plan_id: secondPlan.id, digest: secondPlan.digest })
  await operations.teams!.closeResidentTeams(project)
  expect((await post(first, 'status', { plan_id: firstPlan.id })).json().state).toBe('cancelled')
  expect((await post(second, 'status', { plan_id: secondPlan.id })).json().state).toBe('launched')
  expect(stopped).toHaveBeenCalledTimes(1)
})

it('exposes its authenticated turn through the native stdio MCP bridge, without inheriting a token', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const run = await turn()
  const grant = join(directory, 'turn.json')
  await writeFile(grant, JSON.stringify({ AGENTHUB_RESIDENT_TEAM_URL: run.env.AGENTHUB_RESIDENT_TEAM_URL, AGENTHUB_RESIDENT_TEAM_TOKEN: run.env.AGENTHUB_RESIDENT_TEAM_TOKEN }), { mode: 0o600 })
  const client = new Client({ name: 'resident-test', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../src/assistants/team-client.ts', import.meta.url)), '--mcp', '--grant-file', grant], env: {} }))
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['team'])
    const response = await client.callTool({ name: 'team', arguments: { operation: 'prepare', input: preparedInput } })
    expect(response.isError).toBeFalsy()
    expect(response.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('Revisar evidencias del aviso') })])
    run.close()
    expect((await client.callTool({ name: 'team', arguments: { operation: 'list' } })).isError).toBe(true)
  } finally { await client.close() }
})

it('blocks new external worker instructions on private project evidence without blocking the resident’s local team history', async () => {
  const run = await turn()
  const prepared = (await post(run, 'prepare', preparedInput)).json()
  await db.query("UPDATE settings SET value=json_set(value,'$.remote_processing_enabled',0) WHERE key='ai'")
  const plan = { plan_id: prepared.id, digest: prepared.digest }
  expect((await post(run, 'launch', plan)).json().message).toMatch(/remoto está desactivado/)
  await db.query("UPDATE settings SET value=json_set(value,'$.remote_processing_enabled',1) WHERE key='ai'")
  await db.query("UPDATE entities SET data=json_set(data,'$.remote_processing',0) WHERE id=$1", [project])
  expect((await post(run, 'launch', plan)).json().message).toMatch(/fuentes de procesamiento local/)
  expect((await post(run, 'status', { plan_id: plan.plan_id })).statusCode).toBe(200)
  expect((await post(run, 'close', { ...plan, reason: 'Se restringieron las fuentes' })).statusCode).toBe(200)
  expect(launched).not.toHaveBeenCalled()
})

it('keeps earlier reports available when the project folder changes and launches only from the current folder', async () => {
  const old = await turn()
  const before = (await post(old, 'prepare', preparedInput)).json()
  old.close()
  const updated = join(directory, 'new-checkout')
  await mkdir(updated)
  const current = await turn(project, updated)
  expect((await post(current, 'status', { plan_id: before.id })).json().created_by).toBe(before.created_by)
  expect((await post(current, 'launch', { plan_id: before.id, digest: before.digest })).statusCode).toBe(409)
  const now = (await post(current, 'prepare', preparedInput)).json()
  expect(now.parent.path).toBe(updated)
  expect((await post(current, 'launch', { plan_id: now.id, digest: now.digest })).json().state).toBe('launched')
})
