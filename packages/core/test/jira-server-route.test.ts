import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken, generateDaemonToken } from '../src/security.js'
import { JIRA_SERVER_NONE, JIRA_SERVER_SETTING, readJiraServerId } from '../src/effects/jira-server.js'

describe('servidor de Jira elegido por el dueño', () => {
  let app: CoreApp, directory: string, ownerId: string, headers: { authorization: string }
  const url = '/api/automations/jira-server'
  const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', url: 'https://mcp.atlassian.com/v1/mcp', headers: {}, secret_refs: {}, requires_host_access: false,
    container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [], auth: 'none' as const }
  const server = (userId: string, slug: string, name: string, tools: string[]) => {
    const row = app.store.insertServer({ ...base, user_id: userId, slug, display_name: name })
    for (const tool of tools) app.store.insertTool({ server_id: row.id, name: tool, exposed_name: `${slug}_${tool}`, title: tool, description: '', input_schema: { type: 'object' }, definition_hash: `h-${tool}` })
    return row
  }
  const jiraTools = ['atlassianUserInfo', 'getJiraIssue', 'getVisibleJiraProjects']
  const put = (payload: unknown, auth = headers) => app.fastify.inject({ method: 'PUT', url, headers: auth, payload: payload as Record<string, unknown> })

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'jira-server-route-'))
    vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
    vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    ownerId = ensureLocalOwner(app.store).id
    headers = { authorization: `Bearer ${await createAccessToken(app.settings, ownerId)}` }
  })
  afterEach(async () => { await app?.fastify.close(); app?.db.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('exige la sesión de la app: sin sesión o con el token de un agente no lee ni escribe', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian', jiraTools)
    const machine = app.store.insertMachine({ user_id: ownerId, hostname: 'agente', os: 'test', daemon_version: 'test' })
    const [daemon, digest] = generateDaemonToken()
    app.store.insertToken({ user_id: ownerId, machine_id: machine.id, name: 'agente', token_hash: digest })
    const agent = { authorization: `Bearer ${daemon}` }
    expect((await app.fastify.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url, headers: agent })).statusCode).toBe(401)
    expect((await put({ server_id: first.id }, agent)).statusCode).toBe(401)
    expect((await put({ server_id: first.id }, { authorization: '' })).statusCode).toBe(401)
    expect(app.store.setting(JIRA_SERVER_SETTING)).toBeUndefined()
  })

  it('lista los servidores del dueño con su aptitud y ningún ajeno; sin elegir, selected es null', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian A', jiraTools)
    const second = server(ownerId, 'atlassian_rovo_2', 'Atlassian B', ['atlassianUserInfo', 'getJiraIssue'])
    const partial = server(ownerId, 'solo_lectura', 'Parcial', ['getJiraIssue'])
    const org = app.store.insertOrganization('otra', 'Otra')
    const other = app.store.insertUser({ organization_id: org.id, email: 'otro@example.com', full_name: 'Otro', password_hash: '!', org_role: 'owner' })
    server(other.id, 'ajeno', 'Ajeno', jiraTools)
    const response = await app.fastify.inject({ method: 'GET', url, headers })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.selected).toBeNull()
    expect(body.servers).toEqual(expect.arrayContaining([
      { id: first.id, name: 'Atlassian A', usable: true }, { id: second.id, name: 'Atlassian B', usable: true }, { id: partial.id, name: 'Parcial', usable: false },
    ]))
    expect(body.servers.map((entry: { name: string }) => entry.name)).not.toContain('Ajeno')
  })

  it('una herramienta en cuarentena no vuelve usable al servidor', async () => {
    const row = server(ownerId, 'atlassian_rovo', 'Atlassian', jiraTools)
    app.db.run('UPDATE mcp_tools SET quarantined = 1 WHERE server_id = ? AND name = ?', row.id, 'getJiraIssue')
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json().servers.find((entry: { id: string }) => entry.id === row.id)).toMatchObject({ usable: false })
    expect((await put({ server_id: row.id })).statusCode).toBe(422)
  })

  it('guarda un servidor usable, lo lee readJiraServerId en el acto y cambiarlo no necesita reinicio', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian A', jiraTools)
    const second = server(ownerId, 'atlassian_rovo_2', 'Atlassian B', jiraTools)
    const saved = await put({ server_id: first.id })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().selected).toBe(first.id)
    expect(readJiraServerId(app.store, ownerId)).toBe(first.id)
    expect((await put({ server_id: second.id })).json().selected).toBe(second.id)
    expect(readJiraServerId(app.store, ownerId)).toBe(second.id)
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json().selected).toBe(second.id)
  })

  it('rechaza con 422 un servidor inexistente, ajeno o no usable y conserva el seleccionado', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian', jiraTools)
    const unusable = server(ownerId, 'memoria', 'Sin Jira', ['search'])
    const org = app.store.insertOrganization('otra', 'Otra')
    const other = app.store.insertUser({ organization_id: org.id, email: 'otro@example.com', full_name: 'Otro', password_hash: '!', org_role: 'owner' })
    const foreign = server(other.id, 'ajeno', 'Ajeno', jiraTools)
    expect((await put({ server_id: first.id })).statusCode).toBe(200)
    for (const payload of [{ server_id: 'no-existe' }, { server_id: '' }, { server_id: 'atlassian_rovo' }, { server_id: foreign.id }, { server_id: unusable.id }, {}, { server_id: 7 }, { server_id: first.id, otro: 1 }, null]) {
      expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(422)
    }
    expect(readJiraServerId(app.store, ownerId)).toBe(first.id)
  })

  it('null guarda «Ninguno» y las escrituras vuelven a quedar cerradas', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian', jiraTools)
    await put({ server_id: first.id })
    const cleared = await put({ server_id: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().selected).toBeNull()
    expect(app.store.setting(JIRA_SERVER_SETTING)).toBe(JIRA_SERVER_NONE)
    expect(readJiraServerId(app.store, ownerId)).toBeUndefined()
    expect((await put({ server_id: null })).statusCode).toBe(200)
  })

  it('sin elección rige el conector atlassian-rovo del dueño si es utilizable, y «Ninguno» elegido no vuelve a él', async () => {
    const rovo = server(ownerId, 'atlassian-rovo', 'Atlassian Rovo', jiraTools)
    const second = server(ownerId, 'atlassian-rovo-2', 'Atlassian Rovo (2)', jiraTools)
    expect(readJiraServerId(app.store, ownerId)).toBe(rovo.id)
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json().selected).toBe(rovo.id)
    expect((await put({ server_id: second.id })).json().selected).toBe(second.id)
    expect((await put({ server_id: null })).json().selected).toBeNull()
    expect(readJiraServerId(app.store, ownerId)).toBeUndefined()
  })

  it('el conector por defecto no rige si no es utilizable o es de otro dueño', async () => {
    server(ownerId, 'atlassian-rovo', 'Atlassian Rovo', ['getJiraIssue'])
    expect(readJiraServerId(app.store, ownerId)).toBeUndefined()
    const org = app.store.insertOrganization('otra', 'Otra')
    const other = app.store.insertUser({ organization_id: org.id, email: 'otro@example.com', full_name: 'Otro', password_hash: '!', org_role: 'owner' })
    server(other.id, 'atlassian-rovo', 'Atlassian Rovo', jiraTools)
    expect(readJiraServerId(app.store, ownerId)).toBeUndefined()
  })

  it('un seleccionado que dejó de ser del dueño o de existir se informa como null', async () => {
    const first = server(ownerId, 'atlassian_rovo', 'Atlassian', jiraTools)
    await put({ server_id: first.id })
    app.store.setSetting(JIRA_SERVER_SETTING, 'huerfano')
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json().selected).toBeNull()
  })
})
