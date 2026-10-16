import { createHash, randomUUID } from 'node:crypto'
import { check, parse, MemoryError } from '../contracts.js'
import { type AgentContext } from '../agents.js'
import { digest } from './crypto.js'
import { objectSchema, publicationSchema, type Publication, type SharedObject } from './schema.js'
import { SharedEvents } from './events.js'

const content = (p: Publication) => { const { previous: _previous, agent: _agent, ...value } = p; return value }
const versionContent = (p: Publication) => { const { facts: _facts, processing_key: _processing, ...value } = content(p); return value }
const factKey = (f: Publication['facts'][number]) => digest({ text: f.text.trim().replace(/\s+/g, ' '), category: f.category, evidence: [...f.evidence].sort((a, b) => a - b) })
const inputHash = (p: Publication) => digest({ ...content(p), facts: [...p.facts].sort((a, b) => factKey(a).localeCompare(factKey(b))) })
export class SharedPublications extends SharedEvents {
  /** Scan all project sources in bounded, fair batches, including connector/worker writes.
   * Persist the local input separately from received heads so unchanged local copies
   * never overwrite remote changes or implicitly resolve concurrent versions. */
  async syncSources(projectId?: string, limit = 50) {
    const db = this.store.db, projects = await db.query('SELECT id FROM shared_projects WHERE enabled=1 AND ($1 IS NULL OR id=$1) ORDER BY id', [projectId ?? null])
    let published = 0
    for (const project of projects) {
      try { await this.member(project.id, true) }
      catch (error) { if (error instanceof MemoryError && [403, 409].includes(error.statusCode)) continue; throw error }
      const sources = await db.query(`SELECT s.entity_id FROM sources s JOIN links l ON l.from_id=s.entity_id AND l.type='project' AND l.to_id=$1
        LEFT JOIN shared_source_sync c ON c.project_id=$1 AND c.entity_id=s.entity_id
        WHERE s.current_version_id IS NOT NULL ORDER BY COALESCE(c.checked_at,''),s.entity_id LIMIT $2`, [project.id, limit])
      for (const source of sources) {
        try {
          await db.withOriginals(() => db.transaction(async () => {
            await this.member(project.id, true)
            const previous = (await db.query('SELECT * FROM shared_source_sync WHERE project_id=$1 AND entity_id=$2', [project.id, source.entity_id]))[0]
            const payload = await this.source(project.id, source.entity_id, previous?.item_key ?? undefined), fingerprint = inputHash(payload)
            const result = fingerprint === previous?.input_hash ? null
              : await this.publish(project.id, source.entity_id, payload.key, undefined, previous?.heads ?? [])
            await this.sourceCheckpoint(project.id, source.entity_id, payload.key, fingerprint,
              result ? [result.event_id] : previous?.heads ?? payload.previous)
            if (result && !result.duplicate) published++
          }))
        } catch (error) {
          // One source still being prepared or too large must not prevent sharing the others.
          const message = error instanceof MemoryError ? error.message : 'No se pudo preparar esta fuente para compartir'
          await db.query(`INSERT INTO shared_source_sync(project_id,entity_id,error) VALUES($1,$2,$3)
            ON CONFLICT(project_id,entity_id) DO UPDATE SET checked_at=now(),error=excluded.error`, [project.id, source.entity_id, message])
        }
      }
    }
    return { published }
  }
  private async sourceCheckpoint(projectId: string, entityId: string, key: string, fingerprint: string, heads: string[]) {
    await this.store.db.query(`INSERT INTO shared_source_sync(project_id,entity_id,item_key,input_hash,heads) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(project_id,entity_id) DO UPDATE SET item_key=excluded.item_key,input_hash=excluded.input_hash,heads=excluded.heads,checked_at=now(),error=NULL`,
    [projectId, entityId, key, fingerprint, JSON.stringify(heads)])
  }
  async sourceSyncStatus(projectId: string) {
    return this.store.db.query(`SELECT e.id,e.title,c.error,c.checked_at FROM sources s JOIN entities e ON e.id=s.entity_id
      JOIN links l ON l.from_id=e.id AND l.type='project' AND l.to_id=$1
      LEFT JOIN shared_source_sync c ON c.project_id=$1 AND c.entity_id=e.id
      WHERE c.input_hash IS NULL OR c.error IS NOT NULL ORDER BY e.title LIMIT 100`, [projectId])
  }
  async source(projectId: string, entityId: string, key?: string, agent?: AgentContext): Promise<Publication> {
    const db = this.store.db
    const source = (await db.query(`SELECT s.*,e.title,e.kind,e.data FROM sources s JOIN entities e ON e.id=s.entity_id
      JOIN links l ON l.from_id=e.id AND l.type='project' AND l.to_id=$2 WHERE s.entity_id=$1`, [entityId, projectId]))[0]
    check(source?.current_version_id, 'Publicá una fuente vinculada a este proyecto', 404)
    const fragments = await db.query(`SELECT f.*,p.title AS speaker FROM fragments f LEFT JOIN entities p ON p.id=f.speaker_id
      WHERE f.version_id=$1 AND EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$2) ORDER BY f.ordinal`, [source.current_version_id, projectId])
    check(fragments.length > 0 || source.kind === 'event', 'No hay fragmentos de este proyecto para publicar')
    const original = await this.store.original(source.current_version_id) as any
    const allCount = (await db.query('SELECT count(*) AS n FROM fragments WHERE version_id=$1', [source.current_version_id]))[0]!.n
    // A binary cannot be selectively redacted: publishing a subset never exports its original file.
    const attachment = fragments.length === allCount && original.original?.format === 'agenthub-file-v1' ? original.original : null
    const known = (await db.query('SELECT item_key FROM shared_items WHERE project_id=$1 AND entity_id=$2', [projectId, entityId]))[0]
    // Globally stable URLs/attachment hashes bridge accounts. Account-scoped IDs never lose their namespace.
    const locator = attachment ? `file:${attachment.sha256}` : source.url ? `url:${source.url}`
      : `content:${digest({ kind: source.kind, title: source.title, fragments: fragments.map(f => ({ text: f.text, speaker: f.speaker ?? null })) })}`
    const itemKey = known?.item_key ?? key ?? digest(locator)
    const heads = await this.publicationHeads(projectId, itemKey)
    const index = new Map(fragments.map((f, i) => [f.id, i]))
    const facts = await db.query(`SELECT DISTINCT e.id,e.data FROM entities e JOIN evidence ev ON ev.entity_id=e.id
      JOIN fragments f ON f.id=ev.fragment_id WHERE f.version_id=$1 AND e.kind='fact' AND COALESCE(e.data->>'stale',0) NOT IN(1,'true')
      AND COALESCE(e.data->>'review_state','pending')<>'rejected'`, [source.current_version_id])
    const sharedFacts: Publication['facts'] = []
    for (const fact of facts) {
      const evidence = await db.query('SELECT fragment_id FROM evidence WHERE entity_id=$1', [fact.id])
      if (!evidence.length || !evidence.every(e => index.has(e.fragment_id))) continue
      if (typeof fact.data.text !== 'string') continue
      sharedFacts.push({ text: fact.data.text, category: String(fact.data.category ?? 'finding'), evidence: evidence.map(e => index.get(e.fragment_id)!),
        ...(typeof fact.data.model === 'string' ? { model: fact.data.model } : {}) })
    }
    return parse(publicationSchema, { kind: 'publication', key: itemKey, previous: heads.map(h => h.id), title: source.title, source_kind: source.kind,
      fragments: fragments.map(f => ({ text: f.text, ...(f.speaker ? { speaker: f.speaker } : {}), ...(f.offset_ms !== null ? { offset_ms: f.offset_ms } : {}) })),
      url: source.url ?? null, occurred_at: source.data.occurred_at ?? null, attachment, facts: sharedFacts,
      agent: agent?.agent_id ?? null, processing_key: source.data.shared_processing_key ?? null })
  }
  async publish(projectId: string, entityId: string, key?: string, agent?: AgentContext, previous?: string[]) {
    await this.member(projectId, true)
    const entity = (await this.store.db.query('SELECT kind FROM entities WHERE id=$1', [entityId]))[0]
    if (entity?.kind === 'collection' || !entity) return this.publishObject(projectId, entityId, key, agent)
    const payload = await this.source(projectId, entityId, key, agent)
    if (previous) payload.previous = previous
    const heads = await this.publicationHeads(projectId, payload.key)
    // Independent extraction enriches the same evidence; missing local facts must not erase other contributors' work.
    const sameVersion = heads.filter(h => digest(versionContent(h.payload)) === digest(versionContent(payload)))
    payload.facts = [...new Map([...sameVersion.flatMap(h => h.payload.facts), ...payload.facts].map(f => [factKey(f), f])).values()].sort((a, b) => factKey(a).localeCompare(factKey(b)))
    const fingerprint = digest(content(payload))
    await this.store.db.query(`INSERT INTO shared_items(project_id,item_key,entity_id,heads) VALUES($1,$2,$3,'[]') ON CONFLICT(project_id,item_key) DO NOTHING`, [projectId, payload.key, entityId])
    if (heads.some(h => digest(content(h.payload)) === fingerprint)) {
      const who = await this.identity(), matching = heads.find(h => digest(content(h.payload)) === fingerprint)!
      const observed = await this.store.db.query(`SELECT id FROM shared_events WHERE project_id=$1 AND document->>'author'=$2
        AND (id=$3 OR (payload->>'kind'='observation' AND payload->>'publication'=$3)) LIMIT 1`, [projectId, who.id, matching.id])
      if (!observed.length) await this.append(projectId, { kind: 'observation', publication: matching.id, agent: agent?.agent_id ?? null })
      return { duplicate: true, key: payload.key, event_id: matching.id }
    }
    const event = await this.append(projectId, payload)
    // An explicit publication must not rewrite the user's original source, its private fragments or reviewed facts.
    await this.store.db.query('UPDATE shared_items SET published_hash=$3,heads=$4 WHERE project_id=$1 AND item_key=$2', [projectId, payload.key, fingerprint, JSON.stringify([event.id])])
    await this.store.db.query('UPDATE shared_events SET applied=1 WHERE id=$1', [event.id])
    return { duplicate: false, key: payload.key, event_id: event.id }
  }
  async resolve(projectId: string, key: string, chosenId: string, agent?: AgentContext) {
    const objects = await this.objectHeads(projectId, key)
    if (objects.length) {
      const chosen = objects.find(o => o.id === chosenId); check(chosen, 'Versión inexistente')
      const event = await this.append(projectId, { ...chosen.payload, previous: objects.map(o => o.id), agent: agent?.agent_id ?? null })
      await this.materializeObject(projectId, key); return { event_id: event.id }
    }
    const heads = await this.publicationHeads(projectId, key), chosen = heads.find(h => h.id === chosenId)
    check(chosen, 'Elegí una de las versiones en conflicto')
    const event = await this.append(projectId, { ...chosen.payload, previous: heads.map(h => h.id), agent: agent?.agent_id ?? null })
    await this.materialize(projectId, key)
    return { event_id: event.id }
  }
  async materialize(projectId: string, key: string) {
    const heads = await this.publicationHeads(projectId, key)
    if (!heads.length) return
    const chosen = heads[0]!, p = structuredClone(chosen.payload)
    const unique = new Set(heads.map(h => digest(versionContent(h.payload))))
    if (unique.size === 1) p.facts = [...new Map(heads.flatMap(h => h.payload.facts).map(f => [factKey(f), f])).values()].sort((a, b) => factKey(a).localeCompare(factKey(b)))
    const db = this.store.db
    const mapping = (await db.query('SELECT * FROM shared_items WHERE project_id=$1 AND item_key=$2', [projectId, key]))[0]
    let existing = mapping?.entity_id ? (await db.query('SELECT s.*,e.data FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.entity_id=$1', [mapping.entity_id]))[0] : null
    if (!existing) {
      const candidates = await db.query(`SELECT s.*,e.data FROM sources s JOIN entities e ON e.id=s.entity_id JOIN links l ON l.from_id=e.id AND l.type='project' AND l.to_id=$1
        WHERE e.kind=$2 AND (s.url=$3 OR e.title=$4) LIMIT 200`, [projectId, p.source_kind, p.url, p.title])
      for (const candidate of candidates) {
        const local = await db.query(`SELECT f.text,p.title AS speaker,f.offset_ms FROM fragments f LEFT JOIN entities p ON p.id=f.speaker_id
          WHERE f.version_id=$1 ORDER BY f.ordinal`, [candidate.current_version_id])
        const normalized = local.map(f => ({ text: f.text, ...(f.speaker ? { speaker: f.speaker } : {}), ...(f.offset_ms !== null ? { offset_ms: f.offset_ms } : {}) }))
        if (digest(normalized) === digest(p.fragments)) { existing = candidate; break }
      }
    }
    const fingerprint = digest(content(p))
    if (mapping?.published_hash === fingerprint) {
      await db.query('UPDATE shared_items SET heads=$3 WHERE project_id=$1 AND item_key=$2', [projectId, key, JSON.stringify(heads.map(h => h.id))])
      await db.query("UPDATE shared_events SET applied=1 WHERE project_id=$1 AND payload->>'kind'='publication' AND payload->>'key'=$2", [projectId, key])
      return
    }
    if (p.attachment) check(createHash('sha256').update(Buffer.from(p.attachment.data_base64, 'base64')).digest('hex') === p.attachment.sha256, 'Adjunto alterado')
    const provenance = await db.query(`SELECT document->>'author' AS author,id,received_from,document->>'created_at' AS created_at
      FROM shared_events WHERE project_id=$1 AND payload->>'kind'='publication' AND payload->>'key'=$2 ORDER BY id`, [projectId, key])
    const metadata = { ...(existing?.data ?? {}), remote_processing: false, shared_project: projectId, shared_key: key,
      shared_conflict: unique.size > 1, shared_provenance: provenance, shared_processing_key: p.processing_key,
      ...(p.attachment ? { attachment: { filename: p.attachment.filename, mime_type: p.attachment.mime_type, sha256: p.attachment.sha256, size: p.attachment.size } } : {}) }
    // Reuse the originating local source where possible, so publishing never creates a second local meeting.
    const reuse = existing?.account === `shared:${projectId}` ? existing : null
    const localFragments = existing && !reuse ? await db.query('SELECT text FROM fragments WHERE version_id=$1 ORDER BY ordinal', [existing.current_version_id]) : null
    const sameLocal = localFragments && digest(localFragments.map(f => f.text)) === digest(p.fragments.map(f => f.text))
    const imported = sameLocal ? { entity_id: existing!.entity_id as string, version_id: existing!.current_version_id as string } : await this.store.ingest({ provider: reuse?.provider ?? 'manual', account: reuse?.account ?? `shared:${projectId}`,
      external_id: reuse?.external_id ?? key, kind: p.source_kind, title: p.title, project_ids: [projectId],
      ...(p.url ? { url: p.url } : {}), ...(p.occurred_at ? { occurred_at: p.occurred_at } : {}), fragments: p.fragments,
      metadata, original: p.attachment ?? { shared_event: chosen.id } }, `shared:${provenance[0]?.author ?? ''}`)
    // Shared results are projections; receiving them must never re-extract and republish them in a loop.
    await db.query(`UPDATE jobs SET payload=json_set(payload,'$.index_only',json('true')) WHERE kind='process' AND payload->>'version_id'=$1 AND state IN('queued','waiting')`, [imported.version_id])
    const fragments = await db.query('SELECT id,ordinal FROM fragments WHERE version_id=$1 ORDER BY ordinal', [imported.version_id])
    await db.transaction(async sql => {
      for (const f of p.facts) {
        check(f.evidence.every(n => n < fragments.length), 'La evidencia no pertenece a esta fuente')
        const sharedFactKey = digest({ projectId, key, text: f.text, category: f.category, evidence: f.evidence.map(n => p.fragments[n]) })
        const found = (await sql.query(`SELECT e.id FROM entities e WHERE e.kind='fact' AND (e.data->>'shared_fact_key'=$1 OR
          (e.data->>'text'=$2 AND e.data->>'category'=$3 AND EXISTS(SELECT 1 FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id WHERE ev.entity_id=e.id AND f.version_id=$4)))`, [sharedFactKey, f.text, f.category, imported.version_id]))[0]
        const factId = found?.id ?? randomUUID()
        if (!found) await sql.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'fact',$2,$3)", [factId, f.text.slice(0, 160), JSON.stringify({ text: f.text, category: f.category, review_state: 'pending', shared_fact_key: sharedFactKey, shared_project: projectId, model: f.model ?? null, shared_provenance: provenance, stale: false })])
        else await sql.query("UPDATE entities SET data=json_set(data,'$.shared_provenance',json($2),'$.stale',json('false')) WHERE id=$1", [factId, JSON.stringify(provenance)])
        for (const n of f.evidence) await sql.query('INSERT INTO evidence(entity_id,fragment_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [factId, fragments[n]!.id])
        for (const [target, type] of [[projectId, 'project'], [imported.entity_id, 'derived_from']]) await sql.query('INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [randomUUID(), factId, target, type])
      }
      await sql.query(`INSERT INTO shared_items(project_id,item_key,entity_id,heads,published_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(project_id,item_key) DO UPDATE SET entity_id=excluded.entity_id,heads=excluded.heads,published_hash=excluded.published_hash`, [projectId, key, imported.entity_id, JSON.stringify(heads.map(h => h.id)), fingerprint])
      await sql.query("UPDATE shared_events SET applied=1 WHERE project_id=$1 AND payload->>'kind'='publication' AND payload->>'key'=$2", [projectId, key])
      if (!sameLocal) {
        const baseline = await this.source(projectId, imported.entity_id, key)
        await this.sourceCheckpoint(projectId, imported.entity_id, key, inputHash(baseline), [chosen.id])
      }
    })
  }
  async applyPending() {
    const items = await this.store.db.query("SELECT DISTINCT project_id,payload->>'key' AS item_key FROM shared_events WHERE applied=0 AND payload->>'kind'='publication' LIMIT 20")
    for (const item of items) await this.materialize(item.project_id, item.item_key)
    const objects = await this.store.db.query("SELECT DISTINCT project_id,payload->>'key' AS item_key FROM shared_events WHERE applied=0 AND payload->>'kind'='object' LIMIT 20")
    for (const object of objects) await this.materializeObject(object.project_id, object.item_key)
    return items.length + objects.length
  }
  async objectHeads(projectId: string, key: string) {
    const rows = await this.store.db.query<{ id: string; payload: SharedObject }>("SELECT id,payload FROM shared_events WHERE project_id=$1 AND payload->>'kind'='object' AND payload->>'key'=$2 ORDER BY id", [projectId, key])
    const superseded = new Set(rows.flatMap(r => r.payload.previous)); return rows.filter(r => !superseded.has(r.id))
  }
  async publishObject(projectId: string, localId: string, key?: string, agent?: AgentContext) {
    const db = this.store.db
    const collection = (await db.query("SELECT e.* FROM entities e JOIN links l ON l.from_id=e.id AND l.type='project' AND l.to_id=$2 WHERE e.id=$1 AND e.kind='collection'", [localId, projectId]))[0]
    const task = (await db.query('SELECT * FROM tasks WHERE id=$1 AND project_id=$2', [localId, projectId]))[0]
    check(collection || task, 'Publicá una colección o tarea de este proyecto', 404)
    const mapping = (await db.query('SELECT item_key FROM shared_objects WHERE project_id=$1 AND local_id=$2', [projectId, localId]))[0]
    const itemKey = mapping?.item_key ?? key ?? (task?.external_key ? `task:${digest([task.external_site, task.external_key])}` : `${collection ? 'collection' : 'task'}:${localId}`)
    let value: SharedObject['value']
    if (collection) {
      const records = await db.query('SELECT id,idempotency_key,"values" FROM collection_records WHERE collection_id=$1 ORDER BY id', [localId])
      const fields = collection.data.fields ?? []
      // Entity references belong to each local database. Shared snapshots render their labels, never foreign local IDs.
      for (const record of records) for (const field of fields) if (field.type === 'entity' && record.values[field.key]) {
        const reference = (await db.query('SELECT title FROM entities WHERE id=$1', [record.values[field.key]]))[0]
        record.values[field.key] = reference?.title ?? 'Referencia no disponible'
      }
      value = { kind: 'collection', title: collection.title, description: collection.data.description ?? '',
        fields: fields.map((f: any) => ({ ...f, type: f.type === 'entity' ? 'text' : f.type })), rows: records.map(r => ({ key: r.idempotency_key ?? r.id, values: r.values })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) }
    } else value = { kind: 'task', title: task!.title, description: task!.description ?? '', status: task!.status, external_url: task!.external_url ?? null }
    const heads = await this.objectHeads(projectId, itemKey), fingerprint = digest(value)
    await db.query(`INSERT INTO shared_objects(project_id,item_key,local_id,heads) VALUES($1,$2,$3,'[]') ON CONFLICT(project_id,item_key) DO NOTHING`, [projectId, itemKey, localId])
    if (heads.some(h => digest(h.payload.value) === fingerprint)) return { duplicate: true, key: itemKey, event_id: heads[0]!.id }
    const event = await this.append(projectId, parse(objectSchema, { kind: 'object', key: itemKey, previous: heads.map(h => h.id), agent: agent?.agent_id ?? null, value }))
    await db.query('UPDATE shared_objects SET published_hash=$3,heads=$4 WHERE project_id=$1 AND item_key=$2', [projectId, itemKey, fingerprint, JSON.stringify([event.id])])
    await db.query('UPDATE shared_events SET applied=1 WHERE id=$1', [event.id])
    return { duplicate: false, key: itemKey, event_id: event.id }
  }
  async materializeObject(projectId: string, key: string) {
    const heads = await this.objectHeads(projectId, key); if (!heads.length) return
    const chosen = heads[0]!, value = chosen.payload.value, db = this.store.db
    await db.transaction(async sql => {
      const mapping = (await sql.query('SELECT * FROM shared_objects WHERE project_id=$1 AND item_key=$2', [projectId, key]))[0]
      const localId = mapping?.local_id ?? randomUUID(), fingerprint = digest(value)
      if (mapping?.published_hash !== fingerprint) {
        if (value.kind === 'collection') {
          await sql.query(`INSERT INTO entities(id,kind,title,data) VALUES($1,'collection',$2,$3)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,data=excluded.data,updated_at=now()`, [localId, value.title, JSON.stringify({ fields: value.fields, schema_version: 1, description: value.description, shared_project: projectId, shared_event: chosen.id })])
          await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'project') ON CONFLICT DO NOTHING", [randomUUID(), localId, projectId])
          // Keep complete earlier snapshots in the event log while replacing the visible table snapshot.
          await sql.query('DELETE FROM collection_records WHERE collection_id=$1', [localId])
          for (const row of value.rows) await this.store.addRecord(localId, { values: row.values, idempotency_key: row.key }, `shared:${chosen.id}`)
        } else {
          await sql.query(`INSERT INTO tasks(id,project_id,kind,title,description,status,origin,external_url,created_by,updated_by)
            VALUES($1,$2,'pending',$3,$4,$5,'agent',$6,$7,$7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
            status=excluded.status,updated_by=excluded.updated_by,updated_at=now()`, [localId, projectId, value.title, value.description, value.status, value.external_url, `shared:${chosen.id}`])
        }
      }
      await sql.query(`INSERT INTO shared_objects(project_id,item_key,local_id,heads,published_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(project_id,item_key) DO UPDATE SET heads=excluded.heads,published_hash=excluded.published_hash`, [projectId, key, localId, JSON.stringify(heads.map(h => h.id)), fingerprint])
      await sql.query("UPDATE shared_events SET applied=1 WHERE project_id=$1 AND payload->>'kind'='object' AND payload->>'key'=$2", [projectId, key])
    })
  }
  async publications(projectId: string) {
    const rows = await this.store.db.query('SELECT * FROM shared_items WHERE project_id=$1 ORDER BY item_key', [projectId])
    const items = []
    for (const row of rows) {
      const heads = await this.publicationHeads(projectId, row.item_key)
      items.push({ key: row.item_key, entity_id: row.entity_id, contributors: await this.contributors(projectId, row.item_key), conflict: new Set(heads.map(h => digest(versionContent(h.payload)))).size > 1,
        versions: heads.map(h => ({ event_id: h.id, title: h.payload.title, facts: h.payload.facts, fragments: h.payload.fragments.length })) })
    }
    for (const row of await this.store.db.query('SELECT * FROM shared_objects WHERE project_id=$1', [projectId])) {
      const heads = await this.objectHeads(projectId, row.item_key)
      items.push({ key: row.item_key, entity_id: row.local_id, contributors: await this.contributors(projectId, row.item_key), conflict: new Set(heads.map(h => digest(h.payload.value))).size > 1,
        versions: heads.map(h => ({ event_id: h.id, title: h.payload.value.title, facts: [], fragments: 0 })) })
    }
    return items
  }
  async contributors(projectId: string, key: string) {
    const project = await this.get(projectId)
    const rows = await this.store.db.query(`SELECT id,document->>'author' AS author,payload->>'agent' AS agent,received_from,document->>'created_at' AS created_at
      FROM shared_events WHERE project_id=$1 AND (payload->>'key'=$2 OR (payload->>'kind'='observation' AND payload->>'publication' IN
      (SELECT id FROM shared_events WHERE project_id=$1 AND payload->>'key'=$2))) ORDER BY seq`, [projectId, key])
    return rows.map(r => ({ ...r, name: project.policy.members.find(m => m.identity.id === r.author)?.identity.name ?? r.author }))
  }
  async version(projectId: string, eventId: string): Promise<Record<string, unknown>> {
    await this.member(projectId)
    const row = (await this.store.db.query<{ document: any; payload: Publication | SharedObject; received_from: string }>(`SELECT document,payload,received_from
      FROM shared_events WHERE id=$1 AND project_id=$2 AND payload->>'kind' IN('publication','object')`, [eventId, projectId]))[0]
    check(row, 'Versión compartida inexistente', 404)
    const payload = row.payload.kind === 'publication' ? { ...row.payload, attachment: row.payload.attachment ? {
      filename: row.payload.attachment.filename, mime_type: row.payload.attachment.mime_type, sha256: row.payload.attachment.sha256, size: row.payload.attachment.size,
    } : null } : row.payload
    return { event_id: eventId, author: row.document.author, agent: row.payload.agent, created_at: row.document.created_at, received_from: row.received_from, payload }
  }
}
