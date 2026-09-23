import { z } from 'zod'
import { id, instant, kindSchema, MemoryError, parse } from './contracts.js'
import type { MemoryDatabase } from './database.js'
import type { MemoryAI } from './ai.js'
import { requireEntity } from './store.js'

export const globalSearchInput = z.object({ query: z.string().trim().max(2000).default(''), kind: kindSchema.optional(),
  project_id: id.optional(), from: instant.optional(), limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0) }).strict()

// One document per entity plus its source fragments. Filters are applied before ranking in both retrieval paths.
const corpus = `WITH corpus AS (
  SELECT 'entity:'||e.id AS key,e.id AS entity_id,NULL::uuid AS fragment_id,NULL::uuid AS version_id,e.title,e.kind,
    memory_entity_text(e.title,e.data) AS content,to_tsvector('simple',memory_entity_text(e.title,e.data)) AS fts,
    e.data,e.updated_at,NULL::text AS speaker_name,
    ARRAY(SELECT l.to_id FROM links l WHERE l.from_id=e.id AND l.type='project') || CASE WHEN e.kind='project' THEN ARRAY[e.id] ELSE ARRAY[]::uuid[] END AS project_ids
  FROM entities e WHERE e.data->>'merged_into' IS NULL AND e.data->>'review_state' IS DISTINCT FROM 'rejected'
    AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.entity_id=e.id AND s.status<>'active')
  UNION ALL
  SELECT 'fragment:'||f.id,e.id,f.id,f.version_id,e.title,e.kind,f.text,f.search_text,e.data,e.updated_at,p.title,
    ARRAY(SELECT fp.project_id FROM fragment_projects fp WHERE fp.fragment_id=f.id)
  FROM fragments f JOIN sources s ON s.current_version_id=f.version_id AND s.status='active'
    JOIN entities e ON e.id=s.entity_id LEFT JOIN entities p ON p.id=f.speaker_id
), filtered AS (SELECT * FROM corpus WHERE ($1::text IS NULL OR kind=$1)
  AND ($2::uuid IS NULL OR $2=ANY(project_ids)) AND ($3::timestamptz IS NULL OR updated_at >= $3))`

export async function globalSearch(db: MemoryDatabase, ai: MemoryAI, raw: unknown, signal?: AbortSignal) {
  const input = parse(globalSearchInput, raw)
  if (input.project_id) await requireEntity(db, input.project_id, 'project')
  const params = [input.kind ?? null, input.project_id ?? null, input.from ?? null]
  let status = 'not_requested', coverage: Record<string, any> | null | undefined = null
  const scores = new Map<string, number>()
  const add = (rows: Record<string, any>[]) => rows.forEach((row, rank) => scores.set(row.key, (scores.get(row.key) ?? 0) + 1 / (60 + rank + 1)))
  if (!input.query) {
    const rows = await db.query(`${corpus} SELECT key FROM filtered WHERE fragment_id IS NULL ORDER BY updated_at DESC,key LIMIT 200`, params)
    add(rows)
  } else {
    const lexical = await db.query(`${corpus} SELECT key FROM filtered
      WHERE fts @@ websearch_to_tsquery('simple',$4) OR content ILIKE '%'||$4||'%' OR title ILIKE '%'||$4||'%'
      ORDER BY (lower(title)=lower($4)) DESC,(title ILIKE '%'||$4||'%') DESC,ts_rank_cd(fts,websearch_to_tsquery('simple',$4)) DESC,key LIMIT 200`, [...params,input.query])
    try {
      const { model, vectors } = await ai.embedQuery(input.query, AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]))
      signal?.throwIfAborted()
      const semantic = await db.query(`${corpus}, vectors AS (
        SELECT 'entity:'||emb.entity_id AS key,emb.embedding FROM entity_embeddings emb JOIN entities e ON e.id=emb.entity_id
          WHERE emb.model=$5 AND emb.dimension=$6 AND emb.content_hash=md5(memory_entity_text(e.title,e.data))
        UNION ALL SELECT 'fragment:'||fragment_id,embedding FROM embeddings WHERE model=$5 AND dimension=$6
      ) SELECT c.key FROM filtered c JOIN vectors v ON v.key=c.key
        WHERE (v.embedding <=> $4::vector) < 0.85 ORDER BY v.embedding <=> $4::vector,c.key LIMIT 200`, [...params,JSON.stringify(vectors[0]),model,vectors[0]!.length])
      add(semantic)
      ;[coverage] = await db.query(`SELECT (SELECT count(*)::int FROM entities WHERE data->>'merged_into' IS NULL) AS entities,
        (SELECT count(*)::int FROM entity_embeddings emb JOIN entities e ON e.id=emb.entity_id WHERE emb.model=$1
          AND emb.content_hash=md5(memory_entity_text(e.title,e.data)) AND e.data->>'merged_into' IS NULL) AS indexed_entities,
        (SELECT count(*)::int FROM fragments f JOIN sources s ON s.current_version_id=f.version_id AND s.status='active') AS fragments,
        (SELECT count(*)::int FROM embeddings emb JOIN fragments f ON f.id=emb.fragment_id JOIN sources s ON s.current_version_id=f.version_id AND s.status='active' WHERE emb.model=$1) AS indexed_fragments`, [model])
      status = coverage && (coverage.indexed_entities < coverage.entities || coverage.indexed_fragments < coverage.fragments) ? 'indexing' : 'ready'
    } catch (error) {
      signal?.throwIfAborted()
      status = error instanceof MemoryError && error.statusCode === 409 ? 'not_configured' : 'unavailable'
    }
    add(lexical)
  }
  const ranked = [...scores.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
  const rows = ranked.length ? await db.query(`${corpus} SELECT key,entity_id,fragment_id,version_id,title,kind,left(CASE WHEN fragment_id IS NULL THEN COALESCE(NULLIF(data->>'text',''),NULLIF(data->>'description',''),data->>'email','') ELSE content END,1200) AS preview,
    data->>'category' AS category,data->>'review_state' AS review_state,data->>'stale' AS stale,updated_at,speaker_name,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title) ORDER BY p.title),'[]') FROM entities p WHERE p.id=ANY(project_ids)) AS projects
    FROM filtered WHERE key=ANY($4::text[])`, [...params,ranked.map(([key]) => key)]) : []
  const byKey = new Map(rows.map(r => [r.key,r])), seen = new Set<string>(), items: Record<string, any>[] = []
  for (const [key] of ranked) {
    const row = byKey.get(key)
    if (!row || seen.has(row.entity_id)) continue
    seen.add(row.entity_id)
    items.push({ ...row, href: row.kind === 'project' ? `/projects/${row.entity_id}` : `/memory/entities/${row.entity_id}${row.fragment_id ? `?version=${row.version_id}&fragment=${row.fragment_id}` : ''}` })
  }
  return { items: items.slice(input.offset,input.offset+input.limit), total: items.length, limit: input.limit, offset: input.offset,
    semantic_status: status, coverage, has_more: input.offset + input.limit < items.length }
}
