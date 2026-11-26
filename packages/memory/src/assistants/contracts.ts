export * from '@agenthub/shared/assistants'
import type { Profile } from '@agenthub/shared/assistants'

export function abandonedAtStartup(pid: number | null) {
  if (!pid || pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function localClock(p: Profile, date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: p.timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((i) => [i.type, i.value]),
  )
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!)
  const time = parts.hour + ':' + parts.minute
  const wraps = p.end < p.start
  const weekday = wraps && time < p.end ? (day + 6) % 7 : day
  const working = p.weekdays.includes(weekday) && (wraps ? time >= p.start || time < p.end : time >= p.start && time < p.end)
  return { working, date: [parts.year, parts.month, parts.day].join('-') }
}
