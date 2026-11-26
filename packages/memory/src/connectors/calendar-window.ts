import { pages, ProviderHttp } from './http.js'
import type { GoogleAuth } from './google-auth.js'
import type { Sql } from '../database.js'

/** The same expanded Calendar instances feed recording and the secretary, with different eligibility rules. */
export function calendarEvents(http: ProviderHttp, token: string, calendar: string, from: string, to: string) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendar) + '/events')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '250')
  url.searchParams.set('timeMin', from)
  url.searchParams.set('timeMax', to)
  return pages(http, url.toString(), { Authorization: 'Bearer ' + token }, 'items')
}

export interface CalendarSlot {
  key: string
  title: string
  start: string
  end: string | null
  projects: string[]
  mine: boolean
}
export interface CalendarWindow {
  slots: CalendarSlot[]
  calendars: string[]
  unverified?: boolean
}
export const calendarKey = (connector: string, calendar: string) => JSON.stringify([connector, calendar])
export function occupiesCalendar(event: Record<string, any>) {
  return (
    event.status !== 'cancelled' &&
    event.transparency !== 'transparent' &&
    !['birthday', 'workingLocation'].includes(event.eventType) &&
    !event.start?.date &&
    !event.attendees?.some((a: any) => a.self && a.responseStatus === 'declined')
  )
}
export function personalCalendar(calendar: string, event: Record<string, any>, account?: string) {
  return calendar === 'primary' || calendar === account || !!event.organizer?.self || !!event.attendees?.some((a: any) => a.self)
}

export const availabilityMigration = `CREATE TABLE calendar_availability_cache(
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE, calendar TEXT NOT NULL,
  refreshed_at TIMESTAMP NOT NULL, slots JSON NOT NULL, PRIMARY KEY(connector_id,calendar));`

/** One read per configured calendar per minute, shared by concurrent scans and notification clients. */
export function calendarAvailability(db: Sql, google: GoogleAuth, fetcher = fetch) {
  let pending: Promise<CalendarWindow> | undefined, cached: { at: number; window: CalendarWindow } | undefined
  async function read(now: number) {
    const http = new ProviderHttp(fetcher, AbortSignal.timeout(10_000))
    const connectors = await db.query(
      "SELECT id,config,project_ids FROM connectors WHERE provider='google' AND enabled=1 AND coalesce(config->>'calendar_enabled',1)<>0",
    )
    const window: CalendarWindow = { slots: [], calendars: [] }
    const from = new Date(now - 24 * 3600_000).toISOString(),
      to = new Date(now + 24 * 3600_000).toISOString()
    for (const c of connectors) {
      const token = await google.token(c.id).catch(() => null)
      for (const calendar of c.config.calendars?.length ? c.config.calendars : ['primary']) {
        const key = calendarKey(c.id, calendar)
        try {
          if (!token) throw Error('calendar_unavailable')
          const slots: CalendarSlot[] = []
          for await (const e of calendarEvents(http, token, calendar, from, to)) {
            if (!occupiesCalendar(e) || !e.start?.dateTime || !e.end?.dateTime) continue
            slots.push({
              key: JSON.stringify([c.id, calendar, e.id]),
              title: e.summary || 'Reunión',
              start: e.start.dateTime,
              end: e.end.dateTime,
              mine: personalCalendar(calendar, e, c.config.email),
              projects: c.project_ids,
            })
          }
          await db.query(
            `INSERT INTO calendar_availability_cache(connector_id,calendar,refreshed_at,slots) VALUES($1,$2,$3,$4)
            ON CONFLICT(connector_id,calendar) DO UPDATE SET refreshed_at=excluded.refreshed_at,slots=excluded.slots`,
            [c.id, calendar, new Date(now).toISOString(), slots],
          )
          window.calendars.push(key)
          window.slots.push(...slots)
        } catch {
          const [last] = await db.query(
            'SELECT refreshed_at,slots FROM calendar_availability_cache WHERE connector_id=$1 AND calendar=$2',
            [c.id, calendar],
          )
          if (last && now - Date.parse(last.refreshed_at) < 24 * 3600_000) {
            window.slots.push(...last.slots)
            if (now - Date.parse(last.refreshed_at) <= 15 * 60_000) window.calendars.push(key)
          }
          if (!last || now - Date.parse(last.refreshed_at) > 15 * 60_000) window.unverified = true
        }
      }
    }
    return window
  }
  return (now: Date) => {
    if (cached && +now >= cached.at && +now - cached.at < 60_000) return Promise.resolve(cached.window)
    pending ??= read(+now)
      .then((window) => {
        cached = { at: +now, window }
        return window
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}
