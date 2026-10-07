import { setTimeout as sleep } from 'node:timers/promises'
import { MemoryService } from './service.js'
import { migrateLegacyMemory, migrationDue, needsMigration } from './legacy-postgres.js'

const directory = process.env.AGENTHUB_MEMORY_DIR
if (!directory) throw new Error('Falta el directorio de memoria')
const service = new MemoryService(directory, process.env.AGENTHUB_MEMORY_GOOGLE_REDIRECT ?? 'http://127.0.0.1:8765/api/memory/google/callback')
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGTERM', stop); process.once('SIGINT', stop)
process.stdin.resume(); process.stdin.once('end', stop); process.stdin.once('close', stop)
let lastSchedule = 0
while (!controller.signal.aborted) {
  try {
    // Only this process imports a PostgreSQL memory; the HTTP process reports progress from migration.json.
    if (needsMigration(directory, service.vault)) {
      if (migrationDue(directory)) await migrateLegacyMemory(directory, service.vault, controller.signal)
      else await sleep(2000, undefined, { signal: controller.signal })
      continue
    }
    const { runner } = await service.get()
    // Discovery scans the whole memory; while idle it runs every 10 s instead of every 2 s loop.
    if (Date.now() - lastSchedule >= 10_000) { lastSchedule = Date.now(); await runner.schedule() }
    const worked = await runner.once(controller.signal)
    if (worked) lastSchedule = 0
    if (!worked) await sleep(2000, undefined, { signal: controller.signal })
  } catch {
    if (!controller.signal.aborted) await sleep(10_000, undefined, { signal: controller.signal }).catch(() => undefined)
  }
}
await service.close()
