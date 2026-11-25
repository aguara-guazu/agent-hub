import { prepareSharedProcessing, finishSharedProcessing } from '../sharing/processing.js'
import { tidyMemory } from './memory-maintenance.js'
import type { MemoryStore } from '../store.js'
import type { MemoryAI } from '../ai.js'
import type { AIConfig } from '../config.js'
import { MemoryError } from '../contracts.js'
import { indexEntities } from './entity-index.js'
import { processVersion } from './processing.js'
import { inferSourceMetadata } from './source-inference.js'
import { dedupePeople } from './people-dedupe.js'

interface ProjectJobServices {
  store: MemoryStore
  ai: MemoryAI
  loadSettings(): Promise<AIConfig>
  sharingEnabled(): boolean
  workerId: string
}

export async function runProjectJob(
  { store, ai, loadSettings, sharingEnabled, workerId }: ProjectJobServices,
  job: Record<string, any>, signal: AbortSignal, progress: (value: Record<string, unknown>) => Promise<void>,
): Promise<'done' | 'waiting'> {
  if (job.kind === 'process') {
    const settings = await loadSettings()
    if (job.payload.index_only) { settings.extraction = 'disabled'; await progress({ index_only: true }) }
    const shared = sharingEnabled() && !job.payload.force && !job.payload.identity_only && !job.payload.projects_only
      ? await prepareSharedProcessing(store, job.payload.version_id, settings) : { work: [], reusable: false, defer: false }
    if (shared.defer) {
      await progress({ stage: 'waiting_for_peer' })
      await store.db.query(`UPDATE jobs SET state='waiting',lease_until=NULL,lease_owner=NULL,attempts=max(0,attempts-1),
        available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=now() WHERE id=$1 AND lease_owner=$2`, [job.id, workerId])
      return 'waiting'
    }
    if (shared.reusable) { settings.extraction = 'disabled'; await progress({ shared_result_reused: true }) }
    if (job.payload.identity_only) await progress({ identity_only: true })
    if (job.payload.projects_only) await progress({ projects_only: true })
    const result = await processVersion(store, ai.forJob(settings, signal, progress), job.payload.version_id, settings, progress, signal,
      Boolean(job.payload.force), Boolean(job.payload.identity_only), { runKey: job.id, projectsOnly: Boolean(job.payload.projects_only) })
    await progress(result)
    await finishSharedProcessing(store, shared.work, 'extraction' in result && result.extraction === 'processed')
  } else if (job.kind === 'describe_source') {
    const settings = await loadSettings()
    await progress(await inferSourceMetadata(store, ai.forJob(settings, signal, progress), job.payload.version_id, settings, progress, signal))
  } else if (job.kind === 'index_entities') {
    const settings = await loadSettings()
    await progress(await indexEntities(store, ai.forJob(settings, signal, progress), settings, signal, progress))
  } else if (job.kind === 'tidy_memory') {
    await progress(await tidyMemory(store, await loadSettings(), job.payload, signal, progress))
  } else if (job.kind === 'dedupe_people') {
    const settings = await loadSettings()
    await progress(await dedupePeople(store, ai.forJob(settings, signal, progress), settings, progress, signal))
  } else throw new MemoryError(422, 'Tipo de trabajo desconocido')
  return 'done'
}
