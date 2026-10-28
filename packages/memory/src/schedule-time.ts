import type { GracePolicy, Recurrence } from './schedule-contract.js'

// Wall-clock arithmetic for schedules. Instants are UTC milliseconds; a time zone only matters when reading or building a local wall time.

const MINUTE = 60_000
const DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

export function systemTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone }

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    formatters.set(zone, value)
  }
  return value
}
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
/** Local wall time at an instant. */
export function wallTime(ms: number, zone: string): WallTime {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map(part => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday!]! }
}
/** The wall time read as if it were UTC, which makes two wall times comparable without regard to offsets. */
const wallAsUtc = (wall: Pick<WallTime, 'year' | 'month' | 'day' | 'hour' | 'minute'>) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)

/**
 * First instant at which the local clock reads `hour:minute` on the given local date.
 * A repeated hour (clocks going back) resolves to its first occurrence; a skipped hour (clocks going forward) to the first valid instant after the gap.
 */
export function localInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const target = wallAsUtc({ year, month, day, hour, minute })
  const offsetAt = (ms: number) => wallAsUtc(wallTime(ms, zone)) - Math.floor(ms / MINUTE) * MINUTE
  // Offsets sampled a day before and after bound any transition near the target; the target is only an approximation of the instant.
  const candidates = [...new Set([offsetAt(target - DAY), offsetAt(target + DAY)])].map(offset => target - offset).sort((a, b) => a - b)
  const valid = candidates.filter(instant => wallAsUtc(wallTime(instant, zone)) === target)
  if (valid.length) return valid[0]!
  // No instant reads the target (clocks skipped it): the local clock is monotonic across a gap, so search for the first instant reading at least the target.
  let low = candidates[0]!, high = candidates[candidates.length - 1]!
  while (low < high) {
    const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE
    if (wallAsUtc(wallTime(middle, zone)) >= target) high = middle
    else low = middle + MINUTE
  }
  return low
}

export function localIso(ms: number, zone: string): string {
  const wall = wallTime(ms, zone)
  const offsetMinutes = Math.round((wallAsUtc(wall) - Math.floor(ms / MINUTE) * MINUTE) / MINUTE)
  const sign = offsetMinutes < 0 ? '-' : '+', abs = Math.abs(offsetMinutes), pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const seconds = new Date(ms).getUTCSeconds()
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(seconds)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const addDays = (wall: Pick<WallTime, 'year' | 'month' | 'day'>, days: number) => {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}
const isoWeekday = (date: { year: number; month: number; day: number }) => ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7) + 1

/** Next occurrence strictly after `after`, or null when the recurrence is exhausted. `anchor` is the previous occurrence of an interval. */
export function nextOccurrence(recurrence: Recurrence, after: number, zone: string, anchor?: number): number | null {
  if (recurrence.type === 'once') {
    const at = Date.parse(recurrence.at)
    return at > after ? at : null
  }
  if (recurrence.type === 'interval') {
    const step = recurrence.minutes * MINUTE
    if (anchor === undefined) return after + step
    return anchor + (Math.floor((after - anchor) / step) + 1) * step
  }
  const [hour, minute] = recurrence.time.split(':').map(Number) as [number, number], start = wallTime(after, zone)
  for (let offset = 0; offset < 9; offset++) {
    const date = addDays(start, offset)
    if (recurrence.weekdays && !recurrence.weekdays.includes(isoWeekday(date))) continue
    const instant = localInstant(date.year, date.month, date.day, hour, minute, zone)
    if (instant > after) return instant
  }
  return null
}

/** Latest occurrence at or before `now` that is not earlier than `from`, walking forward from `from`; null when none was missed. */
export function lastOccurrenceUpTo(recurrence: Recurrence, from: number, now: number, zone: string): number | null {
  if (recurrence.type === 'once') {
    const at = Date.parse(recurrence.at)
    return at >= from && at <= now ? at : null
  }
  if (from > now) return null
  if (recurrence.type === 'interval') {
    const step = recurrence.minutes * MINUTE
    return from + Math.floor((now - from) / step) * step
  }
  let current: number | null = from, last: number | null = null
  // A year of daily occurrences bounds the walk; a longer absence still resolves to the most recent one.
  for (let guard = 0; guard < 400 && current !== null && current <= now; guard++) {
    last = current
    current = nextOccurrence(recurrence, current, zone)
  }
  return last
}

export interface GraceInput { policy: GracePolicy; minutes: number; until?: string | null }
/** Latest instant at which a lost occurrence may still run. `next` is the following occurrence, used by `until_next`. */
export function graceDeadline(scheduledFor: number, grace: GraceInput, zone: string, next: number | null): number {
  if (grace.policy === 'until_next') return next ?? Number.POSITIVE_INFINITY
  if (grace.policy === 'until_local_time') {
    const [hour, minute] = (grace.until ?? '23:59').split(':').map(Number) as [number, number], wall = wallTime(scheduledFor, zone)
    return localInstant(wall.year, wall.month, wall.day, hour, minute, zone)
  }
  return scheduledFor + grace.minutes * MINUTE
}
