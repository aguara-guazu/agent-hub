import type { MemoryStore } from './store.js'
import type { MemoryAI } from './ai.js'
import type { AIConfig } from './config.js'

const pending = `e.data->>'merged_into' IS NULL AND NOT EXISTS(SELECT 1 FROM entity_embeddings emb
  WHERE emb.entity_id=e.id AND emb.model=$1 AND emb.content_hash=md5(memory_entity_text(e.title,e.data)))`

/** Discovers writes from the UI, MCP, extraction and imports without depending on their write path. */
export async function scheduleEntityIndex(store: MemoryStore, config: AIConfig) {
  if (!config.embeddings_enabled) return
  const key = `entity-index:${config.embedding_model}`
  const recent = await store.db.query(`SELECT 1 FROM jobs WHERE dedupe_key=$1 AND
    (state IN ('queued','running','waiting') OR (state IN ('failed','cancelled') AND updated_at>now()-interval '5 minutes')) LIMIT 1`, [key])
  if (!recent.length && ((await store.db.query(`SELECT 1 FROM entities e WHERE ${pending} LIMIT 1`, [config.embedding_model])).length)) {
    await store.enqueue('index_entities', {}, key)
  }
  const sources = await store.db.query(`SELECT s.current_version_id AS id FROM sources s WHERE s.status='active'
    AND EXISTS(SELECT 1 FROM fragments f WHERE f.version_id=s.current_version_id AND NOT EXISTS(
      SELECT 1 FROM embeddings emb WHERE emb.fragment_id=f.id AND emb.model=$1))
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'version_id'=s.current_version_id::text
      AND (j.state IN ('queued','running','waiting') OR (j.state IN ('failed','cancelled') AND j.updated_at>now()-interval '5 minutes')))
    ORDER BY s.synced_at LIMIT 8`, [config.embedding_model])
  for (const source of sources) await store.enqueue('process', { version_id: source.id, index_only: true }, `process:${source.id}`)

}

export async function indexEntities(store: MemoryStore, ai: MemoryAI, config: AIConfig, signal: AbortSignal,
  progress: (value: Record<string, unknown>) => Promise<void>) {
  if (!config.embeddings_enabled) return { stage: 'complete', embeddings: 0 }
  // Bounded batches let newly arrived transcripts and explicit user work advance through the queue.
  const rows = await store.db.query(`SELECT e.id,left(memory_entity_text(e.title,e.data),6000) AS text,
    md5(memory_entity_text(e.title,e.data)) AS hash FROM entities e WHERE ${pending} ORDER BY e.updated_at,e.id LIMIT 64`, [config.embedding_model])
  let indexed = 0
  await progress({ source_title: 'Índice de búsqueda local', provider: 'ollama', model: config.embedding_model, stage: 'embeddings', embedding_total: rows.length })
  for (let offset = 0; offset < rows.length; offset += 8) {
    signal.throwIfAborted()
    const batch = rows.slice(offset, offset + 8), result = await ai.embed(batch.map(r => r.text), signal)
    signal.throwIfAborted()
    await store.db.transaction(async sql => {
      for (const [i, row] of batch.entries()) {
        const vector = result.vectors[i]!
        // An edit/deletion during inference cannot mark the new content as indexed.
        await sql.query(`INSERT INTO entity_embeddings(entity_id,model,dimension,embedding,content_hash)
          SELECT id,$2,$3,$4::vector,$5 FROM entities WHERE id=$1 AND md5(memory_entity_text(title,data))=$5
          ON CONFLICT(entity_id,model) DO UPDATE SET dimension=excluded.dimension,embedding=excluded.embedding,
            content_hash=excluded.content_hash,created_at=now()`, [row.id,result.model,vector.length,JSON.stringify(vector),row.hash])
      }
    })
    indexed += batch.length
    await progress({ embeddings: indexed })
  }
  return { stage: 'complete', embeddings: indexed }
}
