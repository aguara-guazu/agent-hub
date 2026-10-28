import { hash } from './store.js'
import type { PublicItem, DailyDeps, ProposedEffect, ProposedItem } from './daily-types.js'
import { clip, dayLabel, endOfLocalDay, localDate, localTime, plural, startOfLocalDay } from './daily-types.js'
import type { SnapshotCoverage, StatusDeterministic, StatusPending, StatusSynthesis, Freshness, SourceWatermark, StatusSource } from './project-status.js'

const MAX_ATTENTION_LINES = 10
const MAX_PROJECT_CHARS = 1200
const MAX_BRIEF_CHARS = 7000
const LATE_MINUTES = 15
const LONG_WINDOW_DAYS = 7

export interface LatestSnapshot {
  version: number; as_of: string; freshness: Freshness; coverage: SnapshotCoverage; pending: StatusPending[]
  deterministic: StatusDeterministic; synthesis: StatusSynthesis | null; source_watermark: SourceWatermark
}
export interface BriefProject { project_id: string; title: string; snapshot: LatestSnapshot | null }
export interface AttentionEntry { rank: 'a' | 'b' | 'c' | 'd' | 'e' | 'f'; project: string | null; text: string; since: string | null; evidence: string | null }
export interface AgendaEntry { id: string; title: string; at: string; project: string | null }
export interface BriefPackage {
  scheduled_for: string; generated_at: string; covered_since: string | null
  projects: BriefProject[]; attention: AttentionEntry[]; agenda: AgendaEntry[]; carryover: ProposedItem[]
  /** Reasons a block could not be built (a reader that is not wired); shown, never silently dropped. */
  gaps: string[]
}
export interface BriefDraft { title: string; body_md: string; items: PublicItem[]; proposed_effects: ProposedEffect[]; snapshot_refs: { project_id: string; version: number }[] }

const SOURCE_NAMES: Record<StatusSource, string> = { jira: 'Jira', slack: 'Slack', calendar: 'Calendar', agents: 'agentes' }
const STATE_TEXT: Record<StatusDeterministic['state'], string> = { on_track: 'sin alertas', at_risk: 'en riesgo', blocked: 'bloqueado', unknown: 'sin datos suficientes' }

async function latestSnapshots(deps: DailyDeps, projectIds: string[]): Promise<Map<string, LatestSnapshot>> {
  if (!projectIds.length) return new Map()
  const rows = await deps.store.db.query(`SELECT s.project_id,s.version,s.as_of,s.freshness,s.coverage AS "coverage:json",s.pending AS "pending:json",s.deterministic AS "deterministic:json",
      s.synthesis AS "synthesis:json",s.source_watermark AS "source_watermark:json" FROM project_status_snapshots s
    WHERE s.project_id IN (SELECT value FROM json_each($1)) AND s.version=(SELECT max(x.version) FROM project_status_snapshots x WHERE x.project_id=s.project_id)`, [JSON.stringify(projectIds)])
  return new Map(rows.map(row => [row.project_id as string, { version: row.version, as_of: row.as_of, freshness: row.freshness, coverage: row.coverage, pending: row.pending ?? [],
    deterministic: row.deterministic, synthesis: row.synthesis ?? null, source_watermark: row.source_watermark }]))
}

async function agenda(deps: DailyDeps, scheduledFor: string): Promise<AgendaEntry[]> {
  const since = startOfLocalDay(scheduledFor).toISOString(), until = endOfLocalDay(scheduledFor).toISOString()
  const at = "strftime('%Y-%m-%dT%H:%M:%fZ',e.data->>'occurred_at')"
  return deps.store.db.query<AgendaEntry>(`SELECT e.id,e.title,${at} AS at,
      (SELECT p.title FROM links l JOIN entities p ON p.id=l.to_id AND p.kind='project' WHERE l.from_id=e.id AND l.type='project' ORDER BY p.title LIMIT 1) AS project
    FROM entities e WHERE e.kind='event' AND COALESCE(e.data->>'status','')<>'cancelled' AND ${at}>=$1 AND ${at}<$2 ORDER BY at,e.id`, [since, until])
}

