import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { occupiesCalendar } from '../connectors/calendar-window.js'
import type { Sql } from '../database.js'
import { localClock, type Profile, type Signal } from './contracts.js'
import { digest } from './slack.js'
import { mapJiraStatus } from '../projects/tasks.js'
import { caseIssueKey, issueEvidence, type JiraCase, type LiveIssue } from './jira.js'

const day = 86_400_000
/** The mirror contributes stable links to existing cases. Every field used to judge a ticket comes from this read of Jira. */
export async function projectSignals(db: Sql, project: string, p: Profile, now: Date, issues: LiveIssue[] = []): Promise<Signal[]> {
  const today = localClock(p, now).date
  const taskRows = issues.length ? await db.query(
    "SELECT external_key,external_site,id FROM tasks WHERE project_id=$1 AND kind='jira'", [project]) : []
  const previous = issues.length ? await db.query<JiraCase>(
    "SELECT kind,title,source,source_key FROM assistant_cases WHERE project_id=$1 AND kind='jira'", [project]) : []
  const taskIds = new Map(taskRows.map(t => [(t.external_site || '') + '/' + t.external_key, t.id as string]))
  const previousKeys = new Map(previous.map(c => {
    let site = ''
    try { site = new URL(c.source.url).origin } catch { /* Older local-only cases may lack a Jira URL. */ }
    return [site + '/' + caseIssueKey(c), c.source_key]
  }))
  const tasks = issues.map(issue => {
    const ref = issue.site + '/' + issue.key
    const id = taskIds.get(ref) ?? taskIds.get('/' + issue.key)
    return { ...issue, id, external_key: issue.key, title: issue.summary, state: mapJiraStatus(issue.status, issue.category),
      caseKey: previousKeys.get(ref) ?? previousKeys.get('/' + issue.key) ?? ('jira/' + (id ?? ref)) }
  })
  const owned = (t: LiveIssue) => !!p.jira_owner && [t.assignee_account_id, t.assignee].includes(p.jira_owner)
  const mine = new Set(tasks.filter(t => owned(t) && !['done','dropped'].includes(t.state)).map(t => t.key))
  const closed = new Set(tasks.filter(t => ['done','dropped'].includes(t.state)).map(t => t.key))
  const dependents = new Map<string, Set<string>>()
  const prerequisites = new Map<string, Set<string>>()
  function blocks(key: string, dependent: string) {
    const values = dependents.get(key) ?? new Set<string>()
    values.add(dependent)
    dependents.set(key, values)
    const upstream = prerequisites.get(dependent) ?? new Set<string>()
    upstream.add(key)
    prerequisites.set(dependent, upstream)
  }
  for (const t of tasks) {
    if (closed.has(t.key)) continue
    for (const link of t.links) {
      const linked = link.outwardIssue ?? link.inwardIssue
      if (!linked?.key || closed.has(linked.key) || linked.fields?.status?.statusCategory?.key === 'done') continue
      const verb = String(link.outwardIssue ? link.type?.outward : link.type?.inward).trim()
      if (/^(blocks|bloquea)$/i.test(verb) && mine.has(linked.key)) blocks(t.external_key, linked.key)
      if (/^(is blocked by|es bloquead[oa] por|está bloquead[oa] por)$/i.test(verb) && owned(t)) blocks(linked.key, t.external_key)
    }
  }
  const signals: Signal[] = []
  for (const t of tasks) {
    if (closed.has(t.key)) continue
    const due = String(t.due_at ?? '').slice(0, 10)
    const late = !!due && due < today
    const priority = String(t.priority ?? '').trim()
    const priorityWeight = /^(highest|critical|blocker|cr[ií]tica?|m[aá]xima)$/i.test(priority)
      ? 3
      : /^(high|alta)$/i.test(priority)
        ? 2
        : 0
    const stale = t.updated && now.getTime() - Date.parse(t.updated) >= 5 * day
    const downstream = [...(dependents.get(t.external_key) ?? [])].sort()
    const upstream = [...(prerequisites.get(t.external_key) ?? [])].sort()
    const reasons = [
      late && 'Venció el ' + due,
      due === today && 'Vence hoy',
      priorityWeight > 0 && 'Jira indica prioridad ' + priority,
      t.state === 'blocked' && 'Figura bloqueada en Jira',
      stale && 'Lleva al menos cinco días sin actualización',
      downstream.length && 'Bloquea tus tareas ' + downstream.join(', '),
      upstream.length && 'Jira marca como dependencias de tu tarea ' + upstream.join(', '),
    ].filter(Boolean) as string[]
    if (!reasons.length) continue
    if (owned(t)) reasons.push('Está asignada a vos')
    const title = t.external_key + ' · ' + t.title
    const evidence = issueEvidence(t)
    const url = evidence.url
    const score = Math.min(
      10,
      3 +
        Number(owned(t)) * 2 +
        (late ? 2 : Number(due === today)) +
        priorityWeight +
        Number(t.state === 'blocked') +
        (downstream.length ? 3 : 0),
    )
    signals.push({
      key: t.caseKey,
      kind: 'jira',
      title,
      text: [title, t.description, ...reasons].join('\n'),
      at: t.updated ?? now.toISOString(),
      url,
      score,
      reasons,
      fingerprint: digest([evidence, reasons]),
      evidence: [evidence],
      source: {
        url,
        task_id: t.id ?? null,
        jira_verification: 'verified',
        jira_scope_key: t.key.split('-')[0],
        jira_scope_site: t.site,
        status: t.state,
        issue_key: t.external_key,
        due_at: t.due_at,
        priority,
        downstream,
        assignee: t.assignee,
        owned: owned(t),
      },
    })
  }
  const events = await db.query(
    `SELECT e.id,e.title,e.data,e.updated_at,s.url FROM entities e JOIN links l ON l.from_id=e.id AND l.type='project'
    JOIN sources s ON s.entity_id=e.id AND s.status='active' WHERE e.kind='event' AND l.to_id=$1 AND COALESCE(e.data->>'status','')<>'cancelled'
    AND julianday(e.data->>'occurred_at') BETWEEN julianday($2) AND julianday($3) ORDER BY e.data->>'occurred_at'`,
    [project, now.toISOString(), new Date(now.getTime() + day).toISOString()],
  )
  for (const e of events) {
    if (!occupiesCalendar({ ...e.data, start: e.data.scheduled_start })) continue
    const at = e.data.occurred_at,
      url = e.url || '/#/memory/entities/' + e.id
    const soon = Date.parse(at) - now.getTime() < 3600_000
    const reasons = ['Reunión del proyecto prevista para ' + new Date(at).toLocaleString('es-AR', { timeZone: p.timezone })]
    signals.push({
      key: 'meeting/' + e.id,
      kind: 'meeting',
      title: e.title,
      text: e.title,
      at,
      url,
      score: soon ? 8 : 5,
      reasons,
      fingerprint: digest([e.updated_at, soon]),
      source: { url, event_id: e.id },
    })
  }
  return signals
}

