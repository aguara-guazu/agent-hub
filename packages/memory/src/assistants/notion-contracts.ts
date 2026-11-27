import {
  notionId,
  projectContracts,
  type Evidence,
  type Profile,
  type ProjectContract,
  type ProjectContracts,
  type Signal,
} from './contracts.js'
import type { MemoryDatabase, Sql } from '../database.js'
import { readPolicy } from './portfolio.js'
import { digest } from './slack.js'
import { readNotionContracts, type NotionContractRow, type NotionRead } from './notion-reader.js'
import { assignedToOwner, issueEvidence, recentJira, type LiveIssue } from './jira.js'
import { mapJiraStatus } from '../projects/tasks.js'
import { occupiesCalendar } from '../connectors/calendar-window.js'

const minute = 60_000
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000
export const contractEnd = (c: ProjectContract) => c.closed ?? c.extension ?? c.end
export const recentContract = (
  now: string,
  alias = 'c',
) => `EXISTS(SELECT 1 FROM entities np, json_each(np.data,'$.notion_contracts.items') nc
  WHERE np.id=${alias}.project_id AND np.data->>'$.notion_contracts.status'='verified' AND nc.value->>'id'=${alias}.source->>'contract_id'
  AND ${alias}.source->>'due_at'=CASE WHEN ${alias}.source_key LIKE '%/start' THEN nc.value->>'start'
    ELSE coalesce(nc.value->>'closed',nc.value->>'extension',nc.value->>'end') END
  AND (julianday(${now})-julianday(np.data->>'$.notion_contracts.verified_at'))*1440 BETWEEN 0 AND 60)`

interface Project {
  id: string
  title: string
  binding: string | null
  aliases: string[]
  company: string | null
}
async function trackedProjects(sql: Sql) {
  return sql.query<Project>(`SELECT e.id,e.title,p.config->>'notion_project' AS binding,coalesce(e.data->'aliases','[]') AS "aliases:json",
    (SELECT c.title FROM links l JOIN entities c ON c.id=l.to_id AND c.kind='company' WHERE l.from_id=e.id AND l.type='company' LIMIT 1) AS company
    FROM entities e JOIN assistant_profiles p ON p.project_id=e.id WHERE e.kind='project' AND p.config->>'active'=1
    AND e.data->>'memory_state' IS NOT 'archived' AND e.data->>'merged_into' IS NULL AND e.id NOT IN(SELECT project_id FROM archived_projects) ORDER BY e.id`)
}
function assignments(projects: Project[], rows: NotionContractRow[]) {
  const result = new Map<string, ProjectContract[]>(),
    identities = new Map<string, Set<string>>()
  for (const row of rows)
    for (const ref of row.projects) {
      if (!ref.id || !ref.name) continue
      const name = normalize(ref.name),
        ids = identities.get(name) ?? new Set<string>()
      ids.add(ref.id)
      identities.set(name, ids)
    }
  for (const { projects: refs, ...contract } of rows) {
    const matched = new Set<string>()
    for (const ref of refs) {
      let matches = ref.id ? projects.filter((p) => p.binding && notionId(p.binding) === ref.id) : []
      if (!matches.length) {
        const name = normalize(ref.name)
        if (!name || (identities.get(name)?.size ?? 0) > 1) continue
        const eligible = projects.filter((p) => !p.binding)
        matches = eligible.filter((p) =>
          [p.title, ...(Array.isArray(p.aliases) ? p.aliases : [])].some((v) => typeof v === 'string' && normalize(v) === name),
        )
        if (!matches.length) matches = eligible.filter((p) => p.company && normalize(p.company) === name)
      }
      if (matches.length === 1) matched.add(matches[0]!.id)
    }
    for (const id of matched) {
      const contracts = result.get(id) ?? []
      contracts.push(contract)
      result.set(id, contracts)
    }
  }
  return result
}

