import type { MemoryStore } from '../store.js'
import type { AIConfig } from '../config.js'
import { digest } from './crypto.js'
import { SharedPublications } from './publications.js'

interface Work { project_id: string; key: string; entity_id: string }
/** Advisory claims reduce repeated inference; immutable publication identities make duplicate attempts harmless. */
export async function prepareSharedProcessing(store: MemoryStore, versionId: string, settings: AIConfig) {
  const sharing = new SharedPublications(store)
  const rows = await store.db.query(`SELECT i.project_id,i.item_key,s.entity_id FROM shared_items i JOIN sources s ON s.entity_id=i.entity_id
    WHERE s.current_version_id=$1`, [versionId])
  const work: Work[] = []
  if (!rows.length || settings.extraction === 'disabled') return { work, defer: false, reusable: false }
  for (const row of rows) {
    const access = await sharing.member(row.project_id, true).catch(() => null)
    if (!access) return { work: [], defer: false, reusable: true }
    const source = await sharing.source(row.project_id, row.entity_id)
    const key = digest({ project: row.project_id, resource: row.item_key, fragments: source.fragments, pipeline: 'memory-extraction-v1',
      provider: settings.extraction, model: settings.extraction_model, reasoning: settings.extraction_reasoning_effort })
    const done = await store.db.query("SELECT id FROM shared_events WHERE project_id=$1 AND payload->>'kind'='publication' AND payload->>'processing_key'=$2 LIMIT 1", [row.project_id, key])
    if (done.length) return { work: [], defer: false, reusable: true }
    const claim = await sharing.claim(row.project_id, key)
    if (!claim.claimed) return { work: [], defer: true, reusable: false }
    work.push({ project_id: row.project_id, key, entity_id: row.entity_id })
  }
  return { work, defer: false, reusable: false }
}
export async function finishSharedProcessing(store: MemoryStore, work: Work[], extracted: boolean) {
  if (!extracted) return
  const sharing = new SharedPublications(store)
  for (const job of work) {
    await store.db.query("UPDATE entities SET data=json_set(data,'$.shared_processing_key',$2) WHERE id=$1", [job.entity_id, job.key])
    await sharing.publish(job.project_id, job.entity_id)
  }
}
