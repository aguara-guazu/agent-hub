import { fullTextMatches } from './full-text.js'
import { z } from 'zod'
import { id, instant, kindSchema, MemoryError, parse } from './contracts.js'
import { queryVector, type MemoryDatabase } from './database.js'
import type { MemoryAI } from './ai.js'
import { requireEntity } from './store.js'

export const globalSearchInput = z.object({ query: z.string().trim().max(2000).default(''), kind: kindSchema.optional(),
  project_id: id.optional(), from: instant.optional(), limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000).default(0) }).strict()

// One document per entity plus its source fragments. Filters ($1 kind, $2 project, $3 from) are applied inside
// each branch, before ranking in both retrieval paths. `fts_rid` maps the row to entities_fts or fragments_fts.
const corpus = `WITH corpus AS (
  SELECT 'entity:'||e.id AS key,e.id AS entity_id,NULL AS fragment_id,NULL AS version_id,e.title,e.kind,
    memory_entity_text(e.title,e.data) AS content,e.rid AS fts_rid,e.data,e.updated_at,NULL AS speaker_name
  FROM entities e WHERE e.data->>'merged_into' IS NULL AND e.data->>'review_state' IS NOT 'rejected'
    AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.entity_id=e.id AND s.status<>'active')
    AND ($1 IS NULL OR e.kind=$1) AND ($3 IS NULL OR e.updated_at>=ts($3))
    AND ($2 IS NULL OR (e.kind='project' AND e.id=$2) OR EXISTS(SELECT 1 FROM links l WHERE l.from_id=e.id AND l.type='project' AND l.to_id=$2))
  UNION ALL
  SELECT 'fragment:'||f.id,e.id,f.id,f.version_id,e.title,e.kind,f.text,f.rid,e.data,e.updated_at,p.title
  FROM fragments f JOIN sources s ON s.current_version_id=f.version_id AND s.status='active'
    JOIN entities e ON e.id=s.entity_id LEFT JOIN entities p ON p.id=f.speaker_id
  WHERE ($1 IS NULL OR e.kind=$1) AND ($3 IS NULL OR e.updated_at>=ts($3))
    AND ($2 IS NULL OR EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$2))
)`

