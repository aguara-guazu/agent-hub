import type { Sql } from '../database.js'
import { calendarKey, occupiesCalendar, personalCalendar, type CalendarSlot, type CalendarWindow } from '../connectors/calendar-window.js'

export interface Upcoming {
  title: string
  minutes: number
}
export type ReadCalendar = (now: Date) => Promise<CalendarWindow>
const words = (v: string) =>
  ' ' +
  v
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() +
  ' '

/** A busy calendar is personal; project association is only needed to prioritize the related work. */
export async function notificationAgenda(db: Sql, now: Date, connections: boolean, live?: ReadCalendar, clock = () => now) {
  const [rows, projects, remote] = await Promise.all([
    db.query(
      `SELECT e.id,e.title,e.data,s.connector_id,s.provider FROM entities e JOIN sources s ON s.entity_id=e.id
      LEFT JOIN connectors c ON c.id=s.connector_id WHERE e.kind='event' AND s.status='active'
      AND (s.provider<>'google' OR ($3=1 AND (s.connector_id IS NULL OR c.enabled=1)))
      AND julianday(coalesce(json_extract(e.data,'$.scheduled_start.dateTime'), e.data->>'occurred_at'))<=julianday($2)
      AND julianday(coalesce(json_extract(e.data,'$.scheduled_end.dateTime'),e.data->>'ended_at',e.data->>'occurred_at'))>=julianday($1)`,
      [now.toISOString(), new Date(+now + 86400_000).toISOString(), connections],
    ),
    db.query(
      "SELECT id,title FROM entities WHERE kind='project' AND data->>'merged_into' IS NULL AND data->>'memory_state' IS NOT 'archived' AND id NOT IN (SELECT project_id FROM archived_projects)",
    ),
    connections && live
      ? live(now).catch((): CalendarWindow => ({ slots: [], calendars: [], unverified: true }))
      : Promise.resolve({ slots: [], calendars: [] } as CalendarWindow),
  ])
  const links = rows.length
    ? await db.query("SELECT from_id,to_id FROM links WHERE type='project' AND from_id IN (SELECT value FROM json_each($1))", [
        rows.map((r) => r.id),
      ])
    : []
  const byEntity = new Map<string, string[]>()
  for (const l of links) {
    const ids = byEntity.get(l.from_id) ?? []
    ids.push(l.to_id)
    byEntity.set(l.from_id, ids)
  }
  const verified = new Set(remote.calendars),
    byKey = new Map<string, string[]>(),
    slots = new Map<string, CalendarSlot>()
  for (const row of rows) {
    const d = row.data,
      ids = byEntity.get(row.id) ?? [],
      google = row.provider === 'google'
    const key = google ? JSON.stringify([row.connector_id, d.calendar, d.event_id]) : row.id
    byKey.set(key, ids)
    if (google && verified.has(calendarKey(row.connector_id, d.calendar))) continue
    if (!occupiesCalendar({ ...d, start: d.scheduled_start })) continue
    slots.set(key, {
      key,
      title: row.title,
      start: d.scheduled_start?.dateTime ?? d.occurred_at,
      end: d.scheduled_end?.dateTime ?? d.ended_at ?? null,
      projects: ids,
      mine: !google || personalCalendar(d.calendar || 'primary', d),
    })
  }
  for (const slot of remote.slots)
    slots.set(slot.key, { ...slot, projects: byKey.get(slot.key)?.length ? byKey.get(slot.key)! : slot.projects })
  const evaluatedAt = +clock()
  let busy = false
  const upcoming = new Map<string, Upcoming>()
  for (const slot of slots.values()) {
    const start = Date.parse(slot.start),
      end = Date.parse(slot.end ?? '')
    if (slot.mine && start <= evaluatedAt && evaluatedAt < end) busy = true
    if (!slot.mine || !Number.isFinite(start) || start < evaluatedAt || start > evaluatedAt + 86400_000) continue
    let ids = slot.projects
    if (!ids.length) {
      const name = words(slot.title),
        matches = projects.filter((p) => p.title.trim().length >= 3 && name.includes(words(p.title)))
      if (matches.length === 1) ids = [matches[0]!.id]
    }
    const minutes = Math.ceil((start - evaluatedAt) / 60000)
    for (const id of ids) if (minutes < (upcoming.get(id)?.minutes ?? Infinity)) upcoming.set(id, { title: slot.title, minutes })
  }
  return { busy, upcoming, unverified: remote.unverified === true }
}
export function proximity(event?: Upcoming) {
  return !event ? 0 : event.minutes <= 30 ? 24 : event.minutes <= 120 ? 14 : event.minutes <= 240 ? 6 : 2
}
