import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Sql } from './database.js'
import type { Vault } from './config.js'
import { check, id, MemoryError, parse } from './contracts.js'
import { ProviderHttp, richText } from './connectors/http.js'
import { requireEntity, validateEvidence, type MemoryStore } from './store.js'

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const
export const taskStatus = z.enum(TASK_STATUSES)
const OPEN = ['todo', 'in_progress', 'blocked']
const page = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }

export const listTasksInput = z.object({ project_id: id.optional(), kind: z.enum(['jira', 'pending']).optional(),
  status: z.enum([...TASK_STATUSES, 'open']).optional(), query: z.string().trim().max(500).optional(), ...page }).strict()
export const saveTaskInput = z.object({
  id: id.optional(), project_id: id.nullable().optional(),
  title: z.string().trim().min(1).max(500).optional(), description: z.string().max(8000).optional(), status: taskStatus.optional(),
  origin: z.enum(['agent', 'meeting', 'note', 'code', 'manual']).optional(),
  code_ref: z.string().trim().max(1000).nullable().optional(), source_entity_id: id.nullable().optional(),
  evidence_ids: z.array(id).max(50).optional(), note: z.string().trim().min(1).max(2000).optional(),
  jira: z.object({ transition: z.string().trim().min(1).max(200).optional(), comment: z.string().trim().min(1).max(8000).optional() }).strict().optional(),
}).strict()
export const syncTasksInput = z.object({ project_id: id.optional(), issues: z.array(z.unknown()).max(500).optional(),
  site_url: z.url().optional(), source: z.enum(['agent', 'mcp_mirror']).default('agent') }).strict()
export const taskStatsInput = z.object({ project_id: id.optional(), weeks: z.number().int().min(2).max(52).default(12) }).strict()

interface JiraIssue { key: string; summary: string; status: string; category: string | null; issue_type: string | null; priority: string | null
  assignee: string | null; updated: string | null; description: string | null; url: string | null; site: string | null }

const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const nameOf = (value: any) => text(typeof value === 'string' ? value : value?.name ?? value?.displayName, 200)

/** Accepts Jira REST issues as returned by the Atlassian MCP or the REST API, and flat {key, summary, status} objects. */
export function normalizeJiraIssue(raw: unknown, site?: string): JiraIssue | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, any>, fields = row.fields && typeof row.fields === 'object' ? row.fields : row
  const key = text(row.key ?? row.issueKey, 60)?.toUpperCase()
  if (!key || !/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(key)) return null
  const summary = text(fields.summary ?? row.summary ?? row.title, 500)
  const status = nameOf(fields.status ?? row.status)
  if (!summary || !status) return null
  const category = text(fields.status?.statusCategory?.key ?? row.status_category ?? row.statusCategory, 40)
  const updated = text(fields.updated ?? row.updated, 60)
  const origin = (value: unknown): string | null => { try { const u = new URL(String(value)); return u.protocol === 'https:' && u.hostname.endsWith('.atlassian.net') ? u.origin : null } catch { return null } }
  const issueSite = origin(site) ?? origin(row.url) ?? origin(row.self)
  const browse = text(row.url, 1000) ?? (issueSite ? `${issueSite}/browse/${encodeURIComponent(key)}` : null)
  const description = fields.description === undefined ? null : text(typeof fields.description === 'string' ? fields.description : richText(fields.description), 8000) ?? ''
  return { key, summary, status, category, issue_type: nameOf(fields.issuetype ?? row.issue_type ?? row.type), priority: nameOf(fields.priority ?? row.priority),
    assignee: nameOf(fields.assignee ?? row.assignee), updated: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toISOString() : null,
    description, site: issueSite, url: browse && /^https:\/\//.test(browse) ? browse : null }
}

