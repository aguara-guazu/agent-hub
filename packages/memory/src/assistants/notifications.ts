import { createHash } from 'node:crypto'
import type { AssistantNotice, NoticeEntry } from '@agenthub/shared/assistants'
import type { MemoryDatabase, Sql } from '../database.js'
import type { ModuleEnabled } from '@agenthub/shared/modules'
import { check } from '../contracts.js'
import { localClock, profile } from './contracts.js'
import { readPolicy } from './portfolio.js'
import { recentJira } from './jira.js'
import { notificationAgenda, proximity, type ReadCalendar, type Upcoming } from './agenda.js'

const minute = 60_000
const tracked =
  "p.config->>'active'=1 AND e.data->>'memory_state' IS NOT 'archived' AND e.id NOT IN (SELECT project_id FROM archived_projects)"
type Row = Record<string, any>
interface Member {
  id: string
  kind: NoticeEntry['kind']
  revision: number
  day: string
  turn: number
}
interface Candidate {
  entry: NoticeEntry
  member: Member
  eligibleAt: number
  repeat: boolean
}
function sourceLabel(c: Row) {
  if (c.kind === 'slack') return 'Slack · ' + (c.source.channel_name || c.source.channel || 'canal')
  if (c.kind === 'jira') return 'Jira'
  if (c.kind === 'meeting') return 'Calendario'
  if (c.kind === 'pr') return 'GitHub PR'
  return 'Microtarea'
}
const oneLine = (s: unknown, max = 200) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
async function slackDeadlines(sql: Sql, rows: Row[], day: string, asOf: string) {
  const keysByCase = new Map<string, string[]>(),
    keys = new Set<string>()
  for (const row of rows)
    if (row.kind === 'slack') {
      const matches = String(row.source.text ?? '').match(/\b[A-Z][A-Z0-9_]{0,19}-\d{1,9}\b/g) ?? []
      if (matches.length) {
        keysByCase.set(row.id, matches)
        for (const key of matches) keys.add(key)
      }
    }
  const result = new Map<string, string>()
  if (!keys.size) return result
  const tasks = await sql.query(
    `SELECT c.project_id,c.source->>'issue_key' AS external_key,c.source->>'status' AS status,c.source->>'due_at' AS due_at
    FROM assistant_cases c WHERE c.kind='jira' AND c.state='open' AND ${recentJira('$3')}
    AND c.source->>'issue_key' IN (SELECT value FROM json_each($1))
    AND (c.source->>'status'='blocked' OR substr(c.source->>'due_at',1,10)<=$2)`,
    [[...keys], day, asOf],
  )
  for (const row of rows) {
    const matches = keysByCase.get(row.id)
    const task = matches && tasks.find((t) => t.project_id === row.project_id && matches.includes(t.external_key))
    if (task)
      result.set(
        row.id,
        'El hilo menciona ' +
          task.external_key +
          (task.status === 'blocked' ? ' que está bloqueada.' : ' con vencimiento el ' + String(task.due_at).slice(0, 10) + '.'),
      )
  }
  return result
}
function entryOf(c: Row, event?: Upcoming, now?: Date, deadline?: string): NoticeEntry {
  const work = c.kind === 'work',
    calendar = event ? event.title + ' en ' + event.minutes + ' min' : null
  const severity = Number(c.score)
  const reason =
    c.state === 'sent'
      ? 'Respuesta enviada a Slack.'
      : c.state === 'uncertain'
        ? 'Slack todavía no confirmó el envío. ' + c.reason
        : c.reason
  const waited = c.kind === 'slack' && c.state === 'open' && now ? Math.max(0, Math.floor((+now - Date.parse(c.source.at)) / minute)) : 0
  const context = [reason, deadline, waited ? 'Sin respuesta hace ' + waited + ' min.' : null].filter(Boolean).join(' ')
  return {
    id: c.id,
    project_id: c.project_id,
    project: c.project,
    revision: c.revision,
    kind: c.kind,
    source: sourceLabel(c),
    title: c.title,
    reason: oneLine(context, 600),
    suggestion: c.kind === 'slack' && c.state === 'open' ? oneLine(c.draft, 240) : '',
    url: c.source.url || '',
    severity,
    calendar,
    priority:
      severity * 10 +
      proximity(event) +
      (c.kind === 'slack' && c.source.question ? 3 : 0) +
      (c.source.downstream?.length ? 3 : 0) +
      (deadline ? 15 : 0) +
      (waited >= 120 ? 5 : waited >= 30 ? 2 : 0),
    route: work && !c.case_id ? '/assistants?project=' + c.project_id : '/assistants/' + (c.case_id || c.id),
  }
}
function receiptId(members: Member[]) {
  const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id))
  const bytes = createHash('sha256').update(JSON.stringify(sorted)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 80
  bytes[8] = (bytes[8]! & 63) | 128
  const h = bytes.toString('hex')
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-')
}
function describe(entries: NoticeEntry[], members: Member[], pending: number, delivery: string): AssistantNotice {
  const first = entries[0]!,
    single = entries.length === 1,
    original = single && members[0]!.turn === 1
  const summary = (entry: NoticeEntry) =>
    oneLine(entry.source + ' · ' + entry.project + ' · ' + entry.title, 115) + ' — ' + oneLine(entry.reason, 130)
  return {
    id: original ? first.id : delivery,
    revision: original ? first.revision : 1,
    delivery_id: delivery,
    route: single ? first.route : '/assistants?notice=' + delivery,
    title: single
      ? first.project + ' · ' + first.severity + '/10 · ' + first.source
      : entries.length + ' asuntos de proyectos · ' + Math.max(...entries.map((e) => e.severity)) + '/10',
    body:
      entries
        .slice(0, 3)
        .map((e) => summary(e) + (e.calendar ? ' · ' + oneLine(e.calendar, 70) : ''))
        .join('\n') +
      (entries.length > 3 ? '\n+' + (entries.length - 3) + ' en la bandeja' : '') +
      (single && first.suggestion ? '\nSugerencia: ' + first.suggestion : ''),
    pending_count: pending,
    entries,
  }
}

