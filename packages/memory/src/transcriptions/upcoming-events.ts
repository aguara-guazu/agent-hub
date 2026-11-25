import { createHash } from "node:crypto"
import type { Connector } from "../connectors/types.js"
import { pages, ProviderHttp } from "../connectors/http.js"
import type { GoogleAuth } from "../connectors/google-auth.js"
import type { RecordingEvent } from "./recordings.js"
import type { MemoryStore } from "../store.js"

/**
 * Calendar events of the next hours that will not produce a provider transcript.
 *
 * The regular Google sync only imports events that already started, so the desktop app cannot learn about an
 * upcoming meeting from memory. This reads the calendar ahead of time and keeps the answer in the process: no
 * entity is created for an event that has not happened.
 */

const LOOKAHEAD_MS = 12 * 60 * 60_000
/** A meeting that already started is still offered for a while; the desktop decides how long. */
const LOOKBEHIND_MS = 3 * 60 * 60_000
const CACHE_MS = 60_000
const RETRY_MS = 30_000

const PLATFORMS: readonly [RegExp, string][] = [
  [/\bteams\.(?:(?:microsoft|live)\.com|cloud\.microsoft)(?=[/:?#\s"'<>]|$)/i, "Microsoft Teams"],
  [/([a-z0-9-]+\.)?zoom\.us\//i, "Zoom"],
  [/webex\.com/i, "Webex"],
  [/meet\.jit\.si/i, "Jitsi"],
  [/whereby\.com/i, "Whereby"],
  [/gotomeeting\.com|goto\.com\/meeting/i, "GoTo Meeting"],
]
const SKIPPED_TYPES = new Set(["focusTime", "outOfOffice", "workingLocation", "birthday"])

export interface UpcomingEvent extends RecordingEvent { key: string }

const entryPoints = (event: any): string[] => (event.conferenceData?.entryPoints ?? []).map((entry: any) => String(entry.uri ?? ""))

function platformOf(event: any): string | null {
  const text = [event.location, event.description, ...entryPoints(event)].filter(Boolean).join("\n")
  const videoConference = event.conferenceData?.entryPoints?.some((entry: any) => entry.entryPointType === "video" && entry.uri)
  return PLATFORMS.find(([pattern]) => pattern.test(text))?.[1] ??
    (videoConference ? String(event.conferenceData.conferenceSolution?.name || "Video").slice(0, 40) : null)
}

/** An event qualifies when it is a real meeting with other people and Google Meet will not transcribe it. */
export function recordable(event: any): boolean {
  if (event.status === "cancelled" || !event.start?.dateTime || !event.end?.dateTime || SKIPPED_TYPES.has(event.eventType)) return false
  if (event.hangoutLink || [event.location, event.description, ...entryPoints(event)].some(value => /\bmeet\.google\.com\//i.test(value ?? ""))) return false
  const attendees: any[] = event.attendees ?? []
  if (attendees.some(attendee => attendee.self && attendee.responseStatus === "declined")) return false
  const others = attendees.filter(attendee => !attendee.self && !attendee.resource).length
  return others > 0 || platformOf(event) !== null
}

export function upcomingEvent(connectorId: string, calendar: string, event: any): UpcomingEvent {
  return {
    key: createHash("sha256").update(`${connectorId}|${calendar}|${event.id}`).digest("hex").slice(0, 32),
    connector_id: connectorId, calendar, event_id: String(event.id), title: String(event.summary ?? "").slice(0, 500),
    start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(), platform: platformOf(event),
    attendees: ((event.attendees ?? []) as any[]).filter(attendee => !attendee.resource).slice(0, 500).map(attendee => ({
      ...(typeof attendee.email === "string" && attendee.email.includes("@") ? { email: attendee.email.toLowerCase() } : {}),
      ...(attendee.displayName ? { name: String(attendee.displayName).slice(0, 300) } : {}),
      ...(attendee.self ? { self: true } : {}),
      ...(attendee.responseStatus ? { response: String(attendee.responseStatus).slice(0, 40) } : {}),
    })),
  }
}

export class UpcomingEvents {
  verifiedCalendars: { connector_id: string; calendar: string }[] = []
  private cached: { at: number; events: UpcomingEvent[] } | null = null
  private loading: Promise<UpcomingEvent[]> | null = null

  constructor(private readonly store: () => Promise<MemoryStore>, private readonly google: GoogleAuth, private readonly fetcher: typeof fetch = fetch) {}

  /** Cached for five minutes; a failed refresh keeps serving the previous answer. */
  async list(): Promise<UpcomingEvent[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.events
    this.loading ??= this.load().then(events => { this.cached = { at: Date.now(), events }; return events })
      .catch(() => {
        this.verifiedCalendars = []
        // A failed read is retried after a minute, not on every poll of the desktop app.
        this.cached = { at: Date.now() - CACHE_MS + RETRY_MS, events: this.cached?.events ?? [] }
        return this.cached.events
      }).finally(() => { this.loading = null })
    return this.loading
  }

  private async load(): Promise<UpcomingEvent[]> {
    const store = await this.store(), events: UpcomingEvent[] = [], http = new ProviderHttp(this.fetcher)
    const connectors = (await store.db.query<Connector>("SELECT * FROM connectors WHERE provider='google' AND enabled=1")).filter(connector => connector.config.calendar_enabled !== false)
    const from = new Date(Date.now() - LOOKBEHIND_MS).toISOString(), to = new Date(Date.now() + LOOKAHEAD_MS).toISOString()
    const verified: typeof this.verifiedCalendars = []
    for (const connector of connectors) {
      const token = this.google.token(connector.id).catch(() => null)
      for (const calendar of (connector.config.calendars?.length ? connector.config.calendars : ["primary"]) as string[]) {
        try {
          const access = await token
          if (!access) throw new Error("calendar unavailable")
          const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`)
          url.searchParams.set("singleEvents", "true"); url.searchParams.set("orderBy", "startTime"); url.searchParams.set("maxResults", "250")
          url.searchParams.set("timeMin", from); url.searchParams.set("timeMax", to)
          const live: UpcomingEvent[] = []
          for await (const event of pages(http, url.toString(), { Authorization: `Bearer ${access}` }, "items")) {
            if (recordable(event)) live.push(upcomingEvent(connector.id, calendar, event))
          }
          events.push(...live)
          verified.push({ connector_id: connector.id, calendar })
        } catch {
          const fallback = new Map((this.cached?.events ?? []).filter(e => e.connector_id === connector.id && e.calendar === calendar && e.end && e.end > from).map(e => [e.event_id, e]))
          const rows = await store.db.query<{ id: string; version: string; status: string }>(`SELECT e.data->>'event_id' AS id,s.current_version_id AS version,e.data->>'status' AS status
            FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.provider='google' AND s.account=$1 AND e.kind='event' AND e.data->>'calendar'=$2
            AND julianday(e.data->'scheduled_end'->>'dateTime')>julianday($3) AND julianday(e.data->'scheduled_start'->>'dateTime')<julianday($4)`, [connector.id, calendar, from, to])
          for (const row of rows) {
            if (row.status === "cancelled") { fallback.delete(row.id); continue }
            if (fallback.has(row.id)) continue
            const saved = await store.original(row.version).catch(() => null) as { original?: Record<string, unknown> } | null
            if (saved?.original && recordable(saved.original)) fallback.set(row.id, upcomingEvent(connector.id, calendar, saved.original))
          }
          events.push(...fallback.values())
        }
      }
    }
    this.verifiedCalendars = verified
    return events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))
  }
}
