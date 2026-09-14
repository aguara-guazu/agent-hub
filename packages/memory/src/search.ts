import type { MemoryDatabase } from './database.js'
import { parse, searchInput, type SearchInput, MemoryError } from './contracts.js'
import { requireEntity } from './store.js'
import type { MemoryAI } from './ai.js'

export async function searchMemory(db: MemoryDatabase, ai: MemoryAI, raw: unknown) {
  const input = parse(searchInput, raw)
  if (input.project_id) await requireEntity(db, input.project_id, 'project')
  if (input.person_id) await requireEntity(db, input.person_id, 'person')
  const filters = filterSql(input)
  let semantic: Record<string, any>[] = [], semanticStatus = input.mode === 'text' || !input.query ? 'not_requested' : 'unavailable'
  if (input.query && input.mode !== 'text') {
    try {
      const { model, vectors } = await ai.embed([input.query])
      const vector = vectors[0]!
      semantic = await db.query(`SELECT f.id,1-(emb.embedding <=> $8::vector) AS score ${joins}
        JOIN embeddings emb ON emb.fragment_id=f.id AND emb.model=$9 AND emb.dimension=$10
        WHERE ${filters.where} ORDER BY emb.embedding <=> $8::vector,f.id LIMIT 200`, [...filters.params, JSON.stringify(vector), model, vector.length])
      semanticStatus = 'ready'
    } catch (error) {
      if (input.mode === 'semantic') throw error instanceof MemoryError ? error : new MemoryError(503, 'La búsqueda semántica no está disponible; podés usar búsqueda textual')
    }
  }
  if (!input.query) {
    const items = await db.query(`${select} ${joins} WHERE ${filters.where} ORDER BY COALESCE(f.start_time,(e.data->>'occurred_at')::timestamptz,e.created_at) DESC,f.ordinal,f.id LIMIT $8 OFFSET $9`, [...filters.params, input.limit, input.offset])
    const total = (await db.query(`SELECT count(*)::int AS total ${joins} WHERE ${filters.where}`, filters.params))[0]!.total
    return { items: items.map(citation), total, limit: input.limit, offset: input.offset, semantic_status: semanticStatus, exhaustive: true, coverage: 'Fuentes actuales importadas dentro de los filtros' }
  }
  const lexical = input.mode === 'semantic' ? [] : await db.query(`SELECT f.id,
    ts_rank_cd(f.search_text,websearch_to_tsquery('simple',$8)) + CASE WHEN f.text ILIKE '%' || $8 || '%' THEN 1 ELSE 0 END AS score
    ${joins} WHERE ${filters.where} AND (f.search_text @@ websearch_to_tsquery('simple',$8) OR f.text ILIKE '%' || $8 || '%' OR e.title ILIKE '%' || $8 || '%')
    ORDER BY score DESC,f.id LIMIT 200`, [...filters.params, input.query])
  const scores = new Map<string, number>()
  for (const results of [lexical, semantic]) results.forEach((r, rank) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + rank + 1)))
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const page = ranked.slice(input.offset, input.offset + input.limit)
  const rows = page.length ? await db.query(`${select} ${joins} WHERE f.id=ANY($1::uuid[])`, [page.map(([fragmentId]) => fragmentId)]) : []
  const byId = new Map(rows.map(row => [row.id, row]))
  return { items: page.map(([fragmentId, score]) => ({ ...citation(byId.get(fragmentId)!), score })), total: ranked.length,
    limit: input.limit, offset: input.offset, semantic_status: semanticStatus, exhaustive: false,
    coverage: 'Resultados ordenados por relevancia; para recorrer todos los registros usá filtros sin texto o una colección' }
}
const joins = `FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id
  JOIN entities e ON e.id=s.entity_id LEFT JOIN entities p ON p.id=f.speaker_id`
const select = `SELECT f.*,e.id AS entity_id,e.title,e.kind,e.data->>'occurred_at' AS occurred_at,
  s.url,s.provider,p.title AS speaker_name,p.data->>'email' AS speaker_email,
  COALESCE((SELECT jsonb_agg(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS project_ids`
function filterSql(input: SearchInput) {
  return {
    params: [input.project_id ?? null, input.person_id ?? null, input.kind ?? null, input.provider ?? null, input.from ?? null, input.to ?? null, 'active'],
    where: `s.current_version_id=f.version_id AND s.status=$7
      AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$1))
      AND ($2::uuid IS NULL OR f.speaker_id=$2) AND ($3::text IS NULL OR e.kind=$3) AND ($4::text IS NULL OR s.provider=$4)
      AND ($5::timestamptz IS NULL OR COALESCE(f.start_time,(e.data->>'occurred_at')::timestamptz,e.created_at)>=$5)
      AND ($6::timestamptz IS NULL OR COALESCE(f.start_time,(e.data->>'occurred_at')::timestamptz,e.created_at)<=$6)`,
  }
}
export function citation(row: Record<string, any>) {
  return { ...row, local_url: `/#/memory/entities/${row.entity_id}?version=${row.version_id}&fragment=${row.id}` }
}