async function attentionRows(sql: Sql, work: boolean, date: string, asOf: string, jira: boolean, ids?: string[]) {
  const where = ids ? ' AND c.id IN (SELECT value FROM json_each($4))' : ''
  const params = ids ? [date, asOf, jira, ids] : [date, asOf, jira]
  const rows = await sql.query(
    `SELECT c.*,e.title AS project,p.config,d.presentations,d.last_at FROM assistant_cases c
    JOIN assistant_profiles p ON p.project_id=c.project_id JOIN entities e ON e.id=c.project_id
    LEFT JOIN assistant_notice_days d ON d.item_id=c.id AND d.local_day=$1 WHERE ${tracked}
    AND (c.kind<>'jira' OR ($3=1 AND ${recentJira('$2')}))
    AND c.state IN ('open','sent','uncertain') AND coalesce(c.source->>'dismissed',0)=0 ${ids ? '' : "AND (c.state='open' OR c.notified_revision<c.revision)"} ${where}`,
    params,
  )
  if (work)
    rows.push(
      ...(await sql.query(
        `SELECT c.id,c.case_id,c.project_id,c.objective AS title,c.attempts AS revision,c.state,c.notified_attempt AS notified_revision,
    'work' AS kind,CASE WHEN c.state='blocked' THEN 6 ELSE 4 END AS score,c.updated_at AS notify_after,
    coalesce(c.result->>'summary',c.objective) AS reason,'{}' AS "source:json",e.title AS project,p.config,d.presentations,d.last_at
    FROM assistant_work c JOIN assistant_profiles p ON p.project_id=c.project_id JOIN entities e ON e.id=c.project_id
    LEFT JOIN assistant_notice_days d ON d.item_id=c.id AND d.local_day=$1 WHERE ${tracked}
    AND NOT EXISTS(SELECT 1 FROM assistant_cases origin WHERE origin.id=c.case_id AND origin.kind='jira'
      AND (origin.state<>'open' OR $3=0 OR NOT (${recentJira('$2','origin')})))
    AND c.state IN ('done','blocked') ${ids ? '' : 'AND c.notified_attempt<c.attempts'} ${where}`,
        params,
      )),
    )
  return rows
}

export class NotificationQueue {
  constructor(
    readonly db: MemoryDatabase,
    readonly now: () => Date,
    readonly enabled: ModuleEnabled,
    readonly calendar?: ReadCalendar,
  ) {}
  agenda(date = this.now()) {
    return notificationAgenda(this.db, date, this.enabled('connections'), this.calendar, this.now)
  }