/** Blocked Jira tasks the mirror assigns to the owner. Labelled «según espejo»: the mirror can lag behind Jira. */
async function blockedForOwner(deps: DailyDeps, projectIds: string[], titles: Map<string, string>): Promise<AttentionEntry[]> {
  const account = await deps.jira?.ownerAccountId().catch(() => null)
  if (!account || !projectIds.length) return []
  const rows = await deps.store.db.query(`SELECT t.project_id,t.external_key AS key,t.title,t.updated_at,t.external_url AS url FROM tasks t
    WHERE t.kind='jira' AND t.status='blocked' AND t.assignee_account_id=$1 AND t.project_id IN (SELECT value FROM json_each($2)) ORDER BY t.updated_at,t.id`, [account, JSON.stringify(projectIds)])
  return rows.map(row => ({ rank: 'b' as const, project: titles.get(row.project_id) ?? null, text: `${row.key} ${clip(row.title, 120)} está bloqueada (según espejo)`, since: row.updated_at, evidence: row.url ?? row.key }))
}

/**
 * Builds what the brief aggregates for one owner: the latest snapshot of every project with a live project_status, plus deterministic blocks.
 * Nothing is read from sources again, and no model is involved. A reader that is not wired leaves its block out and is listed in `gaps`.
 */
export async function collectBrief(deps: DailyDeps, input: { scheduledFor: string; coveredSince: string | null }): Promise<BriefPackage> {
  const ids = await deps.statusProjects()
  const rows = ids.length ? await deps.store.db.query<{ id: string; title: string }>('SELECT id,title FROM entities WHERE kind=\'project\' AND id IN (SELECT value FROM json_each($1)) ORDER BY title,id', [JSON.stringify(ids)]) : []
  const snapshots = await latestSnapshots(deps, rows.map(row => row.id))
  const titles = new Map(rows.map(row => [row.id, row.title]))
  const gaps: string[] = []
  const reader = async (name: keyof NonNullable<DailyDeps['attention']>, label: string) => {
    const fn = deps.attention?.[name] as (() => Promise<{ ref: string; summary: string; at: string }[]>) | undefined
    if (!fn) { gaps.push(label); return [] }
    return fn().catch(() => { gaps.push(label); return [] })
  }
  const line = (rank: AttentionEntry['rank'], prefix: string) => (entry: { ref: string; summary: string; at: string }): AttentionEntry => ({ rank, project: null, text: `${prefix}${clip(entry.summary, 200)}`, since: entry.at, evidence: entry.ref })
  const [pending, incidents, uncertain, overdue] = await Promise.all([
    reader('pending_responses', 'pedidos sin responder'), reader('liveness_incidents', 'incidentes del supervisor'),
    reader('uncertain_deliveries', 'entregas inciertas'), reader('overdue_close', 'cierre vencido')])
  const attention: AttentionEntry[] = [
    ...pending.map(line('a', '')),
    ...await blockedForOwner(deps, rows.map(row => row.id), titles),
    ...incidents.map(line('d', '')),
    ...uncertain.map(line('e', 'en reconciliación: el Hub no pudo confirmar si se ejecutó; revísalo en Entregas — ')),
    ...overdue.map(line('e', 'cierre vencido sin respuesta: no se escribió nada en Jira — ')),
  ].sort((a, b) => a.rank.localeCompare(b.rank))
  const carryover = deps.attention?.carryover_items ? await deps.attention.carryover_items().catch(() => []) : []
  return { scheduled_for: input.scheduledFor, generated_at: deps.now().toISOString(), covered_since: input.coveredSince,
    projects: rows.map(row => ({ project_id: row.id, title: row.title, snapshot: snapshots.get(row.id) ?? null })), attention, agenda: await agenda(deps, input.scheduledFor), carryover, gaps }
}

