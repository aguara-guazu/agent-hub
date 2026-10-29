import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { normalizeJiraIssue } from '../src/tasks.js'
import { renderBrief, type BriefPackage, type BriefProject, type LatestSnapshot } from '../src/daily-brief.js'
import { renderClose, type CloseProject, type ClosePackage } from '../src/daily-close.js'
import { dayLabel } from '../src/daily-types.js'
import { deriveDeterministic, snapshotAsOf, type StatusInputs } from '../src/project-status.js'
import type { HoursSynthesis, WorkedTask } from '../src/hours-estimate.js'

const SCHEDULED = new Date(2026, 9, 29, 8, 0).toISOString()
const DAY = 86_400_000

const snapshot = (numbers: Partial<LatestSnapshot['deterministic']['numbers']> = {}, coverage: { notes?: number; facts?: number } = {}): LatestSnapshot => ({
  version: 1, as_of: SCHEDULED, freshness: 'current', pending: [], synthesis: null,
  coverage: { tasks: 0, facts: coverage.facts ?? 0, notes: coverage.notes ?? 0, sources: [], narrative: 'deterministic', narrative_reason: 'no_activity', window_since: SCHEDULED, input_hash: 'h' },
  deterministic: { state: 'on_track', numbers: { open: 1, in_progress: 0, blocked: 0, done_in_window: 0, stale_open: 0, ...numbers } },
  source_watermark: { jira: null, slack: null, calendar: null, agents: null },
})
const briefPackage = (projects: BriefProject[], coveredSince: string | null): BriefPackage => ({
  scheduled_for: SCHEDULED, generated_at: SCHEDULED, covered_since: coveredSince, context: { trigger: 'clock', deferred_until: null },
  projects, attention: [], agenda: [], due_today: [], carryover: [], gaps: [],
})

describe('brief', () => {
  it('sin novedades devuelve una línea y ningún ítem', () => {
    const draft = renderBrief(briefPackage([{ project_id: 'p1', title: 'Alfa', snapshot: snapshot() }, { project_id: 'p2', title: 'Beta', snapshot: snapshot() }], new Date(Date.parse(SCHEDULED) - DAY).toISOString()), 'run-1')
    expect(draft.body_md).toContain('Sin novedades en 2 proyectos; nada pendiente.')
    expect(draft.body_md).not.toContain('## Desde el último brief')
    expect(draft.items).toEqual([])
    expect(draft.snapshot_refs).toEqual([{ project_id: 'p1', version: 1 }, { project_id: 'p2', version: 1 }])
  })
  it('con novedades cuenta desde covered_since y ordena primero el proyecto con actividad', () => {
    const coveredSince = new Date(Date.parse(SCHEDULED) - DAY).toISOString()
    const draft = renderBrief(briefPackage([{ project_id: 'p1', title: 'Alfa', snapshot: snapshot() }, { project_id: 'p2', title: 'Beta', snapshot: snapshot({ done_in_window: 2 }) }], coveredSince), 'run-1')
    expect(draft.body_md).toContain(`## Desde el último brief (${dayLabel(coveredSince)} 08:00)`)
    expect(draft.body_md).not.toContain('Sin novedades')
    expect(draft.body_md.indexOf('### Beta')).toBeLessThan(draft.body_md.indexOf('### Alfa'))
  })
  it('una ventana de más de siete días se anuncia con su duración', () => {
    const coveredSince = new Date(Date.parse(SCHEDULED) - 10 * DAY).toISOString()
    const draft = renderBrief(briefPackage([{ project_id: 'p1', title: 'Alfa', snapshot: snapshot({}, { notes: 3 }) }], coveredSince), 'run-1')
    expect(draft.body_md).toContain('ventana de 10 días')
  })
})

const statusInputs = (sources: StatusInputs['sources']): StatusInputs => ({
  project: { id: 'p1', title: 'Alfa', description: '', remote_processing: true, created_at: '2026-01-05T12:00:00.000Z' },
  window: { since: '2026-10-15T00:00:00.000Z', until: '2026-10-29T11:00:00.000Z' },
  tasks: [], closed: [], stale: [], blocked: [], facts: [], notes: [], counts: {}, sources, now: '2026-10-29T11:00:00.000Z',
})