const execute = promisify(execFile)
export async function pullRequests(
  repo: string,
  signal: AbortSignal,
  gh = async (args: string[]) =>
    (await execute('gh', args, { signal, timeout: 25_000, maxBuffer: 4_000_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout,
): Promise<Signal[]> {
  const login = (await gh(['api', 'user', '--jq', '.login'])).trim().toLowerCase()
  const fields = 'number,title,url,author,updatedAt,headRefName,headRefOid,reviewRequests,reviewDecision,statusCheckRollup,isDraft'
  const groups = await Promise.all(
    [
      ['--author', '@me'],
      ['--search', 'review-requested:@me'],
    ].map(
      async (filter) =>
        JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', ...filter, '--limit', '500', '--json', fields])) as Record<
          string,
          any
        >[],
    ),
  )
  const rows = [...new Map(groups.flat().map((r) => [r.number, r])).values()]
  return rows.flatMap((r) => {
    const reviewer = r.reviewRequests.some((v: { login?: string }) => v.login?.toLowerCase() === login)
    const author = r.author?.login?.toLowerCase() === login
    const failed = r.statusCheckRollup.some((c: { conclusion?: string; state?: string }) =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion || c.state || ''),
    )
    const changes = r.reviewDecision === 'CHANGES_REQUESTED'
    if (!(reviewer && !r.isDraft) && !(author && (changes || failed))) return []
    const reasons = [
      reviewer && 'Te pidieron una revisión',
      author && failed && 'Fallaron los checks de tu PR',
      author && changes && 'Solicitaron cambios en tu PR',
    ].filter(Boolean) as string[]
    return [
      {
        key: 'pr/' + repo + '/' + r.number,
        kind: 'pr',
        title: repo + '#' + r.number + ' · ' + r.title,
        text: r.title + ' ' + r.headRefName,
        at: r.updatedAt,
        url: r.url,
        score: author && failed ? 8 : 6,
        reasons,
        fingerprint: digest([r.headRefOid, reasons]),
        source: { url: r.url, repo, sha: r.headRefOid, number: r.number },
      },
    ]
  })
}