export async function forgetContracts(sql: Sql, project?: string) {
  await sql.query(
    "UPDATE entities SET data=json_remove(data,'$.notion_contracts') WHERE kind='project' AND json_type(data,'$.notion_contracts') IS NOT NULL AND ($1 IS NULL OR id=$1)",
    [project ?? null],
  )
  await sql.query(
    "UPDATE assistant_cases SET state='closed',fingerprint='',revision=revision+1,updated_at=now() WHERE kind='contract' AND state='open' AND ($1 IS NULL OR project_id=$1)",
    [project ?? null],
  )
  await sql.query(
    `UPDATE assistant_work SET state='cancelled',updated_at=now() WHERE state IN ('queued','running','paused','blocked')
    AND (request_key LIKE 'attention/%' OR request_key LIKE 'child/%') AND case_id IN(SELECT id FROM assistant_cases WHERE kind='contract' AND ($1 IS NULL OR project_id=$1))`,
    [project ?? null],
  )
}

export class ContractTracker {
  private completed = new Map<string, { at: number; evidence: Evidence[] }>()
  private last: { key: string; at: number; error: string } | undefined
  private pending: Promise<string> | undefined
  private abort = new AbortController()
  constructor(
    readonly db: MemoryDatabase,
    readonly read: NotionRead | undefined,
    readonly enabled: () => boolean,
    readonly now: () => Date,
  ) {}

