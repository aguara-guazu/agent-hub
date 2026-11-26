import type { FastifyInstance } from 'fastify'
import type { ModuleEnabled, ModuleId } from '@agenthub/shared/modules'
import { z } from 'zod'
import type { MemoryService } from '../service.js'
import { upsertJiraIssues } from '../projects/tasks.js'
import type { OwnerGuard, MemoryRouteOptions } from '../http.js'
import { check, id, parse } from '../contracts.js'
import { portfolioPolicy, profile, role, textInput } from './contracts.js'
import { projectModel, retrieve } from './context.js'
import { channelAccess, connectedSlackIdentity, readSlackName } from './slack.js'
import { calendarAvailability } from '../connectors/calendar-window.js'
import type { OpenResidentTeams } from './teams.js'
import { Resident } from './runtime.js'
import { compareClose, compareInput } from './close-shadow.js'
import type { JiraGuard } from '../schedules/schedule-contract.js'

const projectParam = z.object({ project: id })
const caseParam = z.object({ id })
const revision = z.number().int().positive()
const overviewBody = z
  .object({ text: textInput, case_id: id.nullable().default(null), work_id: id.optional(), mode: z.enum(['chat', 'rewrite']).default('chat'), revision: revision.optional() })
  .strict()
const caseIds = z.object({ ids: z.array(id).min(1).max(300) }).strict()
const chatBody = z
  .object({
    text: textInput,
    case_id: id.nullable().default(null),
    mode: z.enum(['chat', 'rewrite']).default('chat'),
    revision: revision.optional(),
    request_id: id.optional(),
  })
  .strict()

