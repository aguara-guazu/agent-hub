import type { MemoryDatabase } from '../database.js'
import { ScheduleStore } from './schedule-store.js'

export async function scheduleContext(db: MemoryDatabase, projectId?: string) {
  const schedules = new ScheduleStore(db)
  const [incidents, unread] = await Promise.all([
    schedules.incidents(projectId ? { project_id: projectId } : {}),
    schedules.unreadDeliveries(projectId),
  ])
  if (!incidents.length && !unread.length) return {}
  return { scheduler: { interrupted_processes: incidents.slice(0, 10), unread_deliveries: unread.slice(0, 10) } }
}
