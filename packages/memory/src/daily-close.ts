import { hash } from './store.js'
import type { DailyDeps, ProposedEffect, ProposedItem, PublicItem } from './daily-types.js'
import { DEFAULT_WORKDAY_HOURS, clip, dayLabel, endOfLocalDay, localTime, plural, startOfLocalDay } from './daily-types.js'
import { HOURS_SYSTEM, collectHoursInputs, estimateWriter, formatHours, hoursPayload, hoursSynthesisSchema, estimateId, finishEstimates, type HourEstimateDraft, type HoursInputs, type HoursSynthesis } from './hours-estimate.js'

export const closeSynthesisSchema = hoursSynthesisSchema
export const CLOSE_SYSTEM = HOURS_SYSTEM
const CONFIDENCE: Record<HourEstimateDraft['confidence'], string> = { high: 'alta', medium: 'media', low: 'baja' }

/** `verified`: Jira confirmed the owner as assignee just now; `unverified`: it could not be read, and execution re-checks it. */
export type Assignment = 'verified' | 'unverified'
export interface CloseNote { id: string; task_id: string; key: string; title: string; text: string; at: string; assignment: Assignment }
export interface CloseProject {
  project_id: string; title: string; site: string | null
  hours: HoursInputs | null
  /** Assignment of each candidate task as seen at collection time. */
  assignments: Record<string, Assignment>
  transitions: CloseNote[]
  comments: CloseNote[]
  unattributed_notes: number
  meetings: { title: string; at: string }[]
}
export interface ClosePackage {
  scheduled_for: string; window: { since: string; until: string }; owner_account_id: string | null
  projects: CloseProject[]; pushes: ProposedItem[]; workday_seconds: number
  gaps: string[]
}
export interface CloseDraft {
  title: string; body_md: string; items: PublicItem[]; proposed_effects: ProposedEffect[]
  /** Run-scoped writers for the persist phase: the hour proposals behind the H items. */
  writers: { write(sql: import('./database.js').Sql): Promise<unknown> }[]
  estimates: HourEstimateDraft[]
}

/** Keeps candidates the mirror assigns to the owner and confirms them against Jira; one reassigned elsewhere drops out. */
async function confirmAssignment(deps: DailyDeps, account: string | null, keys: string[]): Promise<Map<string, Assignment>> {
  const out = new Map<string, Assignment>()
  for (const key of keys) {
    if (!account || !deps.jira) { out.set(key, 'unverified'); continue }
    const seen = await deps.jira.assigneeOf(key).catch(() => ({ accountId: null, verified: false }))
    if (seen.verified && seen.accountId && seen.accountId !== account) continue
    out.set(key, seen.verified && seen.accountId === account ? 'verified' : 'unverified')
  }
  return out
}

/**
 * Gathers the close for one owner: only projects the owner activated, only Jira issues the mirror assigns to them, each confirmed with Jira when possible.
 * Without the owner's Jira identity no write candidate is produced and the gap is reported instead of guessed.
 */
