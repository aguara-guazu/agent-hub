import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MemoryDatabase, type Sql } from './database.js'
import { check, parse, id, instant, entityInput, entityPatch, fieldsSchema, importInput, linkInput, recordInput,
  type Entity, type EntityKind, type Fragment, type ImportInput, type CollectionField } from './contracts.js'
import { parseTranscript, splitText } from './transcript.js'
import { unifyByEmail } from './people.js'

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
export async function requireEntity(sql: Sql, entityId: string, kind?: EntityKind): Promise<Entity> {
  parse(id, entityId)
  const row = (await sql.query<Entity>('SELECT * FROM entities WHERE id=$1', [entityId]))[0]
  check(row && (!kind || row.kind === kind), 'Entidad inexistente o de otro tipo', 404)
  return row
}
export async function validateProjects(sql: Sql, ids: string[]): Promise<void> {
  for (const project of new Set(ids)) await requireEntity(sql, project, 'project')
}
async function audit(sql: Sql, entityId: string, action: string, actor: string, before: unknown, after: unknown) {
  await sql.query('INSERT INTO changes(entity_id,action,actor,before_value,after_value) VALUES($1,$2,$3,$4,$5)',
    [entityId, action, actor, JSON.stringify(before), JSON.stringify(after)])
}
export async function validateEvidence(sql: Sql, ids: string[]): Promise<void> {
  if (!ids.length) return
  const rows = await sql.query('SELECT id FROM fragments WHERE id=ANY($1::uuid[])', [ids])
  check(rows.length === new Set(ids).size, 'La evidencia debe referenciar fragmentos existentes')
}
async function attachProjects(sql: Sql, entityId: string, projects: string[]) {
  await validateProjects(sql, projects)
  for (const project of new Set(projects)) {
    if (entityId === project) continue
    await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'project') ON CONFLICT(from_id,to_id,type) DO NOTHING", [randomUUID(), entityId, project])
  }
}
function validateData(data: Record<string, any>) {
  if (data.occurred_at != null) parse(instant, data.occurred_at)
  if (data.email != null && data.email !== '') parse(z.email(), data.email)
  if (data.remote_processing !== undefined) parse(z.boolean(), data.remote_processing)
}

export class MemoryStore {
  constructor(readonly db: MemoryDatabase, readonly directory: string) {}

