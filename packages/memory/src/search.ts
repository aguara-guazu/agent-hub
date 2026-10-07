import { fullTextMatches, substringMatch } from './full-text.js'
import { queryVector, type MemoryDatabase } from './database.js'
import { check, parse, searchInput, type SearchInput, MemoryError } from './contracts.js'
import { requireEntity } from './store.js'
import type { MemoryAI } from './ai.js'

export async function searchMemory(db: MemoryDatabase, ai: MemoryAI, raw: unknown) {
  const input = parse(searchInput, raw)
  if (input.project_id) await requireEntity(db, input.project_id, 'project')
  if (input.person_id) await requireEntity(db, input.person_id, 'person')
  check(!(input.project_id && input.unassigned), 'Usa project_id o unassigned, no ambos')
  const filters = filterSql(input)
  let semantic: Record<string, any>[] = [], semanticStatus = input.mode === 'text' || !input.query ? 'not_requested' : 'unavailable'
  if (input.query && input.mode !== 'text') {
    try {
      const { model, vectors } = await ai.embedQuery(input.query)
      const vector = vectors[0]!
      semantic = await db.query(`SELECT f.id,vec_distance(emb.embedding,$8) AS distance ${currentJoins}
        JOIN embeddings emb ON emb.fragment_id=f.id AND emb.model=$9 AND emb.dimension=$10
        WHERE ${filters.where} ORDER BY distance,f.id LIMIT 200`, [...filters.params, queryVector(vector), model, vector.length])
      semanticStatus = 'ready'
    } catch (error) {
      if (input.mode === 'semantic') throw error instanceof MemoryError ? error : new MemoryError(503, 'La búsqueda semántica no está disponible; podés usar búsqueda textual')
    }
  }
  if (!input.query) {
    const items = await db.query(`${select} ${joins} WHERE ${filters.where} ORDER BY ${occurredAt} DESC,f.ordinal,f.id LIMIT $8 OFFSET $9`, [...filters.params, input.limit, input.offset])
    const total = (await db.query(`SELECT count(*) AS total ${joins} WHERE ${filters.where}`, filters.params))[0]!.total
    return { items: items.map(citation), total, limit: input.limit, offset: input.offset, semantic_status: semanticStatus, exhaustive: true, coverage: 'Fuentes actuales importadas dentro de los filtros' }
  }
  // bm25 is squashed into [0,1) so a literal substring match keeps outranking token relevance, as with ts_rank_cd.
  const lexicalParams = [...filters.params, input.query]
  const matches = fullTextMatches('fragments', input.query, lexicalParams)
  const substring = substringMatch(input.query)
  const substringParam = substring && !matches.operators ? (lexicalParams.push(substring), `$${lexicalParams.length}`) : null
  const textMatch = `ilike(f.text,'%' || $8 || '%')`
  const lexical = input.mode === 'semantic' ? [] : await db.query(`WITH fts AS MATERIALIZED (${matches.sql}),
    candidates AS (
      SELECT f.id,fts.rank/(1+fts.rank) + CASE WHEN ${textMatch} THEN 1 ELSE 0 END AS score
      FROM fts CROSS JOIN fragments f ON f.rid=fts.rid JOIN sources s ON s.current_version_id=f.version_id
        JOIN entities e ON e.id=s.entity_id WHERE ${filters.where}
      ${matches.operators ? '' : `UNION ALL
        SELECT f.id,1 AS score
        ${substringParam ? `FROM fragments_substrings CROSS JOIN fragments f ON f.rid=fragments_substrings.rowid
          JOIN sources s ON s.current_version_id=f.version_id JOIN entities e ON e.id=s.entity_id` : currentJoins}
        WHERE ${filters.where} AND ${textMatch} ${substringParam ? `AND fragments_substrings MATCH ${substringParam}` : ''}
        UNION ALL
        SELECT f.id,CASE WHEN ${textMatch} THEN 1 ELSE 0 END AS score
        ${currentJoins} WHERE ${filters.where} AND ilike(e.title,'%' || $8 || '%')`}
    ) SELECT id,max(score) AS score FROM candidates GROUP BY id ORDER BY score DESC,id LIMIT 200`, lexicalParams)

  const scores = new Map<string, number>()
  for (const results of [lexical, semantic]) results.forEach((r, rank) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + rank + 1)))
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const page = ranked.slice(input.offset, input.offset + input.limit)
  const rows = page.length ? await db.query(`${select} ${joins} WHERE f.id IN (SELECT value FROM json_each($1))`, [page.map(([fragmentId]) => fragmentId)]) : []
  const byId = new Map(rows.map(row => [row.id, row]))
  return { items: page.map(([fragmentId, score]) => ({ ...citation(byId.get(fragmentId)!), score })), total: ranked.length,
    limit: input.limit, offset: input.offset, semantic_status: semanticStatus, exhaustive: false,
    coverage: 'Resultados ordenados por relevancia; para recorrer todos los registros usá filtros sin texto o una colección' }
}
// Start with the few current sources, avoiding historical fragments and repeated entity/version lookups.
const currentJoins = `FROM sources s JOIN entities e ON e.id=s.entity_id
  CROSS JOIN fragments f ON f.version_id=s.current_version_id`
const joins = `FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id
  JOIN entities e ON e.id=s.entity_id LEFT JOIN entities p ON p.id=f.speaker_id`
const select = `SELECT f.*,e.id AS entity_id,e.title,e.kind,e.data->>'occurred_at' AS occurred_at,
  s.url,s.provider,p.title AS speaker_name,p.data->>'email' AS speaker_email,
  COALESCE((SELECT json_group_array(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS "project_ids:json"`
const occurredAt = `COALESCE(f.start_time,ts(e.data->>'occurred_at'),e.created_at)`
function filterSql(input: SearchInput) {
  return {
    params: [input.project_id ?? null, input.person_id ?? null, input.kind ?? null, input.provider ?? null, input.from ?? null, input.to ?? null, 'active'],
    where: `s.current_version_id=f.version_id AND s.status=$7
      AND ($1 IS NULL OR EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$1))
      AND ($2 IS NULL OR f.speaker_id=$2) AND ($3 IS NULL OR e.kind=$3) AND ($4 IS NULL OR s.provider=$4)
      AND ($5 IS NULL OR ${occurredAt}>=ts($5))
      AND ($6 IS NULL OR ${occurredAt}<=ts($6))
      ${input.unassigned ? `AND NOT EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id) AND NOT EXISTS(SELECT 1 FROM links pl WHERE pl.from_id=e.id AND pl.type='project')` : ''}`,
  }
}
export function citation(row: Record<string, any>) {
  return { ...row, ...(row.metadata?.attachment ? { attachment: { ...row.metadata.attachment, download_url: `/api/memory/files/${row.version_id}` }, media_position: { offset_ms: row.offset_ms, end_offset_ms: row.metadata.end_offset_ms, page: row.metadata.page, region: row.metadata.region } } : {}), local_url: `/#/memory/entities/${row.entity_id}?version=${row.version_id}&fragment=${row.id}` }
}