const stamp = (value: string | null, generatedAt: string) => !value ? null : localDate(value) === localDate(generatedAt) ? localTime(value) : `${localDate(value).slice(8)}/${localDate(value).slice(5, 7)} ${localTime(value)}`

/** Oldest watermark per source across projects; a failed or silent source reads «sin datos desde X». */
function freshnessLine(pkg: BriefPackage): string {
  const parts: string[] = []
  for (const source of Object.keys(SOURCE_NAMES) as StatusSource[]) {
    const snaps = pkg.projects.map(project => project.snapshot).filter((snap): snap is LatestSnapshot => snap !== null)
    const seen = snaps.filter(snap => snap.coverage.sources.some(entry => entry.source === source))
    if (!seen.length) continue
    const marks = seen.map(snap => snap.source_watermark[source]).filter((value): value is string => value !== null)
    const failed = seen.some(snap => snap.coverage.sources.some(entry => entry.source === source && entry.failed))
    const oldest = marks.length === seen.length ? marks.reduce((a, b) => (a < b ? a : b)) : null
    const text = stamp(oldest, pkg.generated_at)
    parts.push(failed || !text ? `${SOURCE_NAMES[source]} sin datos${oldest ? ` desde ${stamp(oldest, pkg.generated_at)}` : ''}` : `${SOURCE_NAMES[source]} ${text}`)
  }
  return parts.join(' · ')
}

function projectBlock(project: BriefProject, generatedAt: string): string {
  const snap = project.snapshot
  if (!snap) return `### ${project.title}\nSin snapshot de status vigente: todavía no corrió el status de este proyecto.`
  const n = snap.deterministic.numbers
  const numbers = `${plural(n.open, 'tarea abierta', 'tareas abiertas')}, ${n.blocked} bloqueadas, ${n.stale_open} sin movimiento, ${n.done_in_window} cerradas en la ventana`
  const head = `### ${project.title} — ${STATE_TEXT[snap.deterministic.state]} · datos al ${stamp(snap.as_of, generatedAt) ?? 'sin datos'}${snap.freshness === 'stale_no_report' ? ' · datos desactualizados' : ''}`
  const reason = snap.freshness === 'excluded_remote' ? 'Resumen no generado: procesamiento remoto desactivado.'
    : snap.coverage.narrative_reason === 'extraction_disabled' ? 'Resumen no generado: no hay un modelo de procesamiento configurado.'
      : snap.coverage.narrative_reason === 'model_failed' ? 'Resumen no generado: el modelo no pudo completarlo.' : snap.coverage.narrative_reason === 'no_activity' ? 'Sin actividad registrada en la ventana.' : null
  const body = snap.synthesis
    ? `**Dónde está.** ${snap.synthesis.where}\n**Qué cambió.** ${snap.synthesis.changed}\n**Qué propone.** ${snap.synthesis.proposes}`
    : `${numbers}.${reason ? `\n${reason}` : ''}`
  const text = `${head}\n${body}`
  return text.length > MAX_PROJECT_CHARS ? `${text.slice(0, MAX_PROJECT_CHARS - 1)}…` : text
}