  invalidate() {
    this.abort.abort()
    this.abort = new AbortController()
    this.last = undefined
    this.pending = undefined
    this.completed.clear()
  }
  clearProgress(project: string) {
    this.completed.delete(project)
  }
  recordProgress(project: string, p: Profile, issues: LiveIssue[] | null) {
    this.clearProgress(project)
    if (!issues) return
    const completed = issues
      .filter((i) => (p.jira_assignee_scope === 'project' || assignedToOwner(p, i)) && mapJiraStatus(i.status, i.category) === 'done')
      .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
      .slice(0, 5)
    this.completed.set(project, { at: +this.now(), evidence: completed.map(issueEvidence) })
  }
  async refresh(force = false): Promise<string> {
    if (!this.enabled()) return ''
    if (this.pending) return this.pending
    const operation = this.sync(force, this.abort.signal)
    this.pending = operation
    try {
      return await operation
    } finally {
      if (this.pending === operation) this.pending = undefined
    }
  }
  private async sync(force: boolean, signal: AbortSignal) {
    const settings = (await readPolicy(this.db)).config.notion_contracts
    if (!settings.areas.length || !settings.database) return ''
    const projects = await trackedProjects(this.db)
    if (!projects.length) return ''
    const key = digest([settings, projects]),
      now = this.now()
    if (!force && this.last?.key === key && +now - this.last.at < (this.last.error ? 2 : 15) * minute) return this.last.error
    let error = '',
      found: Map<string, ProjectContract[]> | undefined
    try {
      if (!this.read) throw new Error('Conectá Notion en Servidores MCP para verificar los contratos')
      found = assignments(projects, await readNotionContracts(this.read, settings, signal))
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : 'Notion no pudo verificar los contratos'
    }
    if (signal.aborted || !this.enabled()) return ''
    const saved = await this.db.transaction(async (sql) => {
      if (
        signal.aborted ||
        !this.enabled() ||
        digest([(await readPolicy(sql)).config.notion_contracts, await trackedProjects(sql)]) !== key
      )
        return
      for (const p of projects) {
        if (!found) {
          await sql.query(
            `UPDATE entities SET data=json_set(data,'$.notion_contracts.status','unavailable') WHERE id=$1 AND data->>'$.notion_contracts.status'='verified'`,
            [p.id],
          )
          continue
        }
        const items = (found.get(p.id) ?? []).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.id.localeCompare(b.id))
        if (items.length)
          await sql.query("UPDATE entities SET data=json_set(data,'$.notion_contracts',json($2)) WHERE id=$1", [
            p.id,
            { items, verified_at: now.toISOString(), status: 'verified' } satisfies ProjectContracts,
          ])
        else
          await sql.query(
            "UPDATE entities SET data=json_remove(data,'$.notion_contracts') WHERE id=$1 AND json_type(data,'$.notion_contracts') IS NOT NULL",
            [p.id],
          )
      }
      return true
    })
    if (saved && !signal.aborted) this.last = { key, at: +now, error }
    return error
  }
  async project(id: string): Promise<{ items: ProjectContract[]; remote: boolean }> {
    if (!this.enabled()) return { items: [], remote: false }
    const [p] = await this.db.query(
      `SELECT data->'notion_contracts' AS "contracts:json", data->>'remote_processing' AS permission FROM entities WHERE id=$1`,
      [id],
    )
    const snapshot = projectContracts.safeParse(p?.contracts).data
    const fresh = snapshot?.status === 'verified' && +this.now() - Date.parse(snapshot.verified_at) <= 60 * minute
    return { items: fresh ? snapshot!.items : [], remote: ![0, false, 'false'].includes(p?.permission) }
  }
  async evidence(project: string) {
    await this.refresh()
    const { items, remote } = await this.project(project)
    return items.map((item) => contractEvidence(item, remote))
  }

  async activities(project: string): Promise<Evidence[]> {
    if (!this.enabled()) return []
    const completed = this.completed.get(project)
    const iso = this.now().toISOString()
    const meetings = await this.db.query(
      `SELECT e.id,e.title,e.data,s.url,
      (coalesce(e.data->>'remote_processing' IN (0,'false'),0) OR coalesce(c.config->>'remote_processing' IN (0,'false'),0)
      OR EXISTS(SELECT 1 FROM links lp JOIN entities p ON p.id=lp.to_id WHERE lp.from_id=e.id AND lp.type='project' AND p.data->>'remote_processing' IN (0,'false'))) AS private
      FROM entities e JOIN links l ON l.from_id=e.id AND l.type='project' AND l.to_id=$1 AND coalesce(l.data->>'proposed',0)=0
      JOIN sources s ON s.entity_id=e.id AND s.status='active' LEFT JOIN connectors c ON c.id=s.connector_id
      WHERE e.kind='event' AND (s.connector_id IS NULL OR c.enabled=1)
      AND julianday(e.data->>'occurred_at') BETWEEN julianday($2) AND julianday($2,'+14 days')
      ORDER BY e.data->>'occurred_at',e.id LIMIT 20`,
      [project, iso],
    )
    const issues = await this.db.query(
      `SELECT c.title,c.source FROM assistant_cases c WHERE c.project_id=$1 AND c.kind='jira' AND c.state='open'
      AND ${recentJira('$2')} ORDER BY c.score DESC,c.updated_at DESC,c.id LIMIT 5`,
      [project, iso],
    )
    return [
      ...(completed && +this.now() - completed.at < 15 * minute ? completed.evidence : []),
      ...meetings
        .filter((e) => occupiesCalendar({ ...e.data, start: e.data.scheduled_start }))
        .slice(0, 5)
        .map((e) => ({
          id: 'calendar/' + e.id,
          title: e.title,
          at: e.data.occurred_at,
          url: e.url || '/#/memory/entities/' + e.id,
          text: 'Actividad prevista en el calendario del proyecto el ' + e.data.occurred_at,
          remote: !e.private,
        })),
      ...issues.map((i) => ({
        id: 'jira/' + i.source.jira_scope_site + '/' + i.source.issue_key,
        title: i.title,
        at: i.source.at,
        url: i.source.url,
        text: 'Estado observado en Jira: ' + i.source.status + (i.source.due_at ? '. Vencimiento: ' + i.source.due_at : ''),
        remote: i.source.remote !== false,
      })),
    ]
  }
}