  async next(consumer?: string): Promise<AssistantNotice[]> {
    if (!this.enabled('assistants') || !this.enabled('memory')) return []
    const [tracking] = await this.db.query(
      'SELECT 1 FROM assistant_profiles p JOIN entities e ON e.id=p.project_id WHERE ' + tracked + ' LIMIT 1',
    )
    if (!tracking) return []
    const agenda = await this.agenda()
    return this.db.transaction(async (sql) => {
      const now = this.now(),
        iso = now.toISOString(),
        { config } = await readPolicy(sql),
        policy = config.notifications
      if (!this.enabled('assistants') || !this.enabled('memory')) return []
      const day = localClock(profile.parse({ timezone: config.timezone }), now).date
      const [lease] = await sql.query(
        'SELECT * FROM assistant_notice_batches WHERE presented_at IS NULL AND lease_until>$1 ORDER BY created_at LIMIT 1',
        [iso],
      )
      if (lease && consumer && lease.consumer !== consumer) return []
      const [recent] = await sql.query(
        `SELECT (SELECT max(presented_at) FROM assistant_notice_batches) AS last_at,
          count(*) AS groups,coalesce(sum(json_array_length(members)),0) AS items
          FROM assistant_notice_batches WHERE presented_at>$1`,
        [new Date(+now - 60 * minute).toISOString()],
      )
      const since = recent?.last_at ? (+now - Date.parse(recent.last_at)) / minute : Infinity
      const candidates: Candidate[] = []
      const jira = this.enabled('connections') && this.enabled('mcp')
      const rows = await attentionRows(sql, this.enabled('agents'), day, iso, jira)
      const deadlines = jira ? await slackDeadlines(sql, rows, day, iso) : new Map<string, string>()
      for (const row of rows) {
        if ((row.kind === 'slack' || row.kind === 'pr') && !this.enabled('connections')) continue
        const p = profile.parse(row.config),
          repeat = row.state === 'open',
          shown = Number(row.presentations ?? 0)
        if (!localClock(p, now).working || row.source.deferred || (repeat && row.score < p.threshold)) continue
        if ((!repeat && row.notified_revision >= row.revision) || shown >= policy.daily_limit) continue
        const eligibleAt = Math.max(
          row.kind === 'work' ? 0 : Date.parse(row.notify_after),
          shown ? Date.parse(row.last_at) + policy.reminder_minutes * minute * 2 ** (shown - 1) : 0,
        )
        if (+now < eligibleAt) continue
        const entry = entryOf(row, agenda.upcoming.get(row.project_id), now, deadlines.get(row.id))
        candidates.push({ entry, member: { id: row.id, kind: row.kind, revision: row.revision, day, turn: shown + 1 }, eligibleAt, repeat })
      }
      const load = Math.max(candidates.length, Number(recent?.items ?? 0))
      const groups = Number(recent?.groups ?? 0)
      const multiplier = groups >= 3 || load >= 16 ? 4 : groups >= 2 || load >= 8 ? 2 : 1
      const base = policy.cooldown_minutes
      const cooldown = policy.adaptive_cooldown ? Math.min(base * multiplier, Math.max(60, base)) : base
      const isCritical = (c: Candidate) => policy.interrupt_severity !== null && c.entry.severity >= policy.interrupt_severity
      let available = candidates.filter(
        (c) =>
          (!policy.pause_in_meetings || (!agenda.busy && !agenda.unverified) || isCritical(c)) &&
          since >= (isCritical(c) && (!c.repeat || c.member.turn === 1) ? Math.min(5, base) : cooldown),
      )
      available.sort((a, b) => b.entry.priority - a.entry.priority || a.eligibleAt - b.eligibleAt || a.entry.id.localeCompare(b.entry.id))
      if (lease) {
        const booked = new Map(available.map((c) => [c.entry.id, c]))
        const frozen = (lease.members as Member[]).map((m) => booked.get(m.id)).filter((c): c is Candidate => !!c)
        if (frozen.length === lease.members.length && receiptId(frozen.map((c) => c.member)) === lease.id) available = frozen
        else if (consumer) await sql.query('UPDATE assistant_notice_batches SET lease_until=NULL,consumer=NULL WHERE id=$1', [lease.id])
      }
      if (!available.length) return []
      const members = available.map((c) => c.member),
        id = receiptId(members)
      const notice = describe(
        available.map((c) => c.entry),
        members,
        candidates.length,
        id,
      )
      await sql.query(
        `INSERT INTO assistant_notice_batches(id,notice_id,revision,members,created_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO NOTHING`,
        [id, notice.id, notice.revision, members, iso],
      )
      if (consumer)
        await sql.query('UPDATE assistant_notice_batches SET consumer=$2,lease_until=$3 WHERE id=$1 AND presented_at IS NULL', [
          id,
          consumer,
          new Date(+now + 90_000).toISOString(),
        ])
      return [notice]
    })
  }

