import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'

afterEach(() => vi.unstubAllEnvs())

it('opens the owner inbox headless, gates it when disabled and restores it independently of settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-assistants-'))
  vi.stubEnv('AGENTHUB_MEMORY_DIR', join(dir, 'memory'))
  vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
  const app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(dir, 'hub.db') } })
  try {
    const headers = { authorization: 'Bearer ' + (await createAccessToken(app.settings, ensureLocalOwner(app.store).id)) }
    const get = (url: string) => app.fastify.inject({ method: 'GET', url, headers })
    const post = (url: string, payload: Record<string, unknown>) => app.fastify.inject({ method: 'POST', url, headers, payload })
    const toggle = (id: string, enabled: boolean) =>
      app.fastify.inject({ method: 'PUT', url: '/api/modules/' + id, headers, payload: { enabled } })
    expect((await app.fastify.inject('/api/assistants/inbox')).statusCode).toBe(401)
    expect((await get('/api/assistants/inbox')).json()).toMatchObject({ items: [] })
    const created = await post('/api/memory/call', { operation: 'create_entity', input: { kind: 'project', title: 'Proyecto de prueba' } })
    expect(created.statusCode).toBe(200)
    const project = created.json().id
    const path = '/api/assistants/projects/' + project
    const config = { active: true, timezone: 'UTC', style: 'Respuestas breves' }
    const save = (version: number) => app.fastify.inject({ method: 'PUT', url: path, headers, payload: { version, config } })
    expect((await save(0)).json()).toMatchObject({ version: 1, config })
    expect((await save(1)).json()).toMatchObject({ version: 1, config })
    expect((await post(path + '/scan', {})).json()).toMatchObject({ version: 1, last_error: null })
    const policy = (await get('/api/assistants/settings')).json()
    expect(policy.config.delay_minutes).toBe(10)
    expect(policy.config.jira_assignee_scope).toBe('mine')
    expect(
      (
        await app.fastify.inject({
          method: 'PUT',
          url: '/api/assistants/settings',
          headers,
          payload: { version: policy.version, config: { ...policy.config, threshold: 7, jira_assignee_scope: 'project' } },
        })
      ).statusCode,
    ).toBe(200)
    const second = await post('/api/memory/call', { operation: 'create_entity', input: { kind: 'project', title: 'Segundo proyecto' } })
    expect((await post('/api/assistants/scan', {})).json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: project, last_scan: expect.any(String) }),
        expect.objectContaining({ id: second.json().id, last_scan: expect.any(String) }),
      ]),
    )
    expect((await get('/api/assistants/projects/' + second.json().id)).json().config).toMatchObject({ active: true, threshold: 7, jira_assignee_scope: 'project' })
    expect((await get('/api/assistants/chat')).json().messages).toEqual([])
    expect((await get('/api/assistants/inbox?state=history&limit=1')).json().has_more).toBe(false)
    const general = await post('/api/assistants/chat', { text: '¿Qué pendientes hay?' })
    expect(general.json().messages.at(-1).body).toContain('Configurá un modelo')
    const consumer = randomUUID()
    const putSettings = async (config: Record<string, unknown>) => {
      const current = (await get('/api/assistants/settings')).json()
      return (
        await app.fastify.inject({
          method: 'PUT',
          url: '/api/assistants/settings',
          headers,
          payload: { version: current.version, config: { ...current.config, ...config } },
        })
      ).json()
    }
    const hour = new Date().getUTCHours()
    const start = String((hour + 23) % 24).padStart(2, '0') + ':00',
      end = String((hour + 2) % 24).padStart(2, '0') + ':00'
    const updated = await putSettings({
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      timezone: 'UTC',
      start,
      end,
      notifications: { daily_limit: 4, interrupt_severity: 10 },
    })
    expect(updated.config.notifications).toMatchObject({ daily_limit: 4, interrupt_severity: 10, cooldown_minutes: 15 })
    for (const title of ['Revisión uno', 'Revisión dos']) {
      expect(
        (
          await post('/api/memory/call', {
            operation: 'import_source',
            input: {
              kind: 'event',
              project_ids: [project],
              title,
              external_id: title,
              occurred_at: new Date(Date.now() + 600_000).toISOString(),
            },
          })
        ).statusCode,
      ).toBe(200)
    }
    await post(path + '/scan', {})
    const claim = () => post('/api/assistants/notices/claim', { consumer })
    const [notice] = (await claim()).json().items
    expect(notice.entries.filter((entry: { kind: string }) => entry.kind === 'meeting')).toHaveLength(2)
    expect((await get('/api/assistants/notices/' + notice.delivery_id)).json().entries).toHaveLength(notice.entries.length)
    expect(
      (await post('/api/assistants/notices/' + notice.id + '/seen', { revision: notice.revision, delivery_id: notice.delivery_id }))
        .statusCode,
    ).toBe(200)
    expect((await claim()).json().items).toEqual([])
    const selectedId = notice.entries.find((entry: { kind: string }) => entry.kind === 'meeting').id
    const focused = () => post('/api/assistants/chat', { case_id: selectedId, text: '¿Qué reunión es esta?' })
    expect((await focused()).json().messages.at(-1)).toMatchObject({ case_id: selectedId, body: expect.stringContaining('Revisión') })
    await toggle('assistants', false)
    expect((await focused()).json().code).toBe('module_disabled')
    expect((await claim()).statusCode).toBe(409)
    expect((await get('/api/assistants/notices/' + notice.delivery_id)).statusCode).toBe(409)
    for (const url of ['/api/assistants/settings', '/api/assistants/chat', '/api/assistants/work'])
      expect((await get(url)).json().code).toBe('module_disabled')
    expect((await post('/api/assistants/scan', {})).json().code).toBe('module_disabled')
    expect((await get('/api/assistants/inbox')).json()).toMatchObject({ code: 'module_disabled', module: 'assistants' })
    expect((await get('/api/memory/schedules')).statusCode).toBe(200)
    expect((await post(path + '/scan', {})).json()).toMatchObject({ code: 'module_disabled' })
    await toggle('assistants', true)
    expect((await focused()).json().messages.at(-1).case_id).toBe(selectedId)
    expect((await claim()).statusCode).toBe(200)
    expect((await get('/api/assistants/settings')).json().config).toMatchObject({ threshold: 7, jira_assignee_scope: 'project' })
    expect((await post('/api/assistants/scan', {})).statusCode).toBe(200)
    const reopened = (await get('/api/assistants/inbox')).json().items
    expect(reopened.map((item: { title: string }) => item.title)).toEqual(expect.arrayContaining(['Revisión uno', 'Revisión dos']))
    expect((await claim()).json().items).toEqual([])
    expect((await post(path + '/scan', {})).json()).toMatchObject({ config: { active: true } })
    await toggle('agents', false)
    expect((await get('/api/assistants/work/' + project)).json()).toMatchObject({ code: 'module_disabled', module: 'agents' })
    expect((await get('/api/assistants/notices')).statusCode).toBe(200)
    await toggle('agents', true)
    expect((await get('/api/assistants/work/' + project)).statusCode).toBe(200)
    await toggle('connections', false)
    expect((await post('/api/assistants/slack/' + project + '/approve', { revision: 1 })).json()).toMatchObject({
      code: 'module_disabled',
      module: 'connections',
    })
    await toggle('connections', true)
    expect((await post('/api/assistants/slack/' + project + '/approve', { revision: 1 })).statusCode).toBe(404)
    await toggle('memory', false)
    expect((await get('/api/assistants/inbox')).json()).toMatchObject({ code: 'module_disabled' })
    expect((await get('/api/modules')).statusCode).toBe(200)
  } finally {
    await app.fastify.close()
    app.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