export function contractEvidence(c: ProjectContract, remote: boolean): Evidence {
  const dates = [
    ['Inicio', c.start],
    ['Fin previsto', c.end],
    ['Prórroga hasta', c.extension],
    ['Cierre registrado', c.closed],
  ].filter((v) => v[1])
  return {
    id: 'notion/' + c.id,
    title: c.title,
    url: c.url,
    at: c.start ?? c.end ?? '',
    text: ['Contrato de ' + c.areas.join(', '), ...dates.map(([label, date]) => label + ' ' + date)].join(' · '),
    remote,
  }
}

export function contractSignals(items: ProjectContract[], today: string, remote: boolean): Signal[] {
  const result: Signal[] = []
  for (const c of items) {
    const end = contractEnd(c)
    for (const milestone of ['start', 'end'] as const) {
      const date = milestone === 'start' ? c.start : end
      if (!date || (c.closed && c.closed <= today)) continue
      const delta = days(today, date)
      if (milestone === 'start' ? delta < 0 || delta > 7 : delta < -7 || delta > 14) continue
      const stage = delta < 0 ? 'past' : delta === 0 ? 'today' : delta <= 3 ? 'near' : 'upcoming'
      const label = milestone === 'start' ? 'Inicio contractual' : 'Fin contractual previsto'
      const reason = milestone === 'end' && delta < 0 ? 'Pasó la fecha prevista y Notion aún no registra un cierre' : label
      const evidence = contractEvidence(c, remote)
      result.push({
        key: 'contract/' + c.id + '/' + milestone,
        kind: 'contract',
        title: label + ' · ' + c.title,
        at: date,
        url: c.url,
        text: evidence.text,
        score: delta <= 3 ? 8 : 6,
        reasons: [reason + ' · ' + date],
        evidence: [evidence],
        fingerprint: digest([c, milestone, stage]),
        source: { url: c.url, contract_id: c.id, due_at: date, remote },
      })
    }
  }
  return result
}

/** Choose the relevant contractual window for an activity; overlapping scopes can both supply evidence. */
export function withContractContext(s: Signal, items: ProjectContract[], today: string, remote: boolean): Signal {
  if (!items.length || !['jira', 'meeting'].includes(s.kind)) return s
  const date = (s.kind === 'meeting' ? s.source.calendar_day : s.source.due_at)?.slice(0, 10) || today
  const covering = items.filter((c) => (!c.start || c.start <= date) && (!contractEnd(c) || contractEnd(c)! >= date))
  const sorted = [...items].sort(
    (a, b) =>
      Math.min(...[a.start, contractEnd(a)].filter(Boolean).map((d) => Math.abs(days(date, d!)))) -
      Math.min(...[b.start, contractEnd(b)].filter(Boolean).map((d) => Math.abs(days(date, d!)))),
  )
  const chosen = covering.length ? covering : sorted.slice(0, 1)
  const extra = chosen.map((c) => contractEvidence(c, remote))
  const reasons = [...s.reasons]
  for (const c of chosen) {
    const end = contractEnd(c)
    if (end && date > end)
      reasons.push(
        (s.kind === 'meeting' ? 'La reunión' : s.source.due_at ? 'El vencimiento de Jira' : 'La tarea sigue abierta') +
          ' queda después del fin del contrato de ' +
          c.areas.join(', ') +
          ' (' +
          end +
          ')',
      )
    else if (c.start && date < c.start) reasons.push('La actividad está prevista antes del inicio contractual del ' + c.start)
    else if (end)
      reasons.push(
        'El contrato de ' + c.areas.join(', ') + ' tiene fecha de ' + (c.closed ? 'cierre registrado ' : 'fin prevista ') + end,
      )
  }
  return {
    ...s,
    reasons,
    score: Math.min(10, s.score + Number(!covering.length)),
    evidence: [...(s.evidence ?? []), ...extra],
    text: [s.text, ...extra.map((e) => e.text)].join('\n'),
    fingerprint: digest([s.fingerprint, extra, reasons]),
  }
}
