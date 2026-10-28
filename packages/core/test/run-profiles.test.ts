import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { computeSnapshot } from '../src/policy/resolver.js'
import { MEMORY_CATALOG_SERVER_SETTING } from '../src/catalog/reconcile.js'
import { ensureRunProfileAgent } from '../src/effects/identities.js'
import { isRunProfileAgent, profileAllowsTool } from '@agenthub/shared'

let dir: string
let db: Database
let store: Store

const base = { description: '', transport: 'stdio' as const, command: 'node', args: [], env: {}, cwd: '', url: '', headers: {}, secret_refs: {}, requires_host_access: false,
  container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] }

function seed() {
  const org = store.insertOrganization('craftech', 'Craftech')
  const user = store.insertUser({ organization_id: org.id, email: 'dev@craftech.io', full_name: 'Dev', password_hash: '!', org_role: 'owner' })
  const machine = store.insertMachine({ user_id: user.id, hostname: 'laptop', os: 'macos', daemon_version: '0.2.0' })
  const memory = store.insertServer({ ...base, user_id: user.id, slug: 'memory', display_name: 'Memory' })
  const atlassian = store.insertServer({ ...base, user_id: user.id, slug: 'atlassian', display_name: 'Atlassian' })
  store.setSetting(MEMORY_CATALOG_SERVER_SETTING, memory.id)
  const tool = (server: string, name: string) => store.insertTool({ server_id: server, name, exposed_name: `${server.slice(0, 4)}_${name}`, title: '', description: '', input_schema: {}, definition_hash: `h-${name}` })
  for (const name of ['search', 'context', 'remember', 'schedule_create', 'schedule_list', 'chat_send', 'create_entity', 'write_note', 'team_launch', 'run_report', 'new_unknown_tool']) tool(memory.id, name)
  for (const name of ['getJiraIssue', 'addWorklogToJiraIssue', 'deleteEverything', 'slack_send_message', 'createJiraIssue']) tool(atlassian.id, name)
  return { user, machine, memory, atlassian }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-prof-'))
  db = new Database(join(dir, 'agenthub.db'))
  runMigrations(db, join(dir, 'agenthub.db'))
  store = new Store(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const exposed = (agentId: string) => computeSnapshot(store, agentId).servers.flatMap(server => server.tools.map(tool => `${server.slug}/${tool.name}`)).sort()

describe('perfiles de run', () => {
  it('el perfil action solo conserva lecturas de memoria y el canal de reporte', () => {
    const { user } = seed()
    const agent = ensureRunProfileAgent(store, user.id, 'hub_run_action')!
    expect(exposed(agent.id)).toEqual(['memory/context', 'memory/run_report', 'memory/search'])
  })
  it('no hay schedule_*, escrituras ni chat/team para el perfil, y las herramientas nuevas se deniegan', () => {
    const { user } = seed()
    const agent = ensureRunProfileAgent(store, user.id, 'hub_run_action')!
    const names = exposed(agent.id).join(' ')
    for (const banned of ['schedule_create', 'schedule_list', 'remember', 'create_entity', 'write_note', 'chat_send', 'team_launch', 'new_unknown_tool', 'atlassian']) expect(names).not.toContain(banned)
  })
  it('una regla ON del dueño o del cliente no devuelve una herramienta fuera de la cota', () => {
    const { user, memory } = seed()
    const agent = ensureRunProfileAgent(store, user.id, 'hub_run_action')!
    const remember = store.toolsOfServer(memory.id).find(tool => tool.name === 'remember')!
    store.insertRule({ user_id: user.id, agent_instance_id: null, resource_type: 'mcp_tool', resource_id: remember.id, state: 'on', reason: 'persona' })
    store.insertRule({ user_id: user.id, agent_instance_id: agent.id, resource_type: 'mcp_tool', resource_id: remember.id, state: 'on', reason: 'cliente' })
    expect(exposed(agent.id)).not.toContain('memory/remember')
    const snapshot = computeSnapshot(store, agent.id)
    expect(snapshot.denied.find(entry => entry.slug === 'memory/remember')?.source).toBe('run_profile')
  })
  it('una regla OFF del dueño sigue apagando lo que el perfil sí permitiría', () => {
    const { user, memory } = seed()
    const agent = ensureRunProfileAgent(store, user.id, 'hub_run_action')!
    const search = store.toolsOfServer(memory.id).find(tool => tool.name === 'search')!
    store.insertRule({ user_id: user.id, agent_instance_id: null, resource_type: 'mcp_tool', resource_id: search.id, state: 'off', reason: 'persona' })
    expect(exposed(agent.id)).toEqual(['memory/context', 'memory/run_report'])
  })
  it('hub_effects no tiene memoria y solo ve las escrituras y lecturas exactas del ejecutor', () => {
    const { user } = seed()
    const agent = ensureRunProfileAgent(store, user.id, 'hub_effects')!
    expect(exposed(agent.id)).toEqual(['atlassian/addWorklogToJiraIssue', 'atlassian/getJiraIssue', 'atlassian/slack_send_message'])
  })
  it('ningún perfil recibe skills', () => {
    const { user } = seed()
    for (const kind of ['hub_run_action', 'hub_effects'] as const) expect(computeSnapshot(store, ensureRunProfileAgent(store, user.id, kind)!.id).skills).toEqual([])
  })
  it('la identidad se crea una sola vez y no aparece en los listados de clientes', () => {
    const { user, machine } = seed()
    const first = ensureRunProfileAgent(store, user.id, 'hub_effects')!, second = ensureRunProfileAgent(store, user.id, 'hub_effects')!
    expect(second.id).toBe(first.id)
    ensureRunProfileAgent(store, user.id, 'hub_run_action')
    expect(isRunProfileAgent(first)).toBe(true)
    expect(store.agentsOfUser(user.id)).toEqual([])
    expect(store.agentsOfMachine(machine.id)).toEqual([])
    expect(store.agentIdsOfUser(user.id)).toEqual([])
    expect(store.agent(first.id)).toBeDefined()
  })
  it('sin máquina registrada no se crea la identidad', () => {
    const org = store.insertOrganization('x', 'X')
    const user = store.insertUser({ organization_id: org.id, email: 'a@b.c', full_name: 'A', password_hash: '!', org_role: 'owner' })
    expect(ensureRunProfileAgent(store, user.id, 'hub_effects')).toBeUndefined()
  })
  it('profileAllowsTool deniega por defecto y distingue memoria de integraciones', () => {
    expect(profileAllowsTool('hub_run_action', { memory: true, tool: 'search' })).toBe(true)
    expect(profileAllowsTool('hub_run_action', { memory: false, tool: 'search' })).toBe(false)
    expect(profileAllowsTool('hub_run_action', { memory: true, tool: 'schedule_create' })).toBe(false)
    expect(profileAllowsTool('hub_effects', { memory: true, tool: 'search' })).toBe(false)
    expect(profileAllowsTool('hub_effects', { memory: false, tool: 'AddWorklogToJiraIssue' })).toBe(true)
    expect(profileAllowsTool('hub_effects', { memory: false, tool: 'deleteIssue' })).toBe(false)
  })
})