  async create(raw: unknown, actor = 'user'): Promise<Entity> {
    const input = parse(entityInput, raw)
    return this.db.transaction(async sql => {
      const data = { ...input.data }
      validateData(data)
      if (input.kind === 'collection') { data.fields = parse(fieldsSchema, data.fields ?? []); data.schema_version = 1 }
      if (input.kind === 'project' && data.company_id) await requireEntity(sql, String(data.company_id), 'company')
      const row = (await sql.query<Entity>('INSERT INTO entities(id,kind,title,data) VALUES($1,$2,$3,$4) RETURNING *',
        [randomUUID(), input.kind, input.title, JSON.stringify(data)]))[0]!
      await attachProjects(sql, row.id, input.project_ids)
      if (input.kind === 'project' && data.company_id) await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'company')", [randomUUID(), row.id, data.company_id])
      await audit(sql, row.id, 'created', actor, null, row)
      return row
    })
  }

  async update(entityId: string, raw: unknown, actor = 'user'): Promise<Entity> {
    const input = parse(entityPatch, raw)
    if (!input.data || !('text' in input.data)) return this.updateRow(entityId, input, actor)
    return this.db.withOriginals(async () => {
      const source = (await this.db.query("SELECT * FROM sources WHERE entity_id=$1 AND provider='manual'", [parse(id, entityId)]))[0]
      if (!source?.current_version_id) return this.updateRow(entityId, input, actor)
      const original = parse(importInput, await this.original(source.current_version_id))
      const text = parse(z.string().trim().min(1).max(5_000_000), input.data!.text)
      const next = parse(importInput, { ...original, title: input.title ?? original.title, text, fragments: [], metadata: { ...original.metadata, ...input.data } })
      await this.updateRow(entityId, input, actor)
      await this.ingestOriginal(next, actor)
      return requireEntity(this.db, entityId)
    })
  }

  private async updateRow(entityId: string, raw: unknown, actor: string): Promise<Entity> {
    const input = parse(entityPatch, raw)
    return this.db.transaction(async sql => {
      await sql.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [parse(id, entityId)])
      const old = await requireEntity(sql, entityId)
      if (input.expected_updated_at) check(old.updated_at === input.expected_updated_at, 'La entidad cambió; recargá antes de guardar', 409)
      const data = { ...old.data, ...input.data }
      validateData(data)
      if (old.kind === 'collection') {
        const fields = parse(fieldsSchema, data.fields ?? [])
        const existing = parse(fieldsSchema, old.data.fields ?? [])
        // Schema evolution is additive. Existing rows must remain valid.
        for (const field of existing) check(fields.some(f => f.key === field.key && f.type === field.type && f.required === field.required), 'No se pueden quitar o cambiar campos existentes; creá un campo nuevo')
        const hasRows = (await sql.query('SELECT id FROM collection_records WHERE collection_id=$1 LIMIT 1', [entityId])).length > 0
        if (hasRows) check(fields.every(f => !f.required || existing.some(e => e.key === f.key)), 'Los campos nuevos deben ser opcionales cuando hay registros')
        data.fields = fields
        data.schema_version = Number(old.data.schema_version ?? 1) + (hash(fields) === hash(existing) ? 0 : 1)
      }
      if (old.kind === 'project' && data.company_id) await requireEntity(sql, String(data.company_id), 'company')
      if (input.title) data.manual_title = true
      if (old.kind === 'person' && input.data && 'email' in input.data) {
        data.manual_email = true
        data.email_status = data.email ? 'verified' : 'missing'
        data.email_source = 'manual'
      }
      let row = (await sql.query<Entity>('UPDATE entities SET title=$2,data=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [entityId, input.title ?? old.title, JSON.stringify(data)]))[0]!
      if (old.kind === 'person' && input.data && 'email' in input.data && data.email && data.email !== old.data.email) {
        // Typing an email that already belongs to a compatible profile is a unification; unrelated names become a review conflict.
        const unified = await unifyByEmail(sql, entityId, actor, { reason: 'manual_email' })
        if (unified.person_id !== entityId) row = await requireEntity(sql, unified.person_id)
      }
      if (old.kind === 'project' && input.data && 'company_id' in input.data) {
        await sql.query("DELETE FROM links WHERE from_id=$1 AND type='company'", [entityId])
        if (data.company_id) await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'company')", [randomUUID(), entityId, data.company_id])
      }
      await audit(sql, entityId, 'updated', actor, old, row)
      return row
    })
  }

  async list(input: { kind?: EntityKind; project_id?: string; query?: string; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200), offset = Math.max(input.offset ?? 0, 0)
    if (input.project_id) await requireEntity(this.db, input.project_id, 'project')
    const params = [input.kind ?? null, input.project_id ?? null, input.query ?? '', limit, offset]
    const where = `($1::text IS NULL OR e.kind=$1) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM links l WHERE l.from_id=e.id AND l.to_id=$2 AND l.type='project'))
      AND ($3::text='' OR e.title ILIKE '%' || $3 || '%')`
    const rows = await this.db.query<Entity>(`SELECT e.* FROM entities e WHERE ${where} ORDER BY COALESCE(e.data->>'occurred_at',e.created_at::text) DESC,e.id LIMIT $4 OFFSET $5`, params)
    const count = (await this.db.query(`SELECT count(*)::int AS total FROM entities e WHERE ${where}`, params.slice(0, 3)))[0]!
    return { items: rows, total: count.total as number, limit, offset }
  }

  async detail(entityId: string) {
    const entity = await requireEntity(this.db, entityId)
    const [links, sources, evidence, changes] = await Promise.all([
      this.db.query(`SELECT l.*,row_to_json(e) AS entity FROM links l JOIN entities e ON e.id=CASE WHEN l.from_id=$1 THEN l.to_id ELSE l.from_id END WHERE l.from_id=$1 OR l.to_id=$1 ORDER BY l.created_at DESC LIMIT 300`, [entityId]),
      this.db.query('SELECT s.*,(SELECT count(*)::int FROM versions v WHERE v.source_id=s.id) AS version_count FROM sources s WHERE entity_id=$1', [entityId]),
      this.db.query(`SELECT f.*,s.entity_id,s.url,s.current_version_id,(s.current_version_id=f.version_id) AS current FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE ev.entity_id=$1 ORDER BY f.ordinal`, [entityId]),
      this.db.query('SELECT id,action,actor,created_at FROM changes WHERE entity_id=$1 ORDER BY id DESC LIMIT 30', [entityId]),
    ])
    return { entity, links, sources, evidence, changes }
  }

  async link(raw: unknown, actor = 'user') {
    const input = parse(linkInput, raw)
    return this.db.transaction(async sql => {
      await requireEntity(sql, input.from_id); await requireEntity(sql, input.to_id)
      if (input.type === 'project') await requireEntity(sql, input.to_id, 'project')
      await validateEvidence(sql, input.evidence_ids)
      const row = (await sql.query('INSERT INTO links(id,from_id,to_id,type,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(from_id,to_id,type) DO UPDATE SET data=excluded.data RETURNING *',
        [randomUUID(), input.from_id, input.to_id, input.type, JSON.stringify(input.data)]))[0]!
      for (const fragment of input.evidence_ids) await sql.query('INSERT INTO link_evidence VALUES($1,$2) ON CONFLICT DO NOTHING', [row.id, fragment])
      // A document-level assignment includes previously unassigned fragments only. Explicit segment assignments stay intact.
      if (input.type === 'project') await sql.query(`INSERT INTO fragment_projects(fragment_id,project_id)
        SELECT f.id,$2 FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id
        WHERE s.entity_id=$1 AND NOT COALESCE((f.metadata->>'explicit_projects')::boolean,false)
        ON CONFLICT DO NOTHING`, [input.from_id, input.to_id])
      await audit(sql, input.from_id, 'linked', actor, null, input)
      return row
    })
  }

  async unlink(linkId: string, actor = 'user') {
    return this.db.transaction(async sql => {
      const row = (await sql.query('DELETE FROM links WHERE id=$1 RETURNING *', [parse(id, linkId)]))[0]
      check(row, 'Relación inexistente', 404)
      if (row.type === 'project') await sql.query(`DELETE FROM fragment_projects fp USING fragments f,versions v,sources s
        WHERE fp.fragment_id=f.id AND f.version_id=v.id AND v.source_id=s.id AND s.entity_id=$1 AND fp.project_id=$2`, [row.from_id, row.to_id])
      await audit(sql, row.from_id, 'unlinked', actor, row, null)
      return { deleted: true }
    })
  }

  async assignFragment(fragmentId: string, projects: string[], personId?: string | null, actor = 'user') {
    return this.db.transaction(async sql => {
      const before = (await sql.query<Fragment>('SELECT * FROM fragments WHERE id=$1 FOR UPDATE', [parse(id, fragmentId)]))[0]
      check(before, 'Fragmento inexistente', 404)
      await validateProjects(sql, projects)
      if (personId) await requireEntity(sql, personId, 'person')
      await sql.query('DELETE FROM fragment_projects WHERE fragment_id=$1', [fragmentId])
      for (const project of new Set(projects)) await sql.query('INSERT INTO fragment_projects VALUES($1,$2)', [fragmentId, project])
      await sql.query(`UPDATE fragments SET speaker_id=$2,metadata=metadata || '{"explicit_projects":true,"manual_assignment":true}'::jsonb WHERE id=$1`, [fragmentId, personId === undefined ? before.speaker_id : personId])
      const source = (await sql.query('SELECT s.entity_id FROM sources s JOIN versions v ON v.source_id=s.id WHERE v.id=$1', [before.version_id]))[0]!
      await attachProjects(sql, source.entity_id, projects)
      await audit(sql, source.entity_id, 'fragment.assigned', actor, before, { fragment_id: fragmentId, projects, person_id: personId })
      await sql.query('DELETE FROM rule_runs WHERE version_id=$1', [before.version_id])
      await this.enqueue('process', { version_id: before.version_id }, `process:${before.version_id}`, sql)
      return { updated: true }
    })
  }

  async ingest(raw: unknown, actor = 'user', indexOnly = false) {
    return this.db.withOriginals(() => this.ingestOriginal(raw, actor, indexOnly))
  }

  private async ingestOriginal(raw: unknown, actor: string, indexOnly = false) {
    const input = parse(importInput, raw)
    const parts = input.fragments.length ? input.fragments : input.kind === 'meeting' ? parseTranscript(input.text) : splitText(input.text)
    check(parts.length > 0 || input.kind === 'event', 'El contenido está vacío')
    const normalized = { ...input, fragments: parts }
    const digest = hash(normalized)
    const directory = join(this.directory, 'originals')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const originalPath = `${digest}.json`
    // Content-addressed immutable file; orphan files from failed transactions are collected on explicit maintenance.
    await writeFile(join(directory, originalPath), canonical(normalized), { mode: 0o600, flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    return this.db.transaction(async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${input.provider}:${input.account}:${input.external_id}`])
      await validateProjects(sql, input.project_ids)
      let source = (await sql.query('SELECT * FROM sources WHERE provider=$1 AND account=$2 AND external_id=$3 FOR UPDATE', [input.provider, input.account, input.external_id]))[0]
      const entityData = { ...input.metadata, occurred_at: input.occurred_at ?? null, timezone: input.timezone ?? null, provider: input.provider }
      if (!source) {
        const entityId = randomUUID(), sourceId = randomUUID()
        await sql.query('INSERT INTO entities(id,kind,title,data) VALUES($1,$2,$3,$4)', [entityId, input.kind, input.title, JSON.stringify(entityData)])
        source = (await sql.query('INSERT INTO sources(id,entity_id,provider,account,external_id,url,connector_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [sourceId, entityId, input.provider, input.account, input.external_id, input.url ?? null, input.connector_id ?? null]))[0]!
      } else {
        const entity = await requireEntity(sql, source.entity_id)
        check(entity.kind === input.kind, 'El ID externo ya pertenece a otro tipo de fuente', 409)
        await sql.query(`UPDATE entities SET title=CASE WHEN data->>'manual_title'='true' THEN title ELSE $2 END,
          data=data || $3::jsonb,updated_at=clock_timestamp() WHERE id=$1`, [source.entity_id, input.title, JSON.stringify(entityData)])
      }
      await attachProjects(sql, source.entity_id, input.project_ids)
      const inheritedProjects = (await sql.query("SELECT to_id FROM links WHERE from_id=$1 AND type='project'", [source.entity_id])).map(row => row.to_id as string)
      // Identity enrichment must run even when the source text is unchanged.
      const participants = new Map<string, string>()
      for (const person of input.participants) participants.set(person.external_id, await this.resolveParticipant(sql, input, person))
      const existing = (await sql.query('SELECT id FROM versions WHERE source_id=$1 AND content_hash=$2', [source.id, digest]))[0]
      if (existing && existing.id === source.current_version_id) {
        await sql.query("UPDATE sources SET synced_at=now(),status='active' WHERE id=$1", [source.id])
        return { entity_id: source.entity_id as string, source_id: source.id as string, version_id: existing.id as string, duplicate: true, fragments: parts.length }
      }
      const versionId: string = existing?.id ?? randomUUID()
      if (!existing) {
        await sql.query('INSERT INTO versions(id,source_id,content_hash,original_path,metadata) VALUES($1,$2,$3,$4,$5)', [versionId, source.id, digest, originalPath, JSON.stringify(input.metadata)])
        const corrections = source.current_version_id ? await sql.query(`SELECT f.*,COALESCE((SELECT jsonb_agg(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS project_ids
          FROM fragments f WHERE f.version_id=$1 AND f.metadata->>'manual_assignment'='true'`, [source.current_version_id]) : []
        for (const [ordinal, part] of parts.entries()) {
          let speakerId = part.speaker ? participants.get(part.speaker) : undefined
          if (part.speaker && !speakerId) {
            // Text-only speaker labels are scoped to this source; never merge names across meetings.
            speakerId = await this.resolveParticipant(sql, input, { external_id: `${input.external_id}:speaker:${part.speaker}`, name: part.speaker, identity_verified: false })
            participants.set(part.speaker, speakerId)
          }
          const fragmentId = randomUUID()
          const uniqueExternal = part.external_id && parts.filter(p => p.external_id === part.external_id).length === 1
          const matches = corrections.filter(f => (uniqueExternal && f.metadata.external_id === part.external_id)
            || (!part.external_id && f.text === part.text && f.metadata.speaker_label === (part.speaker ?? null))
            || (input.provider === 'google' && part.metadata.original_text && !f.metadata.external_id && f.metadata.tab === part.metadata.tab
              && f.text === part.metadata.original_text && parts.filter(p => p.metadata.original_text === part.metadata.original_text && p.metadata.tab === part.metadata.tab).length === 1))
          const correction = matches.length === 1 ? matches[0] : undefined
          if (correction) speakerId = correction.speaker_id ?? undefined
          const explicit = Boolean(correction) || part.project_ids !== undefined
          const projects: string[] = correction?.project_ids ?? part.project_ids ?? inheritedProjects
          await validateProjects(sql, projects)
          await sql.query('INSERT INTO fragments(id,version_id,ordinal,text,speaker_id,start_time,end_time,offset_ms,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [fragmentId, versionId, ordinal, part.text, speakerId ?? null, part.start_time ?? null, part.end_time ?? null, part.offset_ms ?? null,
              JSON.stringify({ ...part.metadata, external_id: part.external_id ?? null, explicit_projects: explicit, speaker_label: part.speaker ?? null, ...(correction ? { manual_assignment: true, corrected_from: correction.id } : {}) })])
          for (const project of new Set(projects)) await sql.query('INSERT INTO fragment_projects VALUES($1,$2)', [fragmentId, project])
          await attachProjects(sql, source.entity_id, projects)
          if (speakerId) await sql.query("INSERT INTO links(id,from_id,to_id,type) VALUES($1,$2,$3,'participant') ON CONFLICT DO NOTHING", [randomUUID(), source.entity_id, speakerId])
        }
      }
      await sql.query("UPDATE sources SET current_version_id=$2,url=COALESCE($3,url),status='active',synced_at=now() WHERE id=$1", [source.id, versionId, input.url ?? null])
      if (source.current_version_id && source.current_version_id !== versionId) {
        await sql.query(`UPDATE entities SET data=data || '{"stale":true}'::jsonb WHERE id IN
          (SELECT ev.entity_id FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id WHERE f.version_id=$1)`, [source.current_version_id])
      }
      await audit(sql, source.entity_id, 'imported', actor, { previous_version: source.current_version_id }, { version_id: versionId, fragments: parts.length })
      await this.enqueue('process', { version_id: versionId, ...(indexOnly ? { index_only: true } : {}) }, `process:${versionId}`, sql)
      return { entity_id: source.entity_id as string, source_id: source.id as string, version_id: versionId, duplicate: false, fragments: parts.length }
    })
  }

  async refreshParticipants(input: Pick<ImportInput, 'provider' | 'account'>, participants: ImportInput['participants']) {
    return this.db.transaction(async sql => {
      for (const person of participants) await this.resolveParticipant(sql, input, person)
    })
  }

  private async resolveParticipant(sql: Sql, input: Pick<ImportInput, 'provider' | 'account'>, person: ImportInput['participants'][number]): Promise<string> {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity:${input.provider}:${input.account}:${person.external_id}`])
    const existing = (await sql.query('SELECT * FROM identities WHERE provider=$1 AND account=$2 AND external_id=$3', [input.provider, input.account, person.external_id]))[0]
    const emailData = { email: person.email?.toLowerCase() ?? null, email_status: person.email ? 'verified' : person.email_status ?? 'missing',
      email_source: person.email_source ?? null, email_candidates: person.email_candidates ?? [] }
    if (existing) {
      const entity = await requireEntity(sql, existing.person_id, 'person')
      const data = { ...entity.data }
      // A provider-verified email replaces an AI inference, never a human correction.
      if (!data.manual_email && (!data.email || data.email === person.email?.toLowerCase() || (data.email_source === 'ai_auto_confirmed' && person.email))) Object.assign(data, emailData)
      if (person.identity_verified) { data.identity_verified = true; data.identity_status = 'verified' }
      if (canonical(data) !== canonical(entity.data) || (!data.manual_title && person.name && entity.title !== person.name)) {
        await sql.query('UPDATE entities SET title=$2,data=$3,updated_at=now() WHERE id=$1', [entity.id, data.manual_title ? entity.title : person.name || entity.title, JSON.stringify(data)])
        await audit(sql, entity.id, 'identity.refreshed', `connector:${input.provider}`, entity.data, data)
      }
      await sql.query('UPDATE identities SET display_name=$4,email=COALESCE($5,email),verified=verified OR $6 WHERE provider=$1 AND account=$2 AND external_id=$3',
        [input.provider, input.account, person.external_id, person.name, person.email ?? null, person.identity_verified])
      if (data.email && data.email !== entity.data.email) return (await unifyByEmail(sql, entity.id, `connector:${input.provider}`, { reason: 'provider_email' })).person_id
      return existing.person_id as string
    }
    if (person.person_id) await requireEntity(sql, person.person_id, 'person')
    const personId = person.person_id ?? randomUUID()
    if (!person.person_id) await sql.query('INSERT INTO entities(id,kind,title,data) VALUES($1,\'person\',$2,$3)',
      [personId, person.name || 'Participante sin identificar', JSON.stringify({ ...emailData, identity_verified: person.identity_verified, identity_status: person.identity_verified ? 'verified' : 'unresolved' })])
    await sql.query('INSERT INTO identities(provider,account,external_id,person_id,display_name,email,verified) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [input.provider, input.account, person.external_id, personId, person.name, person.email ?? null, person.identity_verified])
    // The same verified email arriving under a new external ID (a second account, a document label) joins the existing profile.
    if (emailData.email) return (await unifyByEmail(sql, personId, `connector:${input.provider}`, { reason: 'provider_email' })).person_id
    return personId
  }

  async fragments(entityId: string, opts: { version_id?: string; person_id?: string; project_id?: string; limit?: number; offset?: number } = {}) {
    await requireEntity(this.db, entityId)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200), offset = Math.max(opts.offset ?? 0, 0)
    const where = `s.entity_id=$1 AND f.version_id=COALESCE($2::uuid,s.current_version_id)
      AND ($3::uuid IS NULL OR f.speaker_id=$3)
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=f.id AND fp.project_id=$4))`
    const params = [entityId, opts.version_id ?? null, opts.person_id ?? null, opts.project_id ?? null]
    const items = await this.db.query(`SELECT f.*,p.title AS speaker_name,p.data->>'email' AS speaker_email,p.data->>'email_status' AS speaker_email_status,
      COALESCE((SELECT jsonb_agg(fp.project_id) FROM fragment_projects fp WHERE fp.fragment_id=f.id),'[]') AS project_ids,
      s.entity_id,s.url,(s.current_version_id=f.version_id) AS current FROM fragments f JOIN versions v ON v.id=f.version_id
      JOIN sources s ON s.id=v.source_id LEFT JOIN entities p ON p.id=f.speaker_id WHERE ${where} ORDER BY f.ordinal LIMIT $5 OFFSET $6`, [...params, limit, offset])
    const total = (await this.db.query(`SELECT count(*)::int AS total FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE ${where}`, params))[0]!.total
    const speakers = await this.db.query(`SELECT p.id,p.title,p.data->>'email' AS email,p.data->>'email_status' AS email_status,count(*)::int AS fragments
      FROM fragments f JOIN sources s ON s.entity_id=$1 AND f.version_id=COALESCE($2::uuid,s.current_version_id)
      JOIN entities p ON p.id=f.speaker_id GROUP BY p.id ORDER BY p.title`, [entityId, opts.version_id ?? null])
    return { items, total, limit, offset, speakers }
  }

  async original(versionId: string): Promise<unknown> {
    const row = (await this.db.query('SELECT original_path FROM versions WHERE id=$1', [parse(id, versionId)]))[0]
    check(row, 'Versión inexistente', 404)
    check(/^[a-f0-9]{64}\.json$/.test(row.original_path), 'Ruta de original inválida')
    return JSON.parse(await readFile(join(this.directory, 'originals', row.original_path), 'utf8'))
  }

  async addRecord(collectionId: string, raw: unknown, origin = 'manual') {
    const input = parse(recordInput, raw)
    return this.db.transaction(async sql => {
      const collection = await requireEntity(sql, collectionId, 'collection')
      const fields = parse(fieldsSchema, collection.data.fields)
      await this.validateValues(sql, fields, input.values)
      await validateEvidence(sql, input.evidence_ids)
      const row = (await sql.query(`INSERT INTO collection_records(id,collection_id,values,schema_version,idempotency_key,origin)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(collection_id,idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING *`,
        [randomUUID(), collectionId, JSON.stringify(input.values), collection.data.schema_version ?? 1, input.idempotency_key ?? null, origin]))[0]!
      for (const ev of new Set(input.evidence_ids)) await sql.query('INSERT INTO record_evidence VALUES($1,$2) ON CONFLICT DO NOTHING', [row.id, ev])
      await audit(sql, collectionId, 'record.added', origin, null, { record_id: row.id })
      return row
    })
  }

  async updateRecord(recordId: string, raw: unknown) {
    const input = parse(recordInput, raw)
    return this.db.transaction(async sql => {
      const row = (await sql.query('SELECT * FROM collection_records WHERE id=$1 FOR UPDATE', [parse(id, recordId)]))[0]
      check(row, 'Registro inexistente', 404)
      const collection = await requireEntity(sql, row.collection_id, 'collection')
      await this.validateValues(sql, parse(fieldsSchema, collection.data.fields), input.values)
      await validateEvidence(sql, input.evidence_ids)
      await sql.query('DELETE FROM record_evidence WHERE record_id=$1', [recordId])
      for (const ev of new Set(input.evidence_ids)) await sql.query('INSERT INTO record_evidence VALUES($1,$2)', [recordId, ev])
      await audit(sql, collection.id, 'record.updated', 'user', row.values, input.values)
      return (await sql.query("UPDATE collection_records SET values=$2,origin='manual',updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [recordId, JSON.stringify(input.values)]))[0]
    })
  }

  private async validateValues(sql: Sql, fields: CollectionField[], values: Record<string, unknown>) {
    check(Object.keys(values).every(key => fields.some(f => f.key === key)), 'El registro contiene campos no definidos')
    for (const field of fields) {
      const value = values[field.key]
      if (value === undefined || value === null || value === '') { check(!field.required, `Falta el campo ${field.label}`); continue }
      if (field.type === 'text') check(typeof value === 'string', `${field.label} requiere texto`)
      if (field.type === 'number') check(typeof value === 'number' && Number.isFinite(value), `${field.label} requiere un número`)
      if (field.type === 'boolean') check(typeof value === 'boolean', `${field.label} requiere verdadero/falso`)
      if (field.type === 'date') parse(z.iso.date(), value)
      if (field.type === 'datetime') parse(z.iso.datetime({ offset: true }), value)
      if (field.type === 'entity') await requireEntity(sql, parse(id, value))
    }
  }

  async records(collectionId: string, limit = 100, offset = 0, filter: Record<string, unknown> = {}) {
    await requireEntity(this.db, collectionId, 'collection')
    const params = [collectionId, JSON.stringify(filter)]
    const items = await this.db.query(`SELECT r.*,COALESCE((SELECT jsonb_agg(re.fragment_id) FROM record_evidence re WHERE re.record_id=r.id),'[]') AS evidence_ids,
      EXISTS(SELECT 1 FROM record_evidence re JOIN fragments f ON f.id=re.fragment_id JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE re.record_id=r.id AND s.current_version_id<>v.id) AS stale
      FROM collection_records r WHERE collection_id=$1 AND values @> $2::jsonb ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`, [...params, Math.min(limit, 200), offset])
    const total = (await this.db.query('SELECT count(*)::int AS total FROM collection_records WHERE collection_id=$1 AND values @> $2::jsonb', params))[0]!.total
    return { items, total, limit, offset }
  }

  async enqueue(kind: string, payload: unknown, key: string, sql: Sql = this.db) {
    const row = (await sql.query(`INSERT INTO jobs(id,kind,payload,dedupe_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(dedupe_key) WHERE state IN ('queued','running','waiting') DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING *`, [randomUUID(), kind, JSON.stringify(payload), key]))[0]!
    return row
  }
}