/** Deterministic rendering of the brief. The only numbered items are the carried-over proposals of the previous close. */
export function renderBrief(pkg: BriefPackage, runId: string): BriefDraft {
  const scheduled = new Date(pkg.scheduled_for), generated = new Date(pkg.generated_at)
  const late = generated.getTime() - scheduled.getTime() > LATE_MINUTES * 60_000
  const title = `Brief · ${dayLabel(scheduled)} · ${localTime(scheduled)} · ${plural(pkg.projects.length, 'proyecto activo', 'proyectos activos')}`
  const header = [`# ${title}`, ...(late ? [`Programado ${localTime(scheduled)} · generado ${localTime(generated)} al encender`] : []), ...(freshnessLine(pkg) ? [`Datos: ${freshnessLine(pkg)}`] : [])]
  const refs = pkg.projects.filter(project => project.snapshot).map(project => ({ project_id: project.project_id, version: project.snapshot!.version }))
  const changed = pkg.projects.some(project => project.snapshot && (project.snapshot.deterministic.numbers.done_in_window > 0 || project.snapshot.coverage.notes > 0 || project.snapshot.coverage.facts > 0))
  if (!pkg.attention.length && !pkg.carryover.length && !changed) {
    const empty = `Sin novedades en ${plural(pkg.projects.length, 'proyecto', 'proyectos')}; nada pendiente.`
    return { title, body_md: [...header, '', empty, ...gapNote(pkg)].join('\n'), items: [], proposed_effects: [], snapshot_refs: refs }
  }
  const sections: string[] = []
  const shown = pkg.attention.slice(0, MAX_ATTENTION_LINES)
  if (shown.length) sections.push(['## Requiere tu acción', ...shown.map(entry => `- ${[entry.project, entry.text, entry.since ? `desde ${stamp(entry.since, pkg.generated_at)}` : null, entry.evidence ? `evidencia: ${entry.evidence}` : null].filter(Boolean).join(' · ')}`),
    ...(pkg.attention.length > shown.length ? [`- …y ${pkg.attention.length - shown.length} más en la app (#/deliveries/${runId})`] : [])].join('\n'))
  sections.push(['## Hoy', ...(pkg.agenda.length ? pkg.agenda.map(event => `- ${localTime(event.at)} ${clip(event.title, 120)}${event.project ? ` · ${event.project}` : ''}`) : ['Sin reuniones en el calendario.'])].join('\n'))
  const windowDays = pkg.covered_since ? Math.ceil((Date.parse(pkg.generated_at) - Date.parse(pkg.covered_since)) / 86_400_000) : null
  const active = (project: BriefProject) => (project.snapshot?.coverage.notes ?? 0) + (project.snapshot?.deterministic.numbers.done_in_window ?? 0)
  const ordered = [...pkg.projects].sort((a, b) => active(b) - active(a) || a.title.localeCompare(b.title))
  sections.push([`## Desde el último brief${windowDays && windowDays > LONG_WINDOW_DAYS ? ` (ventana de ${windowDays} días)` : ''}`, ...ordered.map(project => projectBlock(project, pkg.generated_at))].join('\n\n'))
  const items: PublicItem[] = [], effects: ProposedEffect[] = []
  if (pkg.carryover.length) {
    for (const item of pkg.carryover) {
      const ordinal = items.length + 1
      items.push({ ordinal, kind: item.kind, project_id: item.project_id, summary: item.summary, effect_digest: item.effect_digest, ...(item.estimate_id ? { estimate_id: item.estimate_id } : {}) } as PublicItem)
      effects.push({ ordinal, effect: item.effect })
    }
    sections.push(['## Pendientes de ayer', ...items.map(item => `${item.ordinal}. ${item.summary}`)].join('\n'))
  }
  let body = [...header, '', ...sections, ...gapNote(pkg)].join('\n\n')
  if (body.length > MAX_BRIEF_CHARS) body = `${body.slice(0, MAX_BRIEF_CHARS - 80).trimEnd()}\n\n…el resto está en la app (#/deliveries/${runId})`
  return { title, body_md: body, items, proposed_effects: effects, snapshot_refs: refs }
}

function gapNote(pkg: BriefPackage): string[] {
  return pkg.gaps.length ? [`_Sin datos de: ${[...new Set(pkg.gaps)].join(', ')}._`] : []
}

/** Digest of what the brief shows, for the phase receipt; independent of the run id. */
export const briefDigest = (pkg: BriefPackage) => hash({ scheduled_for: pkg.scheduled_for, projects: pkg.projects.map(project => [project.project_id, project.snapshot?.version ?? null]), attention: pkg.attention, agenda: pkg.agenda.map(event => event.id), carryover: pkg.carryover.map(item => item.effect_digest) })