/** Jira's status category is authoritative; the status name only refines it (blocked) or fills in when the category is missing. */
export function mapJiraStatus(status: string, category: string | null): (typeof TASK_STATUSES)[number] {
  if (/bloque|block|imped|on hold|en espera/i.test(status)) return 'blocked'
  if (category === 'done') return /cancel|descart|won'?t|rechaz|no se har/i.test(status) ? 'dropped' : 'done'
  if (category === 'indeterminate') return 'in_progress'
  if (category === 'new') return 'todo'
  if (/done|hecho|cerrad|closed|resuel|resolved|finaliz|complet/i.test(status)) return 'done'
  if (/progres|curso|review|revisi|test|qa|desarroll|doing/i.test(status)) return 'in_progress'
  return 'todo'
}

async function recordEvent(sql: Sql, taskId: string, action: string, actor: string, before: string | null, after: string | null, detail: Record<string, unknown> = {}) {
  await sql.query('INSERT INTO task_events(task_id,action,actor,status_before,status_after,detail) VALUES($1,$2,$3,$4,$5,$6)', [taskId, action, actor, before, after, JSON.stringify(detail)])
}

async function projectsByJiraKey(sql: Sql) {
  const rows = await sql.query("SELECT id,title,data->>'jira_project_key' AS key,data->>'jira_site_url' AS site FROM entities WHERE kind='project' AND COALESCE(data->>'jira_project_key','')<>''")
  return rows
}

/** Upserts the mirror of each issue into the project that owns its key prefix (or the explicit project). Returns what changed. */
export async function upsertJiraIssues(store: MemoryStore, issues: JiraIssue[], actor: string, projectId?: string) {
  return store.db.transaction(async sql => {
    const byKey = await projectsByJiraKey(sql)
    const explicit = projectId ? await requireEntity(sql, projectId, 'project') : null
    const summary = { received: issues.length, created: 0, updated: 0, status_changed: 0, unchanged: 0, unmatched: [] as string[], tasks: [] as Record<string, unknown>[] }
    for (const issue of [...issues].sort((a, b) => a.key.localeCompare(b.key))) {
      // Concurrent agent calls may both observe a missing row; serialize before the first insert too.
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`jira-task:${issue.key}`])
      const prefix = issue.key.slice(0, issue.key.lastIndexOf('-'))
      const candidates = byKey.filter(p => p.key === prefix && (!issue.site || !p.site || p.site === issue.site))
      const owner = explicit && (!explicit.data.jira_project_key || explicit.data.jira_project_key === prefix)
        && (!issue.site || !explicit.data.jira_site_url || explicit.data.jira_site_url === issue.site)
        ? { id: explicit.id, title: explicit.title, site: explicit.data.jira_site_url }
        : !explicit && candidates.length === 1 ? candidates[0] : undefined
      if (!owner) { summary.unmatched.push(issue.key); continue }
      const url = issue.url ?? (owner.site ? `${owner.site}/browse/${encodeURIComponent(issue.key)}` : null)
      const site = issue.site ?? owner.site ?? ''
      const status = mapJiraStatus(issue.status, issue.category)
      const current = (await sql.query("SELECT * FROM tasks WHERE kind='jira' AND external_key=$1 AND (external_site=$2 OR (external_site='' AND project_id=$3)) FOR UPDATE", [issue.key, site, owner.id]))[0]
      if (!current) {
        const taskId = randomUUID()
        await sql.query(`INSERT INTO tasks(id,project_id,kind,title,description,status,origin,external_key,external_status,external_category,external_url,external_updated_at,
          issue_type,priority,assignee,created_by,updated_by,closed_at,external_site) VALUES($1,$2,'jira',$3,$4,$5,'jira',$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,CASE WHEN $5 IN ('done','dropped') THEN now() END,$15)`,
        [taskId, owner.id, issue.summary, issue.description ?? '', status, issue.key, issue.status, issue.category, url, issue.updated, issue.issue_type, issue.priority, issue.assignee, actor, site])
        await recordEvent(sql, taskId, 'created', actor, null, status, { jira_status: issue.status })
        summary.created++; summary.tasks.push({ id: taskId, key: issue.key, status, project_id: owner.id })
        continue
      }
      // An older snapshot (a delayed mirror or a stale agent copy) never overwrites a newer one.
      if (issue.updated && current.external_updated_at && Date.parse(issue.updated) < Date.parse(current.external_updated_at)) { summary.unchanged++; continue }
      const changed = current.title !== issue.summary || current.external_status !== issue.status || current.assignee !== issue.assignee
        || current.priority !== issue.priority || current.project_id !== owner.id || current.status !== status
        || (issue.description !== null && current.description !== issue.description) || current.issue_type !== issue.issue_type
        || current.external_category !== issue.category || (url !== null && current.external_url !== url) || current.external_site !== site
      if (!changed) {
        if (issue.updated) await sql.query('UPDATE tasks SET external_updated_at=$2 WHERE id=$1', [current.id, issue.updated])
        summary.unchanged++; continue
      }
      await sql.query(`UPDATE tasks SET project_id=$2,title=$3,description=CASE WHEN $4::text IS NULL THEN description ELSE $4 END,status=$5,external_status=$6,external_category=$7,
        external_url=COALESCE($8,external_url),external_updated_at=COALESCE($9,external_updated_at),issue_type=$10,priority=$11,assignee=$12,updated_by=$13,updated_at=now(),
        closed_at=CASE WHEN $5 IN ('done','dropped') THEN COALESCE(closed_at,now()) ELSE NULL END,external_site=$14 WHERE id=$1`,
      [current.id, owner.id, issue.summary, issue.description, status, issue.status, issue.category, url, issue.updated, issue.issue_type, issue.priority, issue.assignee, actor, site])
      if (current.status !== status || current.external_status !== issue.status) {
        await recordEvent(sql, current.id, 'status', actor, current.status, status, { jira_status_before: current.external_status, jira_status: issue.status })
        summary.status_changed++
      } else await recordEvent(sql, current.id, 'updated', actor, current.status, status, {})
      summary.updated++; summary.tasks.push({ id: current.id, key: issue.key, status, project_id: owner.id })
    }
    return summary
  })
}