export function registerAssistants(
  app: FastifyInstance,
  service: MemoryService,
  authorize: OwnerGuard,
  enabled: ModuleEnabled,
  jira: () => JiraGuard | undefined,
  openTeams?: OpenResidentTeams,
  readTools?: MemoryRouteOptions['residentReadTools'],
) {
  const guard = { preHandler: authorize }
  const available = () => enabled('assistants') && enabled('memory') && !service.admission.isClosed()
  let resident: Promise<Resident> | undefined
  let clock: NodeJS.Timeout | undefined,
    tick: Promise<void> | undefined,
    closed = false
  async function instance() {
    check(available() && !closed, 'El asistente está pausado', 409)
    if (!resident)
      resident = (async () => {
        const { db, ai, store } = await service.get()
        const identifiers = new Map<string, { until: number; value: string | null }>()
        async function cached(key: string, read: () => Promise<string | null>) {
          const current = identifiers.get(key)
          if (current && current.until > Date.now()) return current.value
          const value = await read().catch(() => null)
          identifiers.set(key, { value, until: Date.now() + (value ? 300000 : 60000) })
          return value
        }
        let jiraIdentity: { until: number; value: string | null } | undefined
        const r = new Resident(
          db,
          projectModel(db, ai, available, { openTeams, readTools, kiroKey: () => service.vault.read<{ api_key: string }>('kiro')?.api_key }),
          (p, t, x) => retrieve(db, ai, p, t, x),
          (p, w, s) => channelAccess(db, service.vault, p, w, () => available() && enabled('connections'), s),
          (module) => !closed && enabled(module),
          undefined,
          undefined,
          {
            slack: connectedSlackIdentity(service.vault),
            channelName: (id, channel) => cached(id + '/' + channel, () => readSlackName(service.vault, id, channel)),
            jiraFor: (id, site) =>
              cached(id + '/' + site, async () => {
                const credentials = service.vault.read(id),
                  url = new URL(site)
                if (
                  url.protocol !== 'https:' ||
                  !url.hostname.endsWith('.atlassian.net') ||
                  url.username ||
                  url.password ||
                  !credentials?.email ||
                  !credentials.token
                )
                  return null
                const response = await fetch(url.origin + '/rest/api/3/myself', {
                  headers: { Authorization: 'Basic ' + Buffer.from(credentials.email + ':' + credentials.token).toString('base64') },
                  redirect: 'error',
                  signal: AbortSignal.timeout(8000),
                })
                if (!response.ok) return null
                const { accountId } = (await response.json()) as { accountId?: string }
                return typeof accountId === 'string' && accountId.length <= 180 ? accountId : null
              }),
            jira: async () => {
              if (!enabled('mcp')) return null
              if (!jiraIdentity || jiraIdentity.until <= Date.now()) {
                const value = (await jira()?.ownerAccountId()) ?? null
                jiraIdentity = { value, until: Date.now() + (value ? 300000 : 60000) }
              }
              return jiraIdentity.value
            },
          },
          calendarAvailability(db, service.google),
          service.jiraMcp,
          (project, issues) => upsertJiraIssues(store, issues, 'assistant:jira-sync', project),
        )
        await Promise.all([r.work.recover(), r.attention.recover()])
        return r
      })().catch((e) => {
        resident = undefined
        throw e
      })
    return resident
  }
  function wake() {
    if (closed || !available() || tick) return
    tick = service.admission
      .track('job', async () => {
        const r = await instance()
        if (!closed && available()) await r.tick()
      })
      .catch(() => {})
      .finally(() => {
        tick = undefined
      })
  }
  function start() {
    if (closed || !enabled('assistants') || !enabled('memory') || clock) return
    clock = setInterval(wake, 45_000).unref()
    wake()
  }
  async function stop() {
    clearInterval(clock)
    clock = undefined
    await (await resident?.catch(() => undefined))?.stop()
    await tick
  }
  const run = async <T>(fn: (r: Resident) => Promise<T>) =>
    service.admission.track('job', async () => {
      const r = await instance()
      return r.track(fn(r))
    })
  app.get('/api/assistants/settings', guard, async () => (await instance()).policy())
  app.put('/api/assistants/settings', guard, async (req) => {
    const body = parse(z.object({ version: z.number().int().min(0), config: portfolioPolicy }).strict(), req.body)
    const result = await run((r) => r.setPolicy(body.config, body.version))
    wake()
    return result
  })
  app.post('/api/assistants/scan', guard, async () =>
    run(async (r) => {
      await r.scanNow()
      return { items: await r.projects() }
    }),
  )
  app.get('/api/assistants/chat', guard, async () => (await instance()).overview())
  app.post('/api/assistants/chat', guard, async (req) => {
    const body = parse(overviewBody, req.body)
    if (body.mode === 'rewrite') check(body.case_id && enabled('connections'), 'Elegí un asunto de Slack para ajustar su borrador', 409)
    return run((r) => r.overview({ text: body.text, caseId: body.case_id, workId: body.work_id, mode: body.mode, revision: body.revision }))
  })
  app.get('/api/assistants/work', guard, async () => {
    const { db } = await instance()
    const visible = `FROM assistant_work w JOIN entities e ON e.id=w.project_id
     WHERE coalesce(e.data->>'memory_state','')<>'archived' AND e.id NOT IN (SELECT project_id FROM archived_projects)`
    const [counts] = await db.query(`SELECT count(*) AS total,coalesce(sum(w.state='blocked'),0) AS blocked ${visible}`)
    return {
      items: await db.query(`SELECT w.*,e.title AS project_title ${visible} ORDER BY w.updated_at DESC,w.id LIMIT 200`),
      total: Number(counts?.total ?? 0),
      blocked: Number(counts?.blocked ?? 0),
    }
  })
  app.get('/api/assistants/projects', guard, async () => {
    const r = await instance()
    return { items: await r.projects(), model: await r.modelStatus() }
  })
  app.get('/api/assistants/projects/:project', guard, async (req) => {
    const { project } = parse(projectParam, req.params),
      r = await instance()
    const settings = await r.settings(project)
    const connectors = enabled('connections')
      ? await r.db.query(
          `SELECT id,name,config->'channel_ids' AS "channels:json" FROM connectors WHERE enabled AND provider='slack'
      AND (json_array_length(project_ids)=0 OR EXISTS(SELECT 1 FROM json_each(project_ids) WHERE value=$1)) ORDER BY name`,
          [project],
        )
      : []
    return { ...settings, connectors, estimates: await r.work.estimates(project) }
  })
  app.put('/api/assistants/projects/:project', guard, async (req) => {
    const { project } = parse(projectParam, req.params)
    const body = parse(z.object({ version: z.number().int().min(0), config: profile }).strict(), req.body)
    return run(async r => {
      const saved = await r.save(project, body.config, body.version)
      if (!saved.config.active) await (await service.get()).operations.teams?.closeResidentTeams(project)
      return saved
    })
  })
  app.post('/api/assistants/projects/:project/scan', guard, async (req) => {
    const { project } = parse(projectParam, req.params)
    return run(async (r) => {
      await r.scan(project)
      return r.settings(project)
    })
  })
  app.get('/api/assistants/inbox', guard, async (req) => {
    const { project, state, limit, offset, q } = parse(
      z.object({
        project: id.optional(),
        state: z.enum(['attention', 'history', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(300).default(300),
        offset: z.coerce.number().int().nonnegative().default(0),
        q: z.string().trim().max(200).default(''),
      }),
      req.query,
    )
    const r = await instance()
    const [items, totals] = await Promise.all([r.inbox(project, state, limit + 1, offset, q), r.inboxTotals(project, state, q)])
    return { items: items.slice(0, limit), has_more: items.length > limit, ...totals }
  })
  app.post('/api/assistants/cases/dismiss', guard, async (req) => {
    const { ids } = parse(caseIds, req.body)
    return run(async (r) => ({ ids: await r.attention.dismiss(ids) }))
  })
  app.post('/api/assistants/cases/restore', guard, async (req) => {
    const { ids } = parse(caseIds, req.body)
    return run(async (r) => ({ ids: await r.attention.restore(ids) }))
  })
  app.get('/api/assistants/cases/:id', guard, async (req) => {
    const r = await instance(),
      c = await r.attention.get(parse(caseParam, req.params).id)
    return r.conversation(c.project_id, c.id)
  })
  app.get('/api/assistants/projects/:project/chat', guard, async (req) => {
    const { project } = parse(projectParam, req.params)
    return (await instance()).conversation(project, null)
  })
  app.post('/api/assistants/projects/:project/chat', guard, async (req) => {
    const { project } = parse(projectParam, req.params),
      body = parse(chatBody, req.body)
    if (body.mode === 'rewrite') check(enabled('connections'), 'Conexiones desactivadas', 409)
    return run((r) => r.chat(project, body.case_id, body.text, body.mode, body.revision, body.request_id))
  })
  app.post('/api/assistants/slack/:id/approve', guard, async (req) => {
    const { id: caseId } = parse(caseParam, req.params),
      body = parse(z.object({ revision }).strict(), req.body)
    return run(async (r) => {
      const c = await r.attention.get(caseId),
        p = await r.settings(c.project_id)
      check(p.config.active && enabled('connections'), 'Slack está pausado', 409)
      return r.attention.approve(c.id, body.revision, p.config, p.version, r.signal(c.project_id))
    })
  })
  app.get('/api/assistants/notices', guard, async () => ({ items: await (await instance()).notices() }))
  app.post('/api/assistants/notices/claim', guard, async (req) => {
    const { consumer } = parse(z.object({ consumer: id }).strict(), req.body)
    return { items: await (await instance()).notifications.next(consumer) }
  })
  app.get('/api/assistants/notices/:id', guard, async (req) => {
    const { id } = parse(caseParam, req.params)
    return (await instance()).notifications.detail(id)
  })
  app.post('/api/assistants/notices/:id/seen', guard, async (req) => {
    const batch = parse(caseParam, req.params)
    const body = parse(z.object({ revision, delivery_id: id.optional() }).strict(), req.body)
    await (await instance()).notifications.seen(batch.id, body.revision, body.delivery_id)
    return { ok: true }
  })
  app.get('/api/assistants/work/:project', guard, async (req) => {
    const { project } = parse(projectParam, req.params)
    const { db } = await instance()
    const [counts] = await db.query(
      "SELECT count(*) AS total,coalesce(sum(state='blocked'),0) AS blocked FROM assistant_work WHERE project_id=$1",
      [project],
    )
    return {
      items: await db.query('SELECT * FROM assistant_work WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 100', [project]),
      total: Number(counts?.total ?? 0),
      blocked: Number(counts?.blocked ?? 0),
    }
  })
  app.post('/api/assistants/work/:project', guard, async (req) => {
    const { project } = parse(projectParam, req.params),
      body = parse(z.object({ role, objective: textInput, request_id: id }).strict(), req.body)
    return run(async (r) => {
      const p = await r.settings(project)
      check(p.config.active, 'El proyecto está pausado', 409)
      return r.work.enqueue(
        project,
        p.config,
        p.version,
        { role: body.role, objective: body.objective, key: 'owner/' + body.request_id },
        r.signal(project),
      )
    })
  })
  app.post('/api/assistants/work/:project/:id/retry', guard, async (req) => {
    const params = parse(projectParam.extend({ id }), req.params)
    const r = await instance(),
      p = await r.settings(params.project)
    const rows = await r.db.query(
      "UPDATE assistant_work SET state='queued',updated_at=now() WHERE id=$1 AND project_id=$2 AND state='blocked' AND scope->>'version'=$3 RETURNING id",
      [params.id, params.project, p.version],
    )
    check(rows.length && p.config.active, 'La microtarea cambió', 409)
    return { queued: true }
  })
  app.post('/api/assistants/projects/:project/shadow', guard, async (req) => {
    const { project } = parse(projectParam, req.params)
    return (await instance()).shadow(project, parse(profile, req.body))
  })
  app.post('/api/assistants/automations/:project/close/compare', guard, async (req) => {
    const { project } = parse(projectParam, req.params),
      input = parse(compareInput, req.body)
    const { store, schedules } = await service.get()
    check(schedules, 'Las automatizaciones están pausadas', 409)
    await (await instance()).settings(project)
    return compareClose(
      store,
      project,
      new Date(),
      () => schedules.store.statusProjects(),
      schedules.attention(),
      enabled('connections') ? jira() : undefined,
      input,
    )
  })
  app.addHook('onListen', async () => start())
  return {
    async trackingChanged(project: string) {
      if (resident) (await resident)?.trackingChanged(project)
      const { db, operations } = await service.get()
      if ((await db.query('SELECT 1 FROM archived_projects WHERE project_id=$1', [project])).length) await operations.teams?.closeResidentTeams(project)
      wake()
    },
    async update(id: ModuleId) {
      if (['assistants', 'memory', 'connections', 'agents', 'mcp', 'skills'].includes(id)) {
        await stop()
        if (['assistants', 'memory', 'agents', 'mcp'].includes(id) && !enabled(id)) await (await service.get()).operations.teams?.closeResidentTeams()
        if (app.server.listening) start()
      }
    },
    async close() {
      closed = true
      await stop()
    },
  }
}