export async function globalSearch(db: MemoryDatabase, ai: MemoryAI, raw: unknown, signal?: AbortSignal) {
  const input = parse(globalSearchInput, raw)
  if (input.project_id) await requireEntity(db, input.project_id, 'project')
  const params = [input.kind ?? null, input.project_id ?? null, input.from ?? null]
  let status = 'not_requested', coverage: Record<string, any> | null | undefined = null
  const scores = new Map<string, number>()
  const add = (rows: Record<string, any>[]) => rows.forEach((row, rank) => scores.set(row.key, (scores.get(row.key) ?? 0) + 1 / (60 + rank + 1)))
  if (!input.query) {
    const rows = await db.query(`${corpus} SELECT key FROM corpus WHERE fragment_id IS NULL ORDER BY updated_at DESC,key LIMIT 200`, params)
    add(rows)
  } else {
    // Lexical, semantic and coverage queries are independent and run on separate reader connections.
    const lexicalParams = [...params, input.query]
    const entityMatches = fullTextMatches('entities', input.query, lexicalParams)
    const fragmentMatches = fullTextMatches('fragments', input.query, lexicalParams)
    const lexical = db.query(`${corpus},
      entity_matches AS MATERIALIZED (${entityMatches.sql}),
      fragment_matches AS MATERIALIZED (${fragmentMatches.sql})
      SELECT c.key FROM corpus c
        LEFT JOIN entity_matches em ON c.fragment_id IS NULL AND em.rid=c.fts_rid
        LEFT JOIN fragment_matches fm ON c.fragment_id IS NOT NULL AND fm.rid=c.fts_rid
      WHERE em.rid IS NOT NULL OR fm.rid IS NOT NULL ${entityMatches.operators ? '' : `OR ilike(c.content,'%'||$4||'%') OR ilike(c.title,'%'||$4||'%')`}
      ORDER BY (lower(c.title)=lower($4)) DESC,ilike(c.title,'%'||$4||'%') DESC,COALESCE(em.rank,fm.rank,0) DESC,c.key LIMIT 200`,
      lexicalParams)
    lexical.catch(() => undefined)
    try {
      const { model, vectors } = await ai.embedQuery(input.query, AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]))
      signal?.throwIfAborted()
      // Distances are materialized once per row; the stale-hash check and the corpus filter only touch candidates under the threshold.
      const semanticQuery = db.query(`${corpus}, scored AS MATERIALIZED (
        SELECT 'entity:'||entity_id AS key,entity_id,content_hash,vec_distance(embedding,$4) AS distance FROM entity_embeddings WHERE model=$5 AND dimension=$6
        UNION ALL SELECT 'fragment:'||fragment_id,NULL,NULL,vec_distance(embedding,$4) FROM embeddings WHERE model=$5 AND dimension=$6
      ) SELECT v.key FROM scored v WHERE v.distance < 0.85
          AND (v.entity_id IS NULL OR v.content_hash=(SELECT md5(memory_entity_text(e.title,e.data)) FROM entities e WHERE e.id=v.entity_id))
          AND v.key IN (SELECT key FROM corpus)
        ORDER BY v.distance,v.key LIMIT 200`, [...params,queryVector(vectors[0]!),model,vectors[0]!.length])
      const coverageQuery = db.query(`SELECT (SELECT count(*) FROM entities WHERE data->>'merged_into' IS NULL) AS entities,
        (SELECT count(*) FROM entity_embeddings emb JOIN entities e ON e.id=emb.entity_id WHERE emb.model=$1
          AND emb.content_hash=md5(memory_entity_text(e.title,e.data)) AND e.data->>'merged_into' IS NULL) AS indexed_entities,
        (SELECT count(*) FROM fragments f JOIN sources s ON s.current_version_id=f.version_id AND s.status='active') AS fragments,
        (SELECT count(*) FROM embeddings emb JOIN fragments f ON f.id=emb.fragment_id JOIN sources s ON s.current_version_id=f.version_id AND s.status='active' WHERE emb.model=$1) AS indexed_fragments`, [model])
      const [semantic, coverageRows] = await Promise.all([semanticQuery, coverageQuery])
      add(semantic)
      coverage = coverageRows[0]
      status = coverage && (coverage.indexed_entities < coverage.entities || coverage.indexed_fragments < coverage.fragments) ? 'indexing' : 'ready'
    } catch (error) {
      signal?.throwIfAborted()
      status = error instanceof MemoryError && error.statusCode === 409 ? 'not_configured' : 'unavailable'
    }
    add(await lexical)
  }
  const ranked = [...scores.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
  const rows = ranked.length ? await db.query(`${corpus} SELECT key,entity_id,fragment_id,version_id,title,kind,substr(CASE WHEN fragment_id IS NULL THEN COALESCE(NULLIF(data->>'text',''),NULLIF(data->>'description',''),data->>'email','') ELSE content END,1,1200) AS preview,
    data->>'category' AS category,data->>'review_state' AS review_state,
    CASE WHEN (data->>'stale') IN (1,'true') THEN 'true' WHEN (data->>'stale') IN (0,'false') THEN 'false' END AS stale,updated_at,speaker_name,
    (SELECT COALESCE(json_group_array(json_object('id',p.id,'title',p.title) ORDER BY p.title),'[]') FROM entities p WHERE p.id IN (
      SELECT fp.project_id FROM fragment_projects fp WHERE c.fragment_id IS NOT NULL AND fp.fragment_id=c.fragment_id
      UNION SELECT l.to_id FROM links l WHERE c.fragment_id IS NULL AND l.from_id=c.entity_id AND l.type='project'
      UNION SELECT c.entity_id WHERE c.fragment_id IS NULL AND c.kind='project')) AS "projects:json"
    FROM corpus c WHERE key IN (SELECT value FROM json_each($4))`, [...params,ranked.map(([key]) => key)]) : []
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