export async function collectClose(deps: DailyDeps, input: { scheduledFor: string; coveredSince: string | null }): Promise<ClosePackage> {
  const gaps: string[] = []
  const until = deps.now().toISOString()
  const since = input.coveredSince ?? startOfLocalDay(input.scheduledFor).toISOString()
  const window = { since, until }
  const activated = deps.attention?.activated_projects ? await deps.attention.activated_projects().catch(() => { gaps.push('proyectos activados'); return [] as string[] }) : (gaps.push('proyectos activados'), [] as string[])
  const live = new Set(await deps.statusProjects())
  const ids = activated.filter(id => live.has(id))
  const account = await deps.jira?.ownerAccountId().catch(() => null) ?? null
  if (!account) gaps.push('identidad de Jira del dueño')
  const rows = ids.length ? await deps.store.db.query<{ id: string; title: string; site: string | null }>(
    `SELECT id,title,NULLIF(data->>'jira_site_url','') AS site FROM entities WHERE kind='project' AND id IN (SELECT value FROM json_each($1)) ORDER BY title,id`, [JSON.stringify(ids)]) : []
  const projects: CloseProject[] = []
  for (const row of rows) {
    const hours = account ? await collectHoursInputs(deps.store, row.id, window) : null
    const mine = account ? new Set((await deps.store.db.query<{ id: string }>('SELECT id FROM tasks WHERE project_id=$1 AND kind=\'jira\' AND assignee_account_id=$2', [row.id, account])).map(task => task.id)) : new Set<string>()
    if (hours) hours.tasks = hours.tasks.filter(task => mine.has(task.task_id))
    const noteQuery = (state: string, reason: string) => deps.store.db.query<{ id: string; task_id: string; key: string; title: string; text: string; at: string }>(`SELECT n.id,n.task_id,t.external_key AS key,t.title,n.text,n.updated_at AS at
      FROM agent_notes n JOIN tasks t ON t.id=n.task_id WHERE n.project_id=$1 AND t.kind='jira' AND t.status IN ('todo','in_progress','blocked') AND n.state=$2 ${reason}
        AND n.updated_at>=$3 AND n.updated_at<$4 ORDER BY n.updated_at,n.id`, [row.id, state, since, until])
    // Only an explicit close counts as finished work; a note closed by inactivity says nothing about the task.
    const [done, blocked] = account ? await Promise.all([noteQuery('done', "AND n.finish_reason='explicit'"), noteQuery('blocked', '')]) : [[], []]
    const candidates = [...done, ...blocked].filter(note => mine.has(note.task_id))
    const keys = [...new Set([...(hours?.tasks.map(task => task.key) ?? []), ...candidates.map(note => note.key)])]
    const confirmed = await confirmAssignment(deps, account, keys)
    const assignmentOf = (key: string): Assignment | null => confirmed.get(key) ?? null
    if (hours) hours.tasks = hours.tasks.filter(task => assignmentOf(task.key) !== null)
    const toNote = (note: (typeof done)[number]): CloseNote | null => { const assignment = assignmentOf(note.key); return assignment ? { ...note, assignment } : null }
    const unattributed = (await deps.store.db.query('SELECT count(*) AS n FROM agent_notes WHERE project_id=$1 AND task_id IS NULL AND updated_at>=$2 AND updated_at<$3', [row.id, since, until]))[0]?.n ?? 0
    const meetings = await deps.store.db.query<{ title: string; at: string }>(`SELECT e.title,strftime('%Y-%m-%dT%H:%M:%fZ',e.data->>'occurred_at') AS at FROM entities e JOIN links l ON l.from_id=e.id AND l.to_id=$1 AND l.type='project'
      WHERE e.kind='event' AND COALESCE(e.data->>'status','')<>'cancelled' AND strftime('%Y-%m-%dT%H:%M:%fZ',e.data->>'occurred_at')>=$2 AND strftime('%Y-%m-%dT%H:%M:%fZ',e.data->>'occurred_at')<$3 ORDER BY at`,
    [row.id, startOfLocalDay(input.scheduledFor).toISOString(), endOfLocalDay(input.scheduledFor).toISOString()])
    projects.push({ project_id: row.id, title: row.title, site: row.site, hours, assignments: Object.fromEntries(confirmed), transitions: done.map(toNote).filter((n): n is CloseNote => n !== null),
      comments: blocked.map(toNote).filter((n): n is CloseNote => n !== null), unattributed_notes: unattributed, meetings })
  }
  const pushes = deps.attention?.push_candidates ? (await deps.attention.push_candidates().catch(() => { gaps.push('pushes pendientes'); return [] as ProposedItem[] })).filter(item => ids.includes(item.project_id)) : (gaps.push('pushes pendientes'), [])
  return { scheduled_for: input.scheduledFor, window, owner_account_id: account, projects, pushes, gaps,
    workday_seconds: Math.round((deps.options?.workday_hours ?? DEFAULT_WORKDAY_HOURS) * 3600) }
}

/** Content the synthesis run sees: the hours inputs of each project, minus any project the remote model may not receive. */
export function closePayload(pkg: ClosePackage, remote: boolean) {
  const allowed = pkg.projects.filter(project => project.hours && !(remote && project.hours.project.remote_excluded))
  return { projects: allowed.map(project => ({ ...hoursPayload(project.hours!), meetings: project.meetings })), skipped_remote: pkg.projects.filter(project => project.hours && remote && project.hours.project.remote_excluded).map(project => project.project_id) }
}

/** True when there is something the model must estimate; with nothing to estimate the synthesize phase is skipped. */
export const closeNeedsSynthesis = (pkg: ClosePackage, remote: boolean) => closePayload(pkg, remote).projects.some(project => project.tasks.length > 0)

const digestOf = (effect: Record<string, unknown>) => hash(effect)

/**
 * Deterministic rendering of the close. Numbering is one global sequence per occurrence (project title, then H, T, C, P) so a reply like «1,3» is unambiguous.
 * The model contributes only the hour estimates; every effect carries exactly what will be sent to Jira if approved.
 */
