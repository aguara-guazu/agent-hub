import { setTimeout as sleep } from 'node:timers/promises'
import { MemoryService } from './service.js'
import { startManagedDatabase } from './runtime.js'

const directory = process.env.AGENTHUB_MEMORY_DIR
if (!directory) throw new Error('Falta el directorio de memoria')
const service = new MemoryService(directory, process.env.AGENTHUB_MEMORY_GOOGLE_REDIRECT ?? 'http://127.0.0.1:8765/api/memory/google/callback')
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGTERM', stop); process.once('SIGINT', stop)
process.stdin.resume(); process.stdin.once('end', stop); process.stdin.once('close', stop)
while (!controller.signal.aborted) {
  try {
    await startManagedDatabase(directory)
    const { runner } = await service.get()
    await runner.schedule()
    const worked = await runner.once(controller.signal)
    if (!worked) await sleep(2000, undefined, { signal: controller.signal })
  } catch {
    if (!controller.signal.aborted) await sleep(10_000, undefined, { signal: controller.signal }).catch(() => undefined)
  }
}
await service.close()