interface JiraAccess { origin: string; headers: Record<string, string> }
export type JiraTaskReader = (request: { key: string; site: string | null; agentId?: string },
  onPage: (issues: unknown[], site: string) => Promise<void>) => Promise<void>
/** A Jira connector whose token can read the site; the project's own site wins when several are configured. */
async function jiraAccess(store: MemoryStore, vault: Vault, site?: string | null): Promise<JiraAccess | null> {
  const connectors = await store.db.query("SELECT id,config FROM connectors WHERE provider='jira' ORDER BY enabled DESC,created_at")
  const usable = connectors.map(c => ({ id: c.id as string, origin: (() => { try { return new URL(String(c.config.site_url)).origin } catch { return '' } })() }))
    .filter(c => c.origin && vault.read(c.id)?.token && vault.read(c.id)?.email)
  const chosen = (site ? usable.find(c => c.origin === site) : undefined) ?? (site ? undefined : usable[0])
  if (!chosen) return null
  const credentials = vault.read(chosen.id)!
  return { origin: chosen.origin, headers: { Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`, Accept: 'application/json' } }
}

const noAccess = (key: string) => new MemoryError(409, `No hay un conector de Jira con token para este sitio. Consulta los issues con el MCP de Jira (searchJiraIssuesUsingJql con "project = ${key}") y pásalos en issues; el hub también refleja automáticamente cada llamada al MCP de Jira.`)

export async function syncTasks(store: MemoryStore, vault: Vault, raw: unknown, actor: string, fetcher: typeof fetch = fetch, jiraMcp?: JiraTaskReader, agentId?: string) {
  const input = parse(syncTasksInput, raw)
  if (input.issues) {
    const site = input.site_url ? new URL(input.site_url).origin : undefined
    const normalized = input.issues.map(issue => normalizeJiraIssue(issue, site))
    const valid = normalized.filter((issue): issue is JiraIssue => issue !== null)
    const result = await upsertJiraIssues(store, valid, input.source === 'mcp_mirror' ? `${actor}:jira-mirror` : actor, input.project_id)
    return { ...result, invalid: normalized.length - valid.length, mode: 'issues' }
  }
  const projects = input.project_id ? [await requireEntity(store.db, input.project_id, 'project')]
    : (await store.db.query("SELECT * FROM entities WHERE kind='project' AND COALESCE(data->>'jira_project_key','')<>'' ORDER BY title"))
  check(projects.length, 'Ningún proyecto tiene configurada su clave de Jira', 409)
  const totals = { received: 0, created: 0, updated: 0, status_changed: 0, unchanged: 0, unmatched: [] as string[], projects: [] as Record<string, unknown>[], mode: 'server' }
  for (const project of projects) {
    const key = project.data.jira_project_key
    check(key, `Configura la clave de Jira del proyecto «${project.title}» en su sección de tareas`, 409)
    const access = await jiraAccess(store, vault, project.data.jira_site_url ?? null)
    if (!access && jiraMcp) {
      let received = 0
      await jiraMcp({ key, site: project.data.jira_site_url ?? null, ...(agentId ? { agentId } : {}) }, async (page, site) => {
        const issues = page.map(issue => normalizeJiraIssue(issue, site))
        check(issues.every(issue => issue !== null), 'Jira devolvió un issue incompleto; vuelve a sincronizar', 502)
        const result = await upsertJiraIssues(store, issues as JiraIssue[], `${actor}:jira-sync`, project.id)
        for (const field of ['received', 'created', 'updated', 'status_changed', 'unchanged'] as const) totals[field] += result[field]
        totals.unmatched.push(...result.unmatched); received += result.received
      })
      totals.projects.push({ id: project.id, title: project.title, key, received, connection: 'mcp' })
      await store.db.query("UPDATE entities SET data=data || jsonb_build_object('jira_synced_at',now()::text) WHERE id=$1", [project.id])
      continue
    }
    if (!access) throw noAccess(key)
    const http = new ProviderHttp(fetcher), issues: JiraIssue[] = []
    let next = ''
    const seen = new Set<string>()
    do {
      const result = await http.json(`${access.origin}/rest/api/3/search/jql`, access.headers, { jql: `project = "${key}" ORDER BY updated DESC`, maxResults: 100,
        fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated'], ...(next ? { nextPageToken: next } : {}) })
      for (const issue of result.issues ?? []) { const normalized = normalizeJiraIssue(issue, access.origin); if (normalized) issues.push(normalized) }
      next = result.isLast ? '' : result.nextPageToken ?? ''
      check(!next || !seen.has(next), 'Jira repitió un cursor de búsqueda', 502)
      seen.add(next)
    } while (next)
    const result = await upsertJiraIssues(store, issues, `${actor}:jira-sync`, project.id)
    for (const field of ['received', 'created', 'updated', 'status_changed', 'unchanged'] as const) totals[field] += result[field]
    totals.unmatched.push(...result.unmatched)
    totals.projects.push({ id: project.id, title: project.title, key, received: result.received })
    await store.db.query("UPDATE entities SET data=data || jsonb_build_object('jira_synced_at',now()::text) WHERE id=$1", [project.id])
  }
  return totals
}

/** Pushes a transition or comment with the connector token, then refreshes the mirror from Jira. */
async function pushToJira(store: MemoryStore, vault: Vault, task: Record<string, any>, change: { transition?: string | undefined; comment?: string | undefined }, actor: string, fetcher: typeof fetch) {
  const project = task.project_id ? await requireEntity(store.db, task.project_id, 'project') : null
  const access = await jiraAccess(store, vault, project?.data.jira_site_url ?? null)
  if (!access) throw new MemoryError(409, `No hay un conector de Jira con token. Actualiza ${task.external_key} con el MCP de Jira; el hub refleja el cambio en esta tarea automáticamente.`)
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await fetcher(`${access.origin}/rest/api/3/issue/${encodeURIComponent(task.external_key)}${path}`, { method, redirect: 'error',
      headers: { ...access.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
    check(response.ok, `Jira rechazó el cambio en ${task.external_key} (HTTP ${response.status})`, response.status === 401 || response.status === 403 ? 409 : 502)
    return response.status === 204 ? null : response.json()
  }
  if (change.transition) {
    const { transitions = [] } = await call('/transitions', 'GET')
    const wanted = change.transition.toLowerCase()
    const match = transitions.find((t: any) => t.id === change.transition || t.name?.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted)
    check(match, `Jira no ofrece la transición «${change.transition}» para ${task.external_key}. Disponibles: ${transitions.map((t: any) => t.to?.name ?? t.name).join(', ')}`, 409)
    await call('/transitions', 'POST', { transition: { id: match.id } })
  }
  if (change.comment) await call('/comment', 'POST', { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: change.comment }] }] } })
  const fresh = normalizeJiraIssue(await call('?fields=summary,status,issuetype,priority,assignee,updated', 'GET'), access.origin)
  if (fresh) await upsertJiraIssues(store, [fresh], actor, task.project_id ?? undefined)
  if (change.comment) await store.db.query("INSERT INTO task_events(task_id,action,actor,detail) VALUES($1,'jira_comment',$2,$3)", [task.id, actor, JSON.stringify({ text: change.comment.slice(0, 2000) })])
}

export async function saveTask(store: MemoryStore, vault: Vault, raw: unknown, actor: string, fetcher: typeof fetch = fetch) {
  const input = parse(saveTaskInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  if (input.source_entity_id) await requireEntity(store.db, input.source_entity_id)
  if (input.id) {
    const task = (await store.db.query('SELECT * FROM tasks WHERE id=$1', [input.id]))[0]
    check(task, 'Tarea inexistente', 404)
    if (task.kind === 'jira') {
      const local = ['title', 'description', 'status', 'origin'] as const
      check(local.every(field => input[field] === undefined), `El título y el estado de ${task.external_key} vienen de Jira: cámbialos en Jira (jira.transition) y la tarea se actualiza sola`, 409)
      if (input.jira) await pushToJira(store, vault, task, input.jira, actor, fetcher)
    } else check(!input.jira, 'Los pendientes internos no existen en Jira')
  }
  return store.db.transaction(async sql => {
    let task: Record<string, any>
    if (!input.id) {
      check(input.title, 'Indica el título del pendiente')
      const status = input.status ?? 'todo'
      task = (await sql.query(`INSERT INTO tasks(id,project_id,kind,title,description,status,origin,code_ref,source_entity_id,created_by,updated_by,closed_at)
        VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$9,CASE WHEN $5 IN ('done','dropped') THEN now() END) RETURNING *`,
      [randomUUID(), input.project_id ?? null, input.title, input.description ?? '', status, input.origin ?? 'manual', input.code_ref ?? null, input.source_entity_id ?? null, actor]))[0]!
      await recordEvent(sql, task.id, 'created', actor, null, status, input.note ? { note: input.note } : {})
    } else {
      const before = (await sql.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [input.id]))[0]!
      const status = input.status ?? before.status
      task = (await sql.query(`UPDATE tasks SET project_id=CASE WHEN $2::boolean THEN $3 ELSE project_id END,title=COALESCE($4,title),description=COALESCE($5,description),status=$6,
        origin=COALESCE($7,origin),code_ref=CASE WHEN $8::boolean THEN $9 ELSE code_ref END,source_entity_id=CASE WHEN $10::boolean THEN $11 ELSE source_entity_id END,
        updated_by=$12,updated_at=now(),closed_at=CASE WHEN $6 IN ('done','dropped') THEN COALESCE(closed_at,now()) ELSE NULL END WHERE id=$1 RETURNING *`,
      [input.id, input.project_id !== undefined, input.project_id ?? null, input.title ?? null, input.description ?? null, status, input.origin ?? null,
        input.code_ref !== undefined, input.code_ref ?? null, input.source_entity_id !== undefined, input.source_entity_id ?? null, actor]))[0]!
      if (before.status !== status) await recordEvent(sql, task.id, 'status', actor, before.status, status, input.note ? { note: input.note } : {})
      else if (input.note) await recordEvent(sql, task.id, 'note', actor, status, status, { note: input.note })
      else if (before.kind === 'pending') await recordEvent(sql, task.id, 'updated', actor, status, status, {})
    }
    if (input.evidence_ids?.length) {
      await validateEvidence(sql, input.evidence_ids)
      for (const fragment of new Set(input.evidence_ids)) await sql.query('INSERT INTO task_evidence VALUES($1,$2) ON CONFLICT DO NOTHING', [task.id, fragment])
    }
    return task
  })
}

export async function listTasks(store: MemoryStore, raw: unknown) {
  const input = parse(listTasksInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  const params = [input.project_id ?? null, input.kind ?? null, input.status === 'open' ? OPEN : input.status ? [input.status] : null, input.query ?? '']
  const where = `($1::uuid IS NULL OR t.project_id=$1) AND ($2::text IS NULL OR t.kind=$2) AND ($3::text[] IS NULL OR t.status=ANY($3))
    AND ($4::text='' OR t.title ILIKE '%'||$4||'%' OR t.external_key ILIKE $4||'%' OR t.description ILIKE '%'||$4||'%')`
  const items = await store.db.query(`SELECT t.*,p.title AS project_title,src.title AS source_title,
    (SELECT count(*)::int FROM task_evidence te WHERE te.task_id=t.id) AS evidence_count,
    (SELECT jsonb_build_object('action',ev.action,'actor',ev.actor,'detail',ev.detail,'created_at',ev.created_at) FROM task_events ev WHERE ev.task_id=t.id ORDER BY ev.id DESC LIMIT 1) AS last_event
    FROM tasks t LEFT JOIN entities p ON p.id=t.project_id LEFT JOIN entities src ON src.id=t.source_entity_id WHERE ${where}
    ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,t.updated_at DESC,t.id LIMIT $5 OFFSET $6`, [...params, input.limit, input.offset])
  const total = (await store.db.query(`SELECT count(*)::int AS total FROM tasks t WHERE ${where}`, params))[0]!.total
  const counts = await store.db.query(`SELECT kind,status,count(*)::int AS count FROM tasks t WHERE ($1::uuid IS NULL OR t.project_id=$1) GROUP BY kind,status`, [input.project_id ?? null])
  return { items, total, limit: input.limit, offset: input.offset, counts }
}

export async function taskDetail(store: MemoryStore, taskId: string) {
  const task = (await store.db.query('SELECT t.*,p.title AS project_title FROM tasks t LEFT JOIN entities p ON p.id=t.project_id WHERE t.id=$1', [parse(id, taskId)]))[0]
  check(task, 'Tarea inexistente', 404)
  const [events, evidence, notes] = await Promise.all([
    store.db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY id DESC LIMIT 100', [taskId]),
    store.db.query(`SELECT f.id,f.text,f.version_id,s.entity_id,e.title FROM task_evidence te JOIN fragments f ON f.id=te.fragment_id JOIN versions v ON v.id=f.version_id
      JOIN sources s ON s.id=v.source_id JOIN entities e ON e.id=s.entity_id WHERE te.task_id=$1 ORDER BY f.ordinal`, [taskId]),
    store.db.query('SELECT * FROM agent_notes WHERE task_id=$1 ORDER BY updated_at DESC LIMIT 30', [taskId]),
  ])
  return { task, events, evidence, notes }
}

/** Numbers for the project health view; every series is computed from task_events so it reflects history, not only the current state. */
export async function taskStats(store: MemoryStore, raw: unknown) {
  const input = parse(taskStatsInput, raw)
  if (input.project_id) await requireEntity(store.db, input.project_id, 'project')
  const scope = [input.project_id ?? null]
  const [byStatus, weekly, leadTime, stale, assignees, origins, agents, recent] = await Promise.all([
    store.db.query('SELECT kind,status,count(*)::int AS count FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1) GROUP BY kind,status ORDER BY kind,status', scope),
    store.db.query(`WITH weeks AS (SELECT generate_series(date_trunc('week',now())-make_interval(weeks=>$2-1),date_trunc('week',now()),interval '1 week') AS week)
      SELECT w.week,
        (SELECT count(*)::int FROM task_events ev JOIN tasks t ON t.id=ev.task_id WHERE ($1::uuid IS NULL OR t.project_id=$1) AND ev.action='created' AND date_trunc('week',ev.created_at)=w.week) AS created,
        (SELECT count(*)::int FROM task_events ev JOIN tasks t ON t.id=ev.task_id WHERE ($1::uuid IS NULL OR t.project_id=$1) AND ev.status_after IN ('done','dropped')
          AND COALESCE(ev.status_before,'') NOT IN ('done','dropped') AND date_trunc('week',ev.created_at)=w.week) AS closed
      FROM weeks w ORDER BY w.week`, [...scope, input.weeks]),
    store.db.query(`SELECT kind,round(avg(EXTRACT(EPOCH FROM closed_at-created_at))/86400,1)::float8 AS avg_days,count(*)::int AS closed
      FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1) AND status='done' AND closed_at IS NOT NULL GROUP BY kind`, scope),
    store.db.query(`SELECT id,kind,title,external_key,status,updated_at,count(*) OVER()::int AS total FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1) AND status=ANY($2)
      AND updated_at<now()-interval '21 days' ORDER BY updated_at LIMIT 20`, [...scope, OPEN]),
    store.db.query(`SELECT COALESCE(assignee,'Sin asignar') AS assignee,count(*) FILTER(WHERE status=ANY($2))::int AS open,count(*) FILTER(WHERE status='done')::int AS done
      FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1) AND kind='jira' GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 20`, [...scope, OPEN]),
    store.db.query(`SELECT origin,count(*) FILTER(WHERE status=ANY($2))::int AS open,count(*) FILTER(WHERE status='done')::int AS done
      FROM tasks WHERE ($1::uuid IS NULL OR project_id=$1) AND kind='pending' GROUP BY 1 ORDER BY 2 DESC`, [...scope, OPEN]),
    store.db.query(`SELECT agent_label,cli_kind,count(*)::int AS notes,max(updated_at) AS last_note FROM agent_notes
      WHERE ($1::uuid IS NULL OR project_id=$1) AND created_at>now()-interval '30 days' GROUP BY 1,2 ORDER BY 4 DESC LIMIT 20`, scope),
    store.db.query(`SELECT ev.action,ev.actor,ev.status_before,ev.status_after,ev.created_at,t.title,t.external_key,t.kind FROM task_events ev JOIN tasks t ON t.id=ev.task_id
      WHERE ($1::uuid IS NULL OR t.project_id=$1) ORDER BY ev.id DESC LIMIT 30`, scope),
  ])
  const count = (kind: string | null, statuses: string[]) => byStatus.filter(r => (!kind || r.kind === kind) && statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0)
  const lastTwoWeeks = weekly.slice(-2)
  return {
    generated_at: new Date().toISOString(), weeks: input.weeks, by_status: byStatus,
    summary: { open: count(null, OPEN), in_progress: count(null, ['in_progress']), blocked: count(null, ['blocked']), done: count(null, ['done']), dropped: count(null, ['dropped']),
      jira_open: count('jira', OPEN), pending_open: count('pending', OPEN), stale_open: stale[0]?.total ?? 0,
      created_last_2_weeks: lastTwoWeeks.reduce((sum, w) => sum + w.created, 0), closed_last_2_weeks: lastTwoWeeks.reduce((sum, w) => sum + w.closed, 0) },
    weekly, lead_time: leadTime, stale, assignees, origins, agents, recent,
  }
}