describe('status', () => {
  it('as_of usa la creación del proyecto cuando solo reportaron los agentes', () => {
    expect(snapshotAsOf(statusInputs([{ source: 'agents', as_of: '2026-10-29T10:00:00.000Z', failed: false }]))).toBe('2026-01-05T12:00:00.000Z')
  })
  it('as_of es la marca más vieja entre las fuentes sincronizadas e ignora las notas de agentes', () => {
    expect(snapshotAsOf(statusInputs([
      { source: 'jira', as_of: '2026-10-29T09:00:00.000Z', failed: false },
      { source: 'slack', as_of: '2026-10-29T07:30:00.000Z', failed: false },
      { source: 'agents', as_of: '2026-10-20T10:00:00.000Z', failed: false },
    ]))).toBe('2026-10-29T07:30:00.000Z')
  })
  it('sin tareas, notas ni hechos el estado es unknown', () => {
    expect(deriveDeterministic(statusInputs([])).state).toBe('unknown')
  })
})

const worked = (taskId: string, key: string): WorkedTask => ({
  task_id: taskId, key, title: `Tarea ${key}`, status: 'in_progress', issue_type: 'Task', site: 'https://empresa.atlassian.net', assignee: 'Persona',
  events: 1, notes: [{ id: `note-${key}`, text: 'avance', at: SCHEDULED }], note_count: 1, first_at: SCHEDULED, last_at: SCHEDULED, siblings: [],
})
const closeProject = (projectId: string, title: string, tasks: WorkedTask[], extra: Partial<CloseProject> = {}): CloseProject => ({
  project_id: projectId, title, site: 'https://empresa.atlassian.net',
  hours: { project: { id: projectId, title, remote_excluded: false }, window: { since: new Date(2026, 9, 29).toISOString(), until: SCHEDULED }, tasks, corrections: [] },
  assignments: Object.fromEntries(tasks.map(task => [task.key, 'verified'])), comments: [], unattributed_notes: 0, meetings: [], ...extra,
})
const closePackage = (projects: CloseProject[], pushes: ClosePackage['pushes'] = []): ClosePackage => ({
  scheduled_for: SCHEDULED, window: { since: new Date(2026, 9, 29).toISOString(), until: SCHEDULED }, owner_account_id: 'acc-owner', extended_from: null,
  projects, pushes, workday_seconds: 9 * 3600, gaps: [],
})
const estimate = (taskId: string, seconds: number, transition: { to_category: 'done'; basis: string } | null): HoursSynthesis['estimates'][number] => ({
  task_id: taskId, seconds, basis: 'notas del día', confidence: 'medium', assumptions: [], changes_if: 'otra evidencia', adjusted_by_corrections: false, transition,
})

