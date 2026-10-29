import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { createEffectToolResolver } from '../src/effects/tools.js'
import { createJiraGuard } from '../src/effects/jira-guard.js'
import { JIRA_SERVER_SETTING, readJiraServerId } from '../src/effects/jira-server.js'
import type { ConnectionPool } from '@agenthub/gateway'

let db: Database, store: Store, ownerId: string
const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', headers: {}, secret_refs: {}, requires_host_access: false,
  container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [], auth: 'none' as const, url: 'https://mcp.atlassian.com/v1/mcp' }
const TOOLS = ['atlassianUserInfo', 'getAccessibleAtlassianResources', 'getJiraIssue']
const SITE = 'https://example.atlassian.net'
const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5'

function server(slug: string, tools = TOOLS) {
  const row = store.insertServer({ ...base, user_id: ownerId, slug, display_name: slug })
  for (const name of tools) store.insertTool({ server_id: row.id, name, title: name, exposed_name: `${slug}_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: `${slug}-${name}` })
  return row
}

type Answer = (tool: string, args: Record<string, unknown>) => unknown
const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = []
let answer: Answer
const callTool = vi.fn(async (_agent: string, spec: { id: string }, tool: string, args: Record<string, unknown>) => {
  calls.push({ server: spec.id, tool, args })
  const value = answer(tool, args)
  if (value instanceof Error) throw value
  return value
})
const ok = (structured: Record<string, unknown>) => ({ is_error: false, content: [], structured_content: structured })
const guard = () => createJiraGuard({ serverId: () => readJiraServerId(store, ownerId), tools: id => createEffectToolResolver(store, { callTool } as unknown as ConnectionPool, ownerId).forServer(id) })
const jiraAnswers = (issue: Record<string, unknown>): Answer => tool => tool === 'atlassianUserInfo' ? ok({ account_id: ACCOUNT })
  : tool === 'getAccessibleAtlassianResources' ? { is_error: false, content: [{ type: 'text', text: JSON.stringify([{ url: SITE, scopes: ['read:jira-work'] }]) }] }
  : ok(issue)

beforeEach(() => {
  calls.length = 0; callTool.mockClear(); answer = () => ok({})
  db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
  store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
})
afterEach(() => db.close())

it('sin servidor de Jira fijado no verifica nada ni llama a ninguna herramienta', async () => {
  server('atlassian_rovo')
  expect(await guard().ownerAccountId()).toBeNull()
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: false })
  expect(calls).toEqual([])
})

it('la cuenta del dueño sale de atlassianUserInfo por el servidor fijado y no de otro', async () => {
  const first = server('atlassian_rovo'), second = server('atlassian_rovo_2')
  store.setSetting(JIRA_SERVER_SETTING, second.id)
  answer = jiraAnswers({})
  expect(await guard().ownerAccountId()).toBe(ACCOUNT)
  expect(calls).toEqual([{ server: second.id, tool: 'atlassianUserInfo', args: {} }])
  expect(calls.some(call => call.server === first.id)).toBe(false)
})

it('el asignado sale de getJiraIssue sobre el único sitio de Jira y con solo el campo assignee', async () => {
  const jira = server('atlassian_rovo')
  store.setSetting(JIRA_SERVER_SETTING, jira.id)
  answer = jiraAnswers({ key: 'ABC-1', fields: { assignee: { accountId: ACCOUNT, displayName: 'Persona' } } })
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: ACCOUNT, verified: true })
  expect(calls.map(call => call.tool)).toEqual(['getAccessibleAtlassianResources', 'getJiraIssue'])
  expect(calls[1]!.args).toMatchObject({ cloudId: SITE, issueIdOrKey: 'ABC-1', fields: ['assignee'] })
  expect(new Set(calls.map(call => call.server))).toEqual(new Set([jira.id]))
})

it('un ticket sin asignar es una lectura verificada sin cuenta', async () => {
  store.setSetting(JIRA_SERVER_SETTING, server('atlassian_rovo').id)
  answer = jiraAnswers({ key: 'ABC-1', fields: { assignee: null } })
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: true })
})

it.each([
  ['otra clave en la respuesta', { key: 'ABC-2', fields: { assignee: { accountId: ACCOUNT } } }],
  ['sin el campo assignee', { key: 'ABC-1', fields: {} }],
  ['cuenta con caracteres inválidos', { key: 'ABC-1', fields: { assignee: { accountId: 'a b;c' } } }],
  ['cuenta que no es texto', { key: 'ABC-1', fields: { assignee: { accountId: 42 } } }],
])('%s: sin verificar', async (_name, issue) => {
  store.setSetting(JIRA_SERVER_SETTING, server('atlassian_rovo').id)
  answer = jiraAnswers(issue)
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: false })
})

it('una clave con forma inválida no sale a la red', async () => {
  store.setSetting(JIRA_SERVER_SETTING, server('atlassian_rovo').id)
  for (const key of ['abc-1', 'ABC-1; DROP', '', 'ABC']) expect(await guard().assigneeOf(key)).toEqual({ account_id: null, verified: false })
  expect(calls).toEqual([])
})

it('errores del servidor, excepciones de red y cuentas inválidas dan null o sin verificar, nunca un valor por defecto', async () => {
  store.setSetting(JIRA_SERVER_SETTING, server('atlassian_rovo').id)
  answer = () => ({ is_error: true, content: [{ type: 'text', text: 'boom' }] })
  expect(await guard().ownerAccountId()).toBeNull()
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: false })
  answer = () => new Error('ECONNRESET')
  expect(await guard().ownerAccountId()).toBeNull()
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: false })
  answer = () => ok({ account_id: 'no válida!' })
  expect(await guard().ownerAccountId()).toBeNull()
  answer = () => ok({})
  expect(await guard().ownerAccountId()).toBeNull()
})

it('con dos sitios de Jira accesibles no adivina: sin verificar', async () => {
  store.setSetting(JIRA_SERVER_SETTING, server('atlassian_rovo').id)
  answer = tool => tool === 'getAccessibleAtlassianResources'
    ? { is_error: false, content: [{ type: 'text', text: JSON.stringify([{ url: SITE, scopes: ['read:jira-work'] }, { url: 'https://otro.atlassian.net', scopes: ['read:jira-work'] }]) }] }
    : ok({ key: 'ABC-1', fields: { assignee: { accountId: ACCOUNT } } })
  expect(await guard().assigneeOf('ABC-1')).toEqual({ account_id: null, verified: false })
  expect(calls.map(call => call.tool)).toEqual(['getAccessibleAtlassianResources'])
})

it('una herramienta apagada en el servidor fijado no se atiende desde otro servidor y queda una fila deny', async () => {
  const pinned = server('atlassian_rovo', ['getAccessibleAtlassianResources', 'getJiraIssue'])
  server('atlassian_rovo_2')
  store.setSetting(JIRA_SERVER_SETTING, pinned.id)
  answer = jiraAnswers({})
  expect(await guard().ownerAccountId()).toBeNull()
  expect(calls).toEqual([])
  const rows = store.toolCalls({ orgId: store.user(ownerId)!.organization_id, limit: 10 })
  expect(rows[0]).toMatchObject({ decision: 'deny', denial_reason: 'tool_off', tool_name: 'atlassianUserInfo', principal: 'hub_effects' })
})

it('relee el setting en cada llamada: un cambio de servidor se ve sin crear otro guard', async () => {
  const first = server('atlassian_rovo'), second = server('atlassian_rovo_2')
  const shared = guard()
  answer = jiraAnswers({})
  store.setSetting(JIRA_SERVER_SETTING, first.id)
  await shared.ownerAccountId()
  store.setSetting(JIRA_SERVER_SETTING, second.id)
  await shared.ownerAccountId()
  store.setSetting(JIRA_SERVER_SETTING, 'ya-no-existe')
  expect(await shared.ownerAccountId()).toBeNull()
  expect(calls.map(call => call.server)).toEqual([first.id, second.id])
})