  async seen(id: string, revision: number, delivery?: string) {
    await this.db.transaction(async (sql) => {
      const now = this.now().toISOString(),
        [batch] = await sql.query(
          `SELECT * FROM assistant_notice_batches WHERE notice_id=$1 AND revision=$2
        AND ($3 IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 1`,
          [id, revision, delivery ?? null],
        )
      if (!batch || batch.presented_at) return
      const { config } = await readPolicy(sql)
      for (const m of batch.members as Member[]) {
        await sql.query(
          `INSERT INTO assistant_notice_days(item_id,local_day,presentations,last_at,capped_at) VALUES($1,$2,1,$3,CASE WHEN $4=1 THEN $3 END)
          ON CONFLICT(item_id,local_day) DO UPDATE SET presentations=presentations+1,last_at=excluded.last_at,
          capped_at=CASE WHEN presentations+1 >= $4 THEN excluded.last_at ELSE capped_at END WHERE presentations < $5`,
          [m.id, m.day, now, config.notifications.daily_limit, m.turn],
        )
        if (m.kind === 'work')
          await sql.query('UPDATE assistant_work SET notified_attempt=max(notified_attempt,$2) WHERE id=$1 AND attempts>=$2', [
            m.id,
            m.revision,
          ])
        else
          await sql.query('UPDATE assistant_cases SET notified_revision=max(notified_revision,$2) WHERE id=$1 AND revision>=$2', [
            m.id,
            m.revision,
          ])
      }
      await sql.query('UPDATE assistant_notice_batches SET presented_at=$2,lease_until=NULL WHERE id=$1', [batch.id, now])
      await sql.query("DELETE FROM assistant_notice_batches WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ',$1,'-35 days')", [now])
    })
  }
  async detail(id: string) {
    const [batch] = await this.db.query('SELECT members FROM assistant_notice_batches WHERE id=$1', [id])
    check(batch, 'Aviso inexistente', 404)
    const now = this.now(), jira = this.enabled('connections') && this.enabled('mcp')
    const members = batch.members as Member[],
      rows = await attentionRows(
        this.db,
        this.enabled('agents'),
        members[0]?.day ?? '', now.toISOString(), jira,
        members.map((m) => m.id),
      )
    const agenda = await this.agenda(now),
      deadlines = jira ? await slackDeadlines(this.db, rows, members[0]?.day ?? '', now.toISOString()) : new Map<string,string>()
    const byId = new Map(
      rows
        .filter((r) => !['slack', 'pr'].includes(r.kind) || this.enabled('connections'))
        .map((r) => [r.id, entryOf(r, agenda.upcoming.get(r.project_id), now, deadlines.get(r.id))]),
    )
    return { entries: members.flatMap((m) => (byId.has(m.id) ? [byId.get(m.id)!] : [])) }
  }
}

/** Only the owner's Gmail daily brief reads these rows. Resolved or archived work drops out at delivery time. */
export async function briefEmailReminders(db: Sql, now: Date, connections = true, mcp = true) {
  const rows = await db.query(
    `SELECT c.id,c.title,c.reason,c.kind,c.source,c.score,e.title AS project FROM assistant_cases c
    JOIN entities e ON e.id=c.project_id JOIN assistant_profiles p ON p.project_id=e.id
    WHERE ${tracked} AND c.state='open' AND coalesce(c.source->>'dismissed',0)=0 AND ($2=1 OR c.kind NOT IN ('pr','slack','jira'))
    AND (c.kind<>'jira' OR ($3=1 AND ${recentJira('$1')}))
    AND EXISTS(SELECT 1 FROM assistant_notice_days d WHERE d.item_id=c.id AND d.capped_at<=$1 AND d.capped_at>coalesce((
      SELECT max(sd.updated_at) FROM schedule_deliveries sd JOIN schedule_runs r ON r.id=sd.run_id
      JOIN schedules s ON s.id=r.schedule_id WHERE s.template='daily_brief' AND sd.target='gmail_self' AND sd.state='sent'),''))
    ORDER BY c.score DESC,c.title,c.id`,
    [now.toISOString(), connections, mcp],
  )
  if (!rows.length) return ''
  const safe = (value: unknown, length: number) => oneLine(value, length).replace(/([\\*_[\]<>`])/g, '\\$1')
  return (
    '## Pendientes que alcanzaron el límite de avisos\n\n' +
    rows
      .map((r) => {
        const url = typeof r.source.url === 'string' && /^https:\/\/[^\s<>()]+$/i.test(r.source.url) ? ' · ' + r.source.url : ''
        return (
          '- ' +
          r.score +
          '/10 · ' +
          safe(r.project, 80) +
          ' · ' +
          safe(sourceLabel(r), 90) +
          ' · ' +
          safe(r.title, 120) +
          ' — ' +
          safe(r.reason, 240) +
          url
        )
      })
      .join('\n')
  )
}