describe('cierre', () => {
  it('propone transición solo para la estimación que la trae', () => {
    const pkg = closePackage([closeProject('p1', 'Alfa', [worked('t1', 'APP-1'), worked('t2', 'APP-2')])])
    const draft = renderClose(pkg, { estimates: [estimate('t1', 3600, { to_category: 'done', basis: 'PR mergeada' }), estimate('t2', 1800, null)] }, 'modelo', 'run-1')
    expect(draft.items.map(item => item.kind)).toEqual(['jira_worklog', 'jira_worklog', 'jira_transition'])
    expect(draft.proposed_effects[2]!.effect).toMatchObject({ kind: 'jira_transition', issue_key: 'APP-1', account_id: 'acc-owner', to_category: 'done', evidence_ref: 'note-APP-1' })
  })
  it('sin síntesis no estima horas ni propone transiciones', () => {
    const draft = renderClose(closePackage([closeProject('p1', 'Alfa', [worked('t1', 'APP-1')])]), null, null, 'run-1')
    expect(draft.items).toEqual([])
    expect(draft.body_md).toContain('Horas no estimadas ni transiciones propuestas')
  })
  it('numera en una sola secuencia entre proyectos y cada efecto lleva su ordinal', () => {
    const comment = { id: 'note-c', task_id: 't1', key: 'APP-1', title: 'Tarea APP-1', text: 'bloqueado por acceso', at: SCHEDULED, assignment: 'verified' as const }
    const push = { project_id: 'p2', kind: 'git_push' as const, summary: 'push de feature/x', effect: { kind: 'git_push', branch: 'feature/x' }, effect_digest: 'd' }
    const pkg = closePackage([closeProject('p1', 'Alfa', [worked('t1', 'APP-1')], { comments: [comment] }), closeProject('p2', 'Beta', [worked('t3', 'WEB-1')])], [push])
    const draft = renderClose(pkg, { estimates: [estimate('t1', 4000, null), estimate('t3', 900, null)] }, 'modelo', 'run-1')
    expect(draft.items.map(item => [item.ordinal, item.project_id, item.kind])).toEqual([
      [1, 'p1', 'jira_worklog'], [2, 'p1', 'jira_comment'], [3, 'p2', 'jira_worklog'], [4, 'p2', 'git_push'],
    ])
    expect(draft.proposed_effects.map(effect => effect.ordinal)).toEqual([1, 2, 3, 4])
    expect(draft.proposed_effects[0]!.effect).toMatchObject({ kind: 'jira_worklog', issue_key: 'APP-1', seconds: 3600, account_id: 'acc-owner', started: pkg.projects[0]!.hours!.window.since })
    expect(draft.proposed_effects[2]!.effect).toMatchObject({ issue_key: 'WEB-1', seconds: 1800 })
    expect(draft.proposed_effects[1]!.effect).toMatchObject({ kind: 'jira_comment', evidence_ref: 'note-c' })
    const beta = draft.body_md.slice(draft.body_md.indexOf('### Beta'))
    expect(beta).toMatch(/^3\. WEB-1/m)
    expect(beta).toMatch(/^4\. push de feature\/x/m)
  })
})

describe('espejo de Jira', () => {
  const raw = (fields: Record<string, unknown>) => ({ key: 'APP-1', fields: { summary: 'Implementar API', updated: '2026-10-28T12:00:00Z', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Task' }, ...fields } })

  it('normaliza la cuenta del asignado y la fecha de vencimiento', () => {
    expect(normalizeJiraIssue(raw({ assignee: { accountId: 'acc-1', displayName: 'Persona' }, duedate: '2026-10-30' }), 'https://empresa.atlassian.net'))
      .toMatchObject({ assignee: 'Persona', assignee_account_id: 'acc-1', due_at: '2026-10-30' })
    expect(normalizeJiraIssue(raw({ duedate: 'mañana' }), 'https://empresa.atlassian.net')).toMatchObject({ assignee_account_id: null, due_at: null })
  })

  let dir: string, db: MemoryDatabase, store: MemoryStore, ops: MemoryOperations
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-daily-status-'))
    db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
    store = new MemoryStore(db, dir)
    const vault = new Vault(dir)
    ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, vault), undefined, vault)
  })
  afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

  it('guarda y actualiza assignee_account_id y due_at en la tarea', async () => {
    await store.create({ kind: 'project', title: 'API', data: { jira_project_key: 'APP', jira_site_url: 'https://empresa.atlassian.net' } })
    const read = async () => (await db.query('SELECT assignee_account_id,due_at FROM tasks WHERE external_key=$1', ['APP-1']))[0]
    await ops.call('sync_tasks', { issues: [raw({ assignee: { accountId: 'acc-1', displayName: 'Persona' }, duedate: '2026-10-30' })], site_url: 'https://empresa.atlassian.net', source: 'mcp_mirror' })
    expect(await read()).toEqual({ assignee_account_id: 'acc-1', due_at: '2026-10-30' })
    await ops.call('sync_tasks', { issues: [raw({ updated: '2026-10-29T12:00:00Z', assignee: { accountId: 'acc-2', displayName: 'Otra' } })], site_url: 'https://empresa.atlassian.net', source: 'mcp_mirror' })
    expect(await read()).toEqual({ assignee_account_id: 'acc-2', due_at: null })
  })
})