export function renderClose(pkg: ClosePackage, synthesis: HoursSynthesis | null, model: string | null, runId: string): CloseDraft {
  const scheduled = new Date(pkg.scheduled_for)
  const title = `Cierre · ${dayLabel(scheduled)} · ${localTime(scheduled)}`
  const items: PublicItem[] = [], effects: ProposedEffect[] = [], estimates: HourEstimateDraft[] = []
  const blocks: string[] = []
  const marker = `Estimación aprobada vía Agent Hub · cierre ${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}`
  let totalSeconds = 0, hourTasks = 0
  const push = (project: CloseProject | { project_id: string }, kind: PublicItem['kind'], summary: string, effect: Record<string, unknown>, estimateRef?: string) => {
    const ordinal = items.length + 1
    items.push({ ordinal, kind, project_id: project.project_id, summary, effect_digest: digestOf(effect), ...(estimateRef ? { estimate_id: estimateRef } : {}) } as PublicItem)
    effects.push({ ordinal, effect })
    return ordinal
  }
  for (const project of pkg.projects) {
    const lines: string[] = []
    const drafts = project.hours ? finishEstimates(project.hours, synthesis, model) : []
    estimates.push(...drafts)
    const flag = (assignment: Assignment | undefined) => assignment === 'unverified' ? ' · asignación sin verificar' : ''
    if (drafts.length) lines.push('_Estimación del agente, no medición._')
    for (const draft of drafts) {
      const id = estimateId(runId, draft.task_id), task = project.hours!.tasks.find(candidate => candidate.task_id === draft.task_id)!
      const detail = `${task.key} ${clip(task.title, 120)} — Estimación del agente: ${formatHours(draft.estimated_seconds)} · confianza ${CONFIDENCE[draft.confidence]} · Base: ${clip(draft.basis, 300)}`
        + ` · Supuestos: ${draft.assumptions.length ? draft.assumptions.map(a => clip(a, 160)).join('; ') : 'ninguno'} · Cambiaría si: ${clip(draft.changes_if, 200)}${draft.adjusted_by_corrections ? ' · ajustada por tus correcciones anteriores' : ''}${flag(project.assignments[task.key])}`
      const n = push(project, 'jira_worklog', detail, { kind: 'jira_worklog', site: task.site || project.site, issue_key: task.key, account_id: pkg.owner_account_id, seconds: draft.estimated_seconds, started: project.hours!.window.since, marker, estimate_id: id }, id)
      lines.push(`${n}. ${detail}`)
      totalSeconds += draft.estimated_seconds; hourTasks++
    }
    for (const note of project.transitions) {
      const text = `${note.key} → "Hecho" · Evidencia: nota ${localTime(note.at)} "${clip(note.text, 160)}"${flag(note.assignment)}`
      lines.push(`${push(project, 'jira_transition', text, { kind: 'jira_transition', site: project.site, issue_key: note.key, account_id: pkg.owner_account_id, to_category: 'done', to_name: null, evidence_ref: note.id })}. ${text}`)
    }
    for (const note of project.comments) {
      const comment = clip(note.text, 300)
      const text = `${note.key} comentar: "${comment}"${flag(note.assignment)}`
      lines.push(`${push(project, 'jira_comment', text, { kind: 'jira_comment', site: project.site, issue_key: note.key, account_id: pkg.owner_account_id, text: comment, evidence_ref: note.id })}. ${text}`)
    }
    for (const item of pkg.pushes.filter(candidate => candidate.project_id === project.project_id)) {
      const n = push(project, 'git_push', item.summary, item.effect)
      lines.push(`${n}. ${item.summary}`)
    }
    if (project.unattributed_notes) lines.push(`_${plural(project.unattributed_notes, 'nota sin task_id', 'notas sin task_id')}: no se pueden atribuir horas a un ticket._`)
    if (project.hours && !drafts.length && project.hours.tasks.length) lines.push('_Horas no estimadas: no hay un modelo permitido para estos datos._')
    if (lines.length) blocks.push(`### ${project.title}\n${lines.join('\n')}`)
  }
  const footer = hourTasks ? [`Total estimado: ${formatHours(totalSeconds)} en ${plural(hourTasks, 'ticket', 'tickets')}`, ...(totalSeconds > pkg.workday_seconds ? ['Atención: supera tu jornada configurada.'] : [])] : []
  const header = [`# ${title}`, `Responde para ejecutar · vence hoy 23:59`]
  const gaps = pkg.gaps.length ? [`_Sin datos de: ${[...new Set(pkg.gaps)].join(', ')}._`] : []
  const body = items.length || blocks.length ? [...header, '', ...blocks, ...(footer.length ? ['', ...footer] : []), ...gaps] : [`# ${title}`, '', 'Sin actividad registrada hoy; nada para proponer.', ...gaps]
  return { title, body_md: body.join('\n'), items, proposed_effects: effects, estimates, writers: estimates.length ? [estimateWriter(runId, estimates)] : [] }
}

export const closeDigest = (pkg: ClosePackage) => hash({ scheduled_for: pkg.scheduled_for, window: pkg.window, projects: pkg.projects.map(project => [project.project_id, project.hours?.tasks.map(task => task.task_id) ?? [], project.transitions.map(note => note.id), project.comments.map(note => note.id)]),
  pushes: pkg.pushes.map(item => item.effect_digest) })
