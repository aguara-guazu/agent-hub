import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { OpenCodeRuntime } from '../src/opencode.js'
import { spawn } from 'node:child_process'
import { MemoryError } from '../src/contracts.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { exportMemory, restoreMemory } from '../src/backup.js'
import { seedDemo } from '../src/demo.js'
import { GoogleAuth } from '../src/google-auth.js'
import { JobRunner } from '../src/jobs.js'
import { processVersion } from '../src/processing.js'
import { parseGoogleDocument } from '../src/connectors/google-document.js'
import { identityContext, inferIdentities } from '../src/identity-inference.js'
import { dedupePeople } from '../src/people-dedupe.js'
import { namesCompatible, namesRelated } from '../src/people.js'

const url = process.env.AGENTHUB_MEMORY_TEST_URL
describe.skipIf(!url)('memoria con PostgreSQL y pgvector reales', () => {
  let db: MemoryDatabase, store: MemoryStore, directory: string, operations: MemoryOperations, ai: MemoryAI, vault: Vault
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Las pruebas requieren una base dedicada terminada en _test')
    directory = await mkdtemp(join(tmpdir(), 'agenthub-memory-test-'))
    db = new MemoryDatabase(url!); await db.migrate()
    store = new MemoryStore(db, directory); vault = new Vault(directory)
    ai = new MemoryAI(async () => defaultAI, vault)
    operations = new MemoryOperations(store, ai)
  })
  beforeEach(async () => {
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='agenthub_memory' AND tablename<>'schema_versions'")
    await db.query(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`)
  })
  afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

  async function identityFixture(speakerName = 'Anita') {
    await store.refreshParticipants({ provider: 'google', account: 'work' }, [{ external_id: 'users/known', name: 'Ana Pérez', email: 'ana@example.com', identity_verified: true }])
    const meeting = await store.ingest({ provider: 'google', account: 'work', kind: 'meeting', title: 'Reunión con Anita', external_id: 'meeting-inference',
      participants: [{ external_id: 'users/unresolved', name: speakerName, identity_verified: true }], fragments: [{ text: 'Soy Ana Pérez. Mandame la propuesta al correo de la invitación.', speaker: 'users/unresolved' }] })
    const event = await store.ingest({ provider: 'google', account: 'work', kind: 'event', title: 'Calendario de la reunión', external_id: 'calendar-inference',
      metadata: { attendees: [{ displayName: 'Ana Pérez', email: 'ana@example.com' }, { displayName: 'Cliente', email: 'cliente@example.com' }] } })
    await store.link({ from_id: meeting.entity_id, to_id: event.entity_id, type: 'calendar_event' })
    await store.ingest({ provider: 'google', account: 'work', kind: 'event', title: 'Evento ajeno', external_id: 'calendar-unrelated', metadata: { attendees: [{ email: 'unrelated@example.com' }] } })
    const source = (await db.query('SELECT s.*,e.title,e.data FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.entity_id=$1', [meeting.entity_id]))[0]!
    const mockAI = { extract: async (_instructions: string, content: any) => ({ value: { matches: [{ speaker_id: content.speakers[0].id,
      candidate_id: content.candidates.find((c: any) => c.email === 'ana@example.com').id, confidence: 'high', reason: 'Se presenta con nombre completo y refiere al email de la invitación.', evidence_ids: [content.fragments[0].id] }] },
      usage: { model: 'identity-test', input_tokens: 100, output_tokens: 20 } }) } as unknown as MemoryAI
    return { meeting, event, source, mockAI }
  }

  it('infiere sólo entre candidatos conocidos, guarda evidencia y confirma el email sin cambiar las citas', async () => {
    const { meeting, source, mockAI } = await identityFixture(), progress: any[] = []
    const context = await identityContext(store, source, true)
    expect(context.candidates.map(c => c.email).sort()).toEqual(['ana@example.com', 'cliente@example.com'])
    expect(context.candidates.find(c => c.email === 'ana@example.com')!.origins.map(o => o.kind).sort()).toEqual(['calendar_invitee', 'known_person'])
    const before = (await store.fragments(meeting.entity_id)).items[0]!
    const result = await processVersion(store, mockAI, meeting.version_id, { ...defaultAI, extraction: 'ollama', extraction_model: 'identity-test', identity_auto_merge: false }, async p => { progress.push(p) }, new AbortController().signal, false, true)
    expect(result.extracted).toBe(1); expect(result.input_tokens).toBe(100)
    expect(progress.some(p => p.stage === 'identity_inference' && p.identity_current_batch === 1)).toBe(true)
    expect((await store.fragments(meeting.entity_id)).items[0]!.speaker_email).toBeNull()
    const proposal = (await operations.call('list_identity_proposals', { entity_id: meeting.entity_id })).items[0]
    expect(proposal.data).toMatchObject({ identity_status: 'inferred', review_state: 'pending', confidence: 'high' })
    expect((await store.detail(proposal.id)).evidence).toHaveLength(1)
    const known = (await db.query("SELECT person_id FROM identities WHERE external_id='users/known'"))[0]!.person_id
    const reviewed = await operations.call('review_identity', { id: proposal.id, decision: 'accepted' })
    // Confirming "this speaker is that email" folds the speaker into the profile that already owns the email.
    expect(reviewed).toMatchObject({ person_id: known, merged_into: known })
    const after = (await store.fragments(meeting.entity_id)).items[0]!
    expect(after.id).toBe(before.id); expect(after.speaker_email).toBe('ana@example.com'); expect(after.speaker_id).toBe(known)
    expect((await store.detail(proposal.data.speaker_id)).entity.data).toMatchObject({ merged_into: known, identity_status: 'merged' })
    expect((await store.detail(known)).entity.data.merged_from).toEqual([proposal.data.speaker_id])
    expect((await operations.call('list_identity_proposals', { state: 'accepted' })).items[0].data).toMatchObject({ applied: 'merged', speaker_id: known })
    expect((await db.query("SELECT count(*)::int AS n FROM entities WHERE kind='person' AND data->>'merged_into' IS NULL AND data->>'email'='ana@example.com'"))[0]!.n).toBe(1)
    await store.refreshParticipants({ provider: 'google', account: 'work' }, [{ external_id: 'users/unresolved', name: 'Anita', email: 'other@example.com', identity_verified: true }])
    expect((await store.fragments(meeting.entity_id)).items[0]!.speaker_email).toBe('ana@example.com')
  })

  it('aplica automáticamente una inferencia de confianza alta y unifica con la persona conocida', async () => {
    const { meeting, mockAI } = await identityFixture('Ana P.')
    const known = (await db.query("SELECT person_id FROM identities WHERE external_id='users/known'"))[0]!.person_id
    const result = await processVersion(store, mockAI, meeting.version_id, { ...defaultAI, extraction: 'ollama', extraction_model: 'identity-test' }, async () => {}, new AbortController().signal, false, true)
    expect(result.extracted).toBe(1)
    const proposal = (await operations.call('list_identity_proposals', { state: 'accepted' })).items[0]
    expect(proposal.data).toMatchObject({ confidence: 'high', reviewed_by: 'ai:auto', applied: 'merged', speaker_id: known })
    expect((await store.fragments(meeting.entity_id)).items[0]).toMatchObject({ speaker_id: known, speaker_email: 'ana@example.com' })
    expect((await db.query("SELECT payload FROM jobs WHERE kind='dedupe_people'")).length).toBe(1)
    expect((await store.detail(known)).changes.some(c => c.action === 'person.merged' && c.actor === 'ai:auto')).toBe(true)
  })

  it('no aplica automáticamente cuando el nombre del hablante no se parece al de la persona conocida', async () => {
    await store.refreshParticipants({ provider: 'google', account: 'work' }, [{ external_id: 'users/known', name: 'Ana Pérez', email: 'ana@example.com', identity_verified: true }])
    const meeting = await store.ingest({ provider: 'google', account: 'work', kind: 'meeting', title: 'Reunión', external_id: 'meeting-mismatch',
      participants: [{ external_id: 'users/other', name: 'Roberto Gómez', identity_verified: true }], fragments: [{ text: 'Hola, soy yo.', speaker: 'users/other' }] })
    const mockAI = { extract: async (_i: string, content: any) => ({ value: { matches: [{ speaker_id: content.speakers[0].id, candidate_id: content.candidates[0].id, confidence: 'high', reason: 'Sin fundamento.', evidence_ids: [content.fragments[0].id] }] },
      usage: { model: 'identity-test', input_tokens: 1, output_tokens: 1 } }) } as unknown as MemoryAI
    await processVersion(store, mockAI, meeting.version_id, { ...defaultAI, extraction: 'ollama', extraction_model: 'identity-test' }, async () => {}, new AbortController().signal, false, true)
    const pending = (await operations.call('list_identity_proposals', {})).items[0]
    expect(pending.data.auto_apply_blocked).toContain('no coinciden')
    expect((await store.fragments(meeting.entity_id)).items[0]!.speaker_email).toBeNull()
    expect((await operations.call('list_identity_proposals', { state: 'accepted' })).total).toBe(0)
  })

  it('unifica por email verificado al sincronizar y deja un conflicto cuando los nombres no coinciden', async () => {
    expect(namesCompatible('Gastón Zárate', 'Gaston Zarate')).toBe(true); expect(namesCompatible('Ana Carolina Perez', 'Manuel Alejandro Gil')).toBe(false)
    expect(namesRelated({ title: 'Gastón' }, { title: 'Gaston Zarate', email: 'gaston.zarate@example.com' })).toBe(true); expect(namesRelated({ title: 'Matias Roson' }, { title: 'Matias Machado' })).toBe(false)
    const account = { provider: 'google' as const, account: 'work' }
    await store.refreshParticipants(account, [{ external_id: 'users/a', name: 'Ana Pérez', email: 'ana@example.com', identity_verified: true, email_source: 'google_people:people/a' }])
    await store.ingest({ ...account, kind: 'meeting', title: 'Segunda cuenta', external_id: 'second-account', participants: [{ external_id: 'users/b', name: 'Ana Perez', identity_verified: true }], fragments: [{ text: 'Hola.', speaker: 'users/b' }] })
    await store.refreshParticipants(account, [{ external_id: 'users/b', name: 'Ana Perez', email: 'ana@example.com', identity_verified: true }])
    const owners = await db.query("SELECT DISTINCT person_id FROM identities WHERE external_id IN ('users/a','users/b')")
    expect(owners).toHaveLength(1)
    expect((await store.fragments((await store.list({ kind: 'meeting' })).items[0]!.id)).items[0]!.speaker_id).toBe(owners[0]!.person_id)
    await store.refreshParticipants(account, [{ external_id: 'users/c', name: 'Carlos López', email: 'ana@example.com', identity_verified: true }])
    expect((await db.query("SELECT count(*)::int AS n FROM entities WHERE kind='person' AND data->>'merged_into' IS NULL AND data->>'email'='ana@example.com'"))[0]!.n).toBe(2)
    const conflicts = await operations.call('list_duplicate_proposals', {})
    expect(conflicts.total).toBe(1); expect(conflicts.items[0].data).toMatchObject({ basis: 'same_email', verdict: 'conflict' })
    await operations.call('review_duplicate', { id: conflicts.items[0].id, decision: 'rejected' })
    await store.refreshParticipants(account, [{ external_id: 'users/c', name: 'Carlos López', email: 'ana@example.com', identity_verified: true }])
    expect((await operations.call('list_duplicate_proposals', {})).total).toBe(0)
  })

  it('deduplica personas con la IA: unifica en confianza alta, propone en media y respeta decisiones humanas y señales en contra', async () => {
    const account = { provider: 'google' as const, account: 'work' }
    const meeting = await store.ingest({ ...account, kind: 'meeting', title: 'Sync semanal', external_id: 'meet-sync', occurred_at: '2026-09-10T13:00:00Z',
      participants: [{ external_id: 'users/rodrigo', name: 'Rodrigo Miranda', email: 'rodrigo@example.com', identity_verified: true, email_source: 'google_people:people/r' },
        { external_id: 'users/franco', name: 'Franco Martinez', email: 'franco@example.com', identity_verified: true, email_source: 'google_people:people/f' }],
      fragments: [{ text: 'Soy Rodrigo, arranco con el estado del proyecto.', speaker: 'users/rodrigo' }, { text: 'Franco por acá, sigo yo.', speaker: 'users/franco' }] })
    const document = await store.ingest({ ...account, kind: 'document', title: 'Transcripción del sync', external_id: 'docs:sync', fragments: [{ text: 'Arranco con el estado del proyecto.', speaker: 'Rodrigo Miranda' }, { text: 'Perfecto, gracias.', speaker: 'Julián Díaz' }, { text: 'Sigo yo.', speaker: 'Franco Martinez' }] })
    await store.link({ from_id: document.entity_id, to_id: meeting.entity_id, type: 'meeting_document' })
    await store.ingest({ ...account, kind: 'document', title: 'Otro documento', external_id: 'docs:other', fragments: [{ text: 'Rodrigo por acá.', speaker: 'Rodrigo' }, { text: 'Hola a todos.', speaker: 'Julián D.' }] })
    await store.ingest({ ...account, kind: 'meeting', title: 'Homónimas', external_id: 'meet-twins', fragments: [{ text: 'Hola, soy Ana.', speaker: 'Ana' }, { text: 'Yo también soy Ana.', speaker: 'Ana P.' }] })
    let calls = 0
    const verdictFor = (pair: any) => {
      const names = [pair.a.name, pair.b.name].map((n: string) => n.toLowerCase()).sort()
      if (names[0] === names[1] && names[0] === 'rodrigo miranda') return { same: true, confidence: 'high', reason: `${pair.a.id} y ${pair.b.id} comparten nombre y el documento está vinculado a la reunión (${pair.a.samples[0]?.id ?? 'f1'}).` }
      if (names[0] === names[1] && names[0] === 'franco martinez') return { same: true, confidence: 'medium', reason: 'Mismo nombre completo; la etiqueta del documento no tiene email.' }
      if (names.includes('ana') && names.includes('ana p.')) return { same: true, confidence: 'high', reason: 'Ambas se presentan como Ana.' }
      if (names.some((n: string) => n.startsWith('julián')) || names.includes('rodrigo')) return { same: true, confidence: 'medium', reason: 'Nombre de pila coincidente.' }
      return { same: false, confidence: 'low', reason: 'Sin relación.' }
    }
    const mockAI = { extract: async (_i: string, content: any) => { calls++; return { value: { pairs: content.pairs.map((pair: any) => ({ pair_id: pair.pair_id, evidence_ids: pair.a.samples.slice(0, 1).map((s: any) => s.id), ...verdictFor(pair) })) },
      usage: { model: 'dedupe-test', input_tokens: 10, output_tokens: 5 } } } } as unknown as MemoryAI
    const config = { ...defaultAI, extraction: 'ollama' as const, extraction_model: 'dedupe-test' }
    const first = await dedupePeople(store, mockAI, config, async () => {}, new AbortController().signal)
    expect(first).toMatchObject({ dedupe_auto_merged: 2, dedupe_batches: 1 }) // Rodrigo (high) and Franco (medium, identical full name + label without email)
    expect(first.dedupe_proposals).toBeGreaterThanOrEqual(3)
    const rodrigo = (await db.query("SELECT person_id FROM identities WHERE external_id='users/rodrigo'"))[0]!.person_id
    const label = (await db.query("SELECT person_id FROM identities WHERE external_id='docs:sync:speaker:Rodrigo Miranda'"))[0]!.person_id
    expect(label).toBe(rodrigo) // the document label now resolves to the Meet profile
    expect((await store.fragments(document.entity_id)).items[0]).toMatchObject({ speaker_id: rodrigo, speaker_email: 'rodrigo@example.com' })
    expect((await store.fragments(document.entity_id)).items[2]!.speaker_email).toBe('franco@example.com')
    const accepted = (await operations.call('list_duplicate_proposals', { state: 'accepted' })).items
    const high = accepted.find((p: any) => p.data.into_id === rodrigo), corroboratedPair = accepted.find((p: any) => p.data.into_name === 'Franco Martinez')
    expect(high.data).toMatchObject({ reviewed_by: 'ai:auto', applied: 'merged', applied_rule: 'high_confidence' }); expect(high.data.reason).not.toMatch(/\bp\d\b/)
    expect(corroboratedPair.data).toMatchObject({ confidence: 'medium', applied_rule: 'medium_corroborated' })
    expect((await store.detail(high.id)).evidence).toHaveLength(1)
    const pending = (await operations.call('list_duplicate_proposals', {})).items
    const twins = pending.find((p: any) => p.data.from_name.startsWith('Ana'))
    expect(twins.data.blocked).toBe('shared_transcript') // high confidence but they speak as two people in the same transcript
    // Nothing new to ask: pending pairs and identical contexts are not resent.
    const before = calls
    await dedupePeople(store, mockAI, config, async () => {}, new AbortController().signal)
    expect(calls).toBe(before)
    const julian = pending.find((p: any) => p.data.from_name.startsWith('Julián'))
    expect(julian.data.confidence).toBe('medium') // different spellings are not corroborated by name alone
    await operations.call('review_duplicate', { id: julian.id, decision: 'rejected' })
    const nick = pending.find((p: any) => p.data.from_name === 'Rodrigo' || p.data.into_name === 'Rodrigo')
    const merged = await operations.call('review_duplicate', { id: nick.id, decision: 'accepted' })
    expect(merged.person_id).toBe(rodrigo)
    await dedupePeople(store, mockAI, { ...config, extraction_model: 'another-model' }, async () => {}, new AbortController().signal)
    expect((await operations.call('list_duplicate_proposals', { state: 'rejected' })).items.some((p: any) => p.id === julian.id)).toBe(true)
    expect((await operations.call('list_duplicate_proposals', {})).items.some((p: any) => p.data.from_name.startsWith('Julián') && p.id !== julian.id)).toBe(false)
    expect((await db.query("SELECT count(*)::int AS n FROM entities WHERE kind='person' AND data->>'merged_into' IS NULL AND lower(title) LIKE 'rodrigo%'"))[0]!.n).toBe(1)
    // Every absorbed profile points directly at an active one, and nothing else still references it.
    expect((await db.query("SELECT count(*)::int AS n FROM entities a JOIN entities b ON b.id=(a.data->>'merged_into')::uuid WHERE b.data->>'merged_into' IS NOT NULL"))[0]!.n).toBe(0)
    expect((await db.query("SELECT count(*)::int AS n FROM fragments f JOIN entities p ON p.id=f.speaker_id WHERE p.data->>'merged_into' IS NOT NULL"))[0]!.n).toBe(0)
  })

  it('no unifica automáticamente perfiles con emails verificados distintos ni cuando la unificación automática está apagada', async () => {
    const account = { provider: 'google' as const, account: 'work' }
    await store.ingest({ ...account, kind: 'meeting', title: 'A', external_id: 'm-a', participants: [{ external_id: 'users/l1', name: 'Lucas Izquierdo', email: 'lucas@one.example', identity_verified: true }], fragments: [{ text: 'Hola.', speaker: 'users/l1' }] })
    await store.ingest({ ...account, kind: 'meeting', title: 'B', external_id: 'm-b', participants: [{ external_id: 'users/l2', name: 'Lucas Izquierdo', email: 'lucas@two.example', identity_verified: true }], fragments: [{ text: 'Buenas.', speaker: 'users/l2' }] })
    const mockAI = { extract: async (_i: string, content: any) => ({ value: { pairs: content.pairs.map((pair: any) => ({ pair_id: pair.pair_id, same: true, confidence: 'high', reason: 'Mismo nombre.', evidence_ids: [] })) }, usage: { model: 'dedupe-test', input_tokens: 1, output_tokens: 1 } }) } as unknown as MemoryAI
    const result = await dedupePeople(store, mockAI, { ...defaultAI, extraction: 'ollama', extraction_model: 'dedupe-test' }, async () => {}, new AbortController().signal)
    expect(result).toMatchObject({ dedupe_auto_merged: 0, dedupe_proposals: 1 })
    expect((await operations.call('list_duplicate_proposals', {})).items[0].data.blocked).toBe('different_verified_emails')
    await store.ingest({ ...account, kind: 'document', title: 'Doc', external_id: 'docs:l', fragments: [{ text: 'Lucas habla.', speaker: 'Lucas Izquierdo' }] })
    const off = await dedupePeople(store, mockAI, { ...defaultAI, extraction: 'ollama', extraction_model: 'dedupe-test', identity_auto_merge: false }, async () => {}, new AbortController().signal)
    expect(off.dedupe_auto_merged).toBe(0)
    expect((await operations.call('list_duplicate_proposals', {})).items.every((p: any) => ['different_verified_emails', 'auto_merge_disabled'].includes(p.data.blocked))).toBe(true)
    // Turning the setting back on re-reads the pending verdicts without asking the model again.
    const calls = vi.fn(mockAI.extract as any)
    const on = await dedupePeople(store, { extract: calls } as unknown as MemoryAI, { ...defaultAI, extraction: 'ollama', extraction_model: 'dedupe-test' }, async () => {}, new AbortController().signal)
    expect(on.dedupe_auto_merged).toBe(1); expect(calls).not.toHaveBeenCalled()
    expect((await db.query("SELECT count(*)::int AS n FROM entities WHERE kind='person' AND data->>'merged_into' IS NULL AND lower(title)='lucas izquierdo'"))[0]!.n).toBe(2)
    expect((await operations.call('list_duplicate_proposals', {})).items.every((p: any) => p.data.blocked === 'different_verified_emails')).toBe(true)
  })

  it('tolera entradas inválidas o abstenciones del modelo sin descartar el lote', async () => {
    const { source, mockAI } = await identityFixture()
    const noisy = { extract: async (...args: any[]) => {
      const result = await (mockAI.extract as any)(...args)
      result.value.matches = [{ speaker_id: 's1', candidate_id: null, confidence: 'low', reason: 'Sin candidato', evidence_ids: ['f1'] }, { bogus: true }, ...result.value.matches]
      return result
    } } as unknown as MemoryAI
    const result = await inferIdentities(store, noisy, source, true, 'identity-test', async () => {}, new AbortController().signal)
    expect(result).toMatchObject({ identity_suggestions: 1, identity_rejected: 1 })
  })

  it('rechaza correos inventados y evidencia ajena antes de escribir propuestas', async () => {
    const { source, mockAI } = await identityFixture()
    for (const invalid of [{ candidate_id: 'invented' }, { evidence_ids: [randomUUID()] }, { speaker_id: randomUUID() }]) {
      const invalidAI = { extract: async (...args: any[]) => {
        const result = await (mockAI.extract as any)(...args)
        Object.assign(result.value.matches[0], invalid); return result
      } } as unknown as MemoryAI
      const result = await inferIdentities(store, invalidAI, source, true, 'identity-test', async () => {}, new AbortController().signal)
      expect(result.identity_rejected).toBe(1)
    }
    expect((await operations.call('list_identity_proposals', {})).total).toBe(0)
  })

  it.each(['deepseek', 'opencode'] as const)('respeta exclusiones remotas de %s y no vuelve a proponer vínculos descartados', async extraction => {
    const { meeting, event, source, mockAI } = await identityFixture()
    const privateProject = await store.create({ kind: 'project', title: 'Privado', data: { remote_processing: false } })
    await store.link({ from_id: event.entity_id, to_id: privateProject.id, type: 'project' })
    expect((await identityContext(store, source, true)).candidates.map(c => c.email)).toEqual(['ana@example.com'])
    await store.update(meeting.entity_id, { data: { remote_processing: false } })
    const excluded = await processVersion(store, mockAI, meeting.version_id, { ...defaultAI, extraction, remote_processing_enabled: true }, async () => {}, new AbortController().signal, false, true)
    expect(excluded.extraction).toBe('disabled_for_source')
    expect((await operations.call('list_identity_proposals', {})).total).toBe(0)
    await inferIdentities(store, mockAI, source, false, 'identity-test', async () => {}, new AbortController().signal)
    const proposal = (await operations.call('list_identity_proposals', {})).items[0]
    await operations.call('review_identity', { id: proposal.id, decision: 'rejected' })
    await inferIdentities(store, mockAI, source, false, 'another-model', async () => {}, new AbortController().signal)
    expect((await operations.call('list_identity_proposals', {})).total).toBe(0)
    expect((await operations.call('list_identity_proposals', { state: 'rejected' })).total).toBe(1)
  })

  it('no permite confirmar una inferencia tras una corrección manual', async () => {
    const { meeting, source, mockAI } = await identityFixture()
    await inferIdentities(store, mockAI, source, true, 'identity-test', async () => {}, new AbortController().signal)
    const proposal = (await operations.call('list_identity_proposals', {})).items[0]
    await store.update(proposal.data.speaker_id, { data: { email: 'manual@example.com' } })
    await expect(operations.call('review_identity', { id: proposal.id, decision: 'accepted' })).rejects.toThrow('corregida')
    expect((await store.fragments(meeting.entity_id)).items[0]!.speaker_email).toBe('manual@example.com')
  })

  it('reemplaza evidencia obsoleta por una propuesta de la versión actual', async () => {
    const { meeting, source, mockAI } = await identityFixture()
    await inferIdentities(store, mockAI, source, true, 'identity-test', async () => {}, new AbortController().signal)
    const old = (await operations.call('list_identity_proposals', {})).items[0]
    const original = await store.original(meeting.version_id) as any
    await store.ingest({ ...original, metadata: { revision: 'updated' } })
    const current = (await db.query('SELECT s.*,e.title,e.data FROM sources s JOIN entities e ON e.id=s.entity_id WHERE s.id=$1', [source.id]))[0]!
    await inferIdentities(store, mockAI, current, true, 'identity-test', async () => {}, new AbortController().signal)
    const proposals = await operations.call('list_identity_proposals', {})
    expect(proposals.total).toBe(2)
    await expect(operations.call('review_identity', { id: old.id, decision: 'accepted' })).rejects.toThrow('cambió')
    const fresh = proposals.items.find((p: any) => p.id !== old.id)
    await operations.call('review_identity', { id: fresh.id, decision: 'accepted' })
    expect((await store.fragments(meeting.entity_id)).items[0]!.speaker_email).toBe('ana@example.com')
  })

  it('importa una reunión multi-cliente una vez y separa la evidencia por proyecto y hablante', async () => {
    const demo = await seedDemo(store)
    await seedDemo(store)
    const meetings = await store.list({ kind: 'meeting' })
    expect(meetings.total).toBe(1)
    const all = await store.fragments(demo.meeting)
    expect(all.total).toBe(4)
    const north = await operations.call('search', { project_id: demo.projects[0], query: '', mode: 'text' })
    expect(north.items.some((r: any) => r.text.includes('En Sur'))).toBe(false)
    const south = await operations.call('search', { project_id: demo.projects[1], query: '', mode: 'text' })
    expect(south.items).toHaveLength(2)
    const person = all.items[1]!.speaker_id
    const quotes = await operations.call('search', { person_id: person, query: '', mode: 'text' })
    expect(quotes.items).toHaveLength(2)
    expect(quotes.exhaustive).toBe(true)
    expect(quotes.items[0].local_url).toContain('version=')
  })

  it('conserva versiones y citas históricas cuando cambia la transcripción', async () => {
    const input = { kind: 'meeting', title: 'Reunión', external_id: 'versioned', text: 'Ana: La entrega será el lunes.' }
    const first = await store.ingest(input)
    const before = await store.fragments(first.entity_id)
    const second = await store.ingest({ ...input, text: 'Ana: La entrega será el miércoles.' })
    expect(first.entity_id).toBe(second.entity_id)
    expect(first.version_id).not.toBe(second.version_id)
    const evidence = await operations.call('get_evidence', { fragment_id: before.items[0]!.id })
    expect(evidence.current).toBe(false)
    expect(evidence.text).toContain('lunes')
    const current = await store.fragments(first.entity_id)
    expect(current.items[0]!.text).toContain('miércoles')
    const original = await store.original(first.version_id) as any
    expect(original.text).toContain('lunes')
  })

  it('serializa importaciones concurrentes de la misma fuente', async () => {
    const input = { kind: 'document', title: 'NDA', external_id: 'concurrent', text: 'Acuerdo de confidencialidad de ejemplo.' }
    const results = await Promise.all(Array.from({ length: 6 }, () => store.ingest(input)))
    expect(new Set(results.map(r => r.entity_id)).size).toBe(1)
    expect(results.filter(r => !r.duplicate)).toHaveLength(1)
  })

  it('actualiza el índice de una nota editada sin perder la cita anterior', async () => {
    const note = await operations.call('create_entity', { kind: 'note', title: 'Entrega', data: { text: 'Entregamos el lunes' } })
    const old = (await store.fragments(note.id)).items[0]!
    await operations.call('update_entity', { id: note.id, data: { text: 'Entregamos el viernes' } })
    expect((await store.fragments(note.id)).items[0]!.text).toContain('viernes')
    expect((await operations.call('search', { query: 'lunes', mode: 'text' })).total).toBe(0)
    expect((await operations.call('get_evidence', { fragment_id: old.id })).text).toContain('lunes')
  })

  it('conserva correcciones manuales al recibir una versión nueva', async () => {
    const project = await store.create({ kind: 'project', title: 'Cliente confirmado' })
    const person = await store.create({ kind: 'person', title: 'Hablante confirmado', data: { email: 'ana@example.com' } })
    const input = { kind: 'meeting', title: 'Reunión', external_id: 'corrected', fragments: [{ external_id: 'entry1', text: 'Primera versión', speaker: 'Invitado' }] }
    const source = await store.ingest(input)
    const before = (await store.fragments(source.entity_id)).items[0]!
    await store.assignFragment(before.id, [project.id], person.id)
    await store.ingest({ ...input, fragments: [{ ...input.fragments[0], text: 'Texto corregido por el proveedor' }] })
    const after = (await store.fragments(source.entity_id)).items[0]!
    expect(after.speaker_id).toBe(person.id); expect(after.project_ids).toEqual([project.id])
    expect(after.metadata.corrected_from).toBe(before.id)
  })

  it('coordina respaldo, eliminación e importación sin perder originales vigentes', async () => {
    const input = { kind: 'document', title: 'Concurrente', external_id: 'lifecycle', text: 'Original conservado' }
    const first = await store.ingest(input)
    const [backup] = await Promise.all([
      exportMemory(store), operations.call('delete_entity', { id: first.entity_id }), store.ingest(input),
    ])
    const exported = JSON.parse(await readFile(join(directory, 'backups', `${backup.id}.json`), 'utf8'))
    expect(Object.keys(exported.originals)).toHaveLength(1)
    const current = (await store.list({ kind: 'document' })).items[0]!
    const source = (await store.detail(current.id)).sources[0]!
    expect((await store.original(source.current_version_id) as any).text).toBe(input.text)
  })

  it('conserva una atribución manual al recuperar diálogos de Docs y al insertar párrafos anteriores', async () => {
    const person = await store.create({ kind: 'person', title: 'Ana confirmada', data: { email: 'ana@example.com' } })
    const base = { provider: 'google', account: 'work', kind: 'document', title: 'Transcripción', external_id: 'docs:corrected' }
    const source = await store.ingest({ ...base, fragments: [{ text: 'Ana: Entrego el martes.', metadata: { tab: 't', start_index: 1 } }] })
    await store.assignFragment((await store.fragments(source.entity_id)).items[0]!.id, [], person.id)
    const parsed = (lines: string[]) => parseGoogleDocument({ documentId: 'corrected', tabs: [{ tabProperties: { tabId: 't', title: 'Transcripción' },
      documentTab: { body: { content: lines.map((text, index) => ({ startIndex: index * 100 + 1, paragraph: { elements: [{ textRun: { content: text } }] } })) } } }] })
    for (const lines of [['Ana: Entrego el martes.'], ['Invitado: Hola.', 'Ana: Entrego el martes.']]) {
      const { fragments, participants } = parsed(lines)
      await store.ingest({ ...base, fragments, participants })
      const items = (await store.fragments(source.entity_id)).items
      expect(items.find(f => f.text === 'Entrego el martes.')!.speaker_id).toBe(person.id)
      expect(items.find(f => f.text === 'Hola.')?.speaker_id).not.toBe(person.id)
    }
    const { fragments, participants } = parsed(['Ana: Entrego el martes.', 'Ana: Entrego el martes.'])
    await store.ingest({ ...base, fragments, participants })
    expect((await store.fragments(source.entity_id)).items.every(f => f.speaker_id !== person.id)).toBe(true)
  })

  it('no identifica a dos hablantes por el mismo nombre ni inventa emails', async () => {
    await store.ingest({ kind: 'meeting', external_id: 'one', title: 'Uno', text: 'Juan: Proyecto A.' })
    await store.ingest({ kind: 'meeting', external_id: 'two', title: 'Dos', text: 'Juan: Proyecto B.' })
    const people = await store.list({ kind: 'person' })
    expect(people.total).toBe(2)
    expect(people.items.every(p => p.data.email === null && p.data.identity_status === 'unresolved')).toBe(true)
    await operations.call('merge_people', { from_id: people.items[0]!.id, into_id: people.items[1]!.id })
    expect((await db.query('SELECT DISTINCT speaker_id FROM fragments')).length).toBe(1)
    expect((await store.detail(people.items[0]!.id)).entity.data.merged_into).toBe(people.items[1]!.id)
  })

  it('valida filas, referencias y evolución aditiva del esquema de una colección', async () => {
    const collection = await store.create({ kind: 'collection', title: 'Horarios', data: { fields: [
      { key: 'hour', label: 'Horario', type: 'text', required: true }, { key: 'duration', label: 'Duración', type: 'number', required: false },
    ] } })
    await expect(store.addRecord(collection.id, { values: { hour: '14:00', duration: 'one' } })).rejects.toThrow('número')
    await expect(store.addRecord(collection.id, { values: { hour: '14:00' }, evidence_ids: [randomUUID()] })).rejects.toThrow('evidencia')
    await store.addRecord(collection.id, { values: { hour: '14:00', duration: 3 }, idempotency_key: 'same' })
    await store.addRecord(collection.id, { values: { hour: '14:00', duration: 3 }, idempotency_key: 'same' })
    expect((await store.records(collection.id)).total).toBe(1)
    await expect(store.update(collection.id, { data: { fields: [] } })).rejects.toThrow('quitar')
    const updated = await store.update(collection.id, { data: { fields: [...collection.data.fields, { key: 'zone', label: 'Zona', type: 'text' }] } })
    expect(updated.data.schema_version).toBe(2)
  })

  it('enriquece identidades existentes sin perder citas y preserva el email corregido manualmente', async () => {
    const person = { external_id: 'users/123', name: 'Ana', identity_verified: true }
    const input = { provider: 'google', account: 'work', kind: 'meeting', title: 'Reunión', external_id: 'conference', participants: [person], fragments: [{ text: 'Entrego el martes.', speaker: person.external_id }] }
    const imported = await store.ingest(input)
    const original = (await store.fragments(imported.entity_id)).items[0]!
    await store.refreshParticipants({ provider: 'google', account: 'work' }, [{ ...person, email: 'ana@example.com', email_source: 'google_people:people/123' }])
    const refreshed = await store.fragments(imported.entity_id)
    expect(refreshed.items[0]!.id).toBe(original.id)
    expect(refreshed.items[0]!.speaker_email).toBe('ana@example.com')
    expect(refreshed.speakers).toHaveLength(1)
    await store.update(original.speaker_id, { data: { email: 'manual@example.com' } })
    await store.ingest({ ...input, participants: [{ ...person, email: 'remote@example.com' }] })
    expect((await store.fragments(imported.entity_id)).items[0]!.speaker_email).toBe('manual@example.com')
    expect((await operations.call('get_evidence', { fragment_id: original.id })).text).toBe('Entrego el martes.')
  })

  it('expone progreso antes de esperar al modelo y asocia el trabajo a la fuente y sus resultados', async () => {
    const imported = await store.ingest({ kind: 'meeting', title: 'Prueba observable', external_id: 'progress', text: 'Ana: Entrego el martes.' })
    await store.update(imported.entity_id, { data: { project_decision: 'none' } })
    const progress: any[] = []
    const extractor = { extract: async (_instructions: string, content: any) => {
      expect(progress.at(-1)).toMatchObject({ stage: 'extraction', current_batch: 1 })
      expect(progress.some(p => p.total_batches === 1)).toBe(true)
      expect(content.fragments[0].search_text).toBeUndefined()
      return { value: { facts: [{ text: 'Ana entregará el martes.', category: 'commitment', evidence_ids: [content.fragments[0].id], project_ids: [] }] }, usage: { model: 'fixture', input_tokens: 100, output_tokens: 30 } }
    } } as unknown as MemoryAI
    const result = await processVersion(store, extractor, imported.version_id, { ...defaultAI, extraction: 'ollama', extraction_model: 'fixture' }, async p => { progress.push(p) }, new AbortController().signal)
    expect(result).toMatchObject({ extraction: 'processed', extracted: 1, input_tokens: 100, output_tokens: 30 })
    expect(progress.at(-1)).toMatchObject({ batch: 1, processed_fragments: 1 })
    const jobs = await operations.call('list_jobs', { kind: 'process', state: 'active' })
    expect(jobs.items[0]).toMatchObject({ entity_id: imported.entity_id, source_title: 'Prueba observable' })
    expect((await operations.call('processing_status', {})).coverage).toMatchObject({ sources: 1, extracted: 1 })
  })

  it('aplica filtros de proyecto también a los vecinos semánticos', async () => {
    const demo = await seedDemo(store)
    const fragments = (await store.fragments(demo.meeting)).items
    for (const f of fragments) await db.query('INSERT INTO embeddings(fragment_id,model,dimension,embedding) VALUES($1,$2,3,$3::vector)', [f.id, 'fixture', '[1,0,0]'])
    const embeddingAI = new MemoryAI(async () => ({ ...defaultAI, embeddings_enabled: true, embedding_model: 'fixture' }), vault,
      async () => new Response(JSON.stringify({ embeddings: [[1,0,0]] }), { status: 200 }) as any)
    const semantic = new MemoryOperations(store, embeddingAI)
    const results = await semantic.call('search', { query: 'disponibilidad', project_id: demo.projects[0], mode: 'semantic' })
    expect(results.items).toHaveLength(2)
    expect(results.items.every((f: any) => f.project_ids.includes(demo.projects[0]))).toBe(true)
  })

  it('descarta hechos con evidencia inventada o formato inválido sin perder el resto del lote', async () => {
    const source = await store.ingest({ kind: 'document', title: 'Fuente', external_id: 'facts', text: 'El cliente solicita una demo.' })
    await store.update(source.entity_id, { data: { project_decision: 'none' } })
    const fragment = (await store.fragments(source.entity_id)).items[0]!
    const config = { ...defaultAI, extraction: 'ollama' as const, extraction_model: 'fixture' }
    const model = new MemoryAI(async () => config, vault, async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ facts: [
      { category: 'decision', text: 'Inventado', evidence_ids: [randomUUID()], project_ids: [] }, { category: 'otra', text: '', evidence_ids: [fragment.id] },
      { category: 'commitment', text: 'El cliente pide una demo.', evidence_ids: [fragment.id], project_ids: [] }] }) } })) as any)
    const result = await processVersion(store, model, source.version_id, config, async () => {}, new AbortController().signal)
    expect(result).toMatchObject({ extracted: 1, extraction_rejected: 2 })
    expect((await store.list({ kind: 'fact' })).total).toBe(1)
  })

  it.each(['deepseek', 'opencode'] as const)('no envía contenido a %s cuando un proyecto relacionado lo excluye', async extraction => {
    const project = await store.create({ kind: 'project', title: 'Proyecto privado', data: { remote_processing: false } })
    const source = await store.ingest({ kind: 'document', title: 'NDA', external_id: 'private', text: 'Contenido privado', project_ids: [project.id] })
    const config = { ...defaultAI, extraction, remote_processing_enabled: true }
    let requests = 0
    const model = new MemoryAI(async () => config, vault, async () => { requests++; throw new Error('No debería llamar al proveedor') })
    const result = await processVersion(store, model, source.version_id, config, async () => {}, new AbortController().signal)
    expect(requests).toBe(0); expect(result.extraction).toBe('disabled_for_source')
  })

  it('completa una regla persistente y no duplica filas al reprocesar', async () => {
    const demo = await seedDemo(store)
    const source = (await store.detail(demo.meeting)).sources[0]!
    const fragments = await store.fragments(demo.meeting), evidence = fragments.items[1]!.id
    await operations.call('create_rule', { name: 'Horarios', collection_id: demo.collection, instructions: 'Guardar horarios mencionados.', project_ids: [demo.projects[0]] })
    const config = { ...defaultAI, extraction: 'ollama' as const, extraction_model: 'fixture' }
    const model = new MemoryAI(async () => config, vault, async (_url, options) => {
      const body = JSON.parse(String(options?.body)), isRule = body.messages[0].content.includes('Regla del usuario')
      return new Response(JSON.stringify({ message: { content: JSON.stringify(isRule ? { records: [{ values: { horario: 'Martes de 14 a 17' }, evidence_ids: [evidence] }] } : { facts: [] }) } }))
    })
    await processVersion(store, model, source.current_version_id, config, async () => {}, new AbortController().signal)
    await processVersion(store, model, source.current_version_id, config, async () => {}, new AbortController().signal, true)
    expect((await store.records(demo.collection)).total).toBe(2) // one manually seeded row and one rule result
    expect((await db.query('SELECT * FROM rule_runs')).length).toBe(1)
  })

  it('procesa automáticamente una transcripción nueva con OpenCode y conserva hechos, reglas y evidencias', async () => {
    const collection = await store.create({ kind: 'collection', title: 'Hallazgos', data: { fields: [{ key: 'text', label: 'Texto', type: 'text' }] } })
    await operations.call('create_rule', { name: 'Hallazgos', collection_id: collection.id, instructions: 'Guardar el hallazgo.' })
    const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: 'fixture/chat', remote_processing_enabled: true }
    const extract = vi.fn(async (model: string, _system: string, content: any, schema: any, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      const evidence_ids = [content.fragments[0].id]
      const value = schema.properties.verdicts ? { verdicts: [{ project_ref: 'none', confidence: 'low', reason: 'No hay proyecto existente.', evidence_ids,
        suggested_title: 'Demo', suggested_description: '' }] }
        : schema.properties.records ? { records: [{ values: { text: 'Solicitan una demo.' }, evidence_ids }] }
        : { facts: [{ category: 'finding', text: 'Solicitan una demo.', evidence_ids, project_ids: [] }] }
      return { value, usage: { model, input_tokens: 10, output_tokens: 5 } }
    })
    const model = new MemoryAI(async () => defaultAI, vault, fetch, { extract } as unknown as OpenCodeRuntime)
    const runner = new JobRunner(store, model, vault, new GoogleAuth(vault, 'http://127.0.0.1/callback'), async () => config)
    const input = { kind: 'meeting', title: 'Nueva reunión', external_id: 'auto-opencode', text: 'Solicitan una demo.' }
    const source = await store.ingest(input)
    expect((await operations.call('list_jobs', { state: 'queued' })).total).toBe(1)
    await runner.once(new AbortController().signal)
    const jobs = await operations.call('list_jobs', { kind: 'process' })
    expect(jobs.items[0]).toMatchObject({ state: 'completed', progress: { provider: 'opencode', model: 'fixture/chat', extracted: 1 } })
    const facts = await store.list({ kind: 'fact' })
    const finding = facts.items.find(f => f.data.category === 'finding')!
    expect(finding.data).toMatchObject({ category: 'finding', review_state: 'pending', model: 'fixture/chat' })
    expect((await store.detail(finding.id)).evidence[0]!.entity_id).toBe(source.entity_id)
    expect((await store.records(collection.id)).total).toBe(1)
    expect(extract).toHaveBeenCalledTimes(3)
    await store.ingest(input)
    await runner.once(new AbortController().signal) // pending people deduplication
    expect(extract).toHaveBeenCalledTimes(3)
    expect((await store.list({ kind: 'fact' })).items.filter(f => f.data.category === 'finding')).toHaveLength(1)
  })

  it.skipIf(!process.env.AGENTHUB_OPENCODE_LIVE_MODEL)('procesa una reunión y una regla con un modelo real de OpenCode en segundo plano', async () => {
    const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: process.env.AGENTHUB_OPENCODE_LIVE_MODEL!, remote_processing_enabled: true }
    const runtime = new OpenCodeRuntime(directory, { launch: (command, args, options) =>
      spawn(command, [args[0]!.replace('/src/opencode-host.js', '/dist/opencode-host.js'), args[1]!], options) })
    try {
      const collection = await store.create({ kind: 'collection', title: 'Decisiones de prueba', data: { fields: [{ key: 'text', label: 'Decisión', type: 'text' }] } })
      await operations.call('create_rule', { name: 'Decisiones', collection_id: collection.id, instructions: 'Guardá una fila por cada decisión explícita, en el campo text, con evidencia.' })
      const model = new MemoryAI(async () => config, vault, fetch, runtime)
      const runner = new JobRunner(store, model, vault, new GoogleAuth(vault, 'http://127.0.0.1/callback'), async () => config)
      const source = await store.ingest({ kind: 'meeting', external_id: 'real-opencode-test', title: 'Reunión sintética de validación',
        text: 'Decidimos publicar la versión de prueba el viernes. Detectamos que faltan pruebas de integración y debemos completarlas antes de publicar.' })
      await runner.once(new AbortController().signal)
      const job = (await operations.call('list_jobs', { kind: 'process' })).items[0]
      expect(job, job.error).toMatchObject({ state: 'completed', attempts: 1, progress: { provider: 'opencode', model: config.extraction_model } })
      const facts = await store.list({ kind: 'fact' })
      expect(facts.total).toBeGreaterThan(0)
      for (const fact of facts.items) expect((await store.detail(fact.id)).evidence.some(e => e.entity_id === source.entity_id)).toBe(true)
      expect((await store.records(collection.id)).total).toBeGreaterThan(0)
    } finally { await runtime.close() }
  }, 180_000)

  it.each([409, 502])('un error OpenCode %s sólo se reintenta si es transitorio', async status => {
    const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: 'fixture/chat', remote_processing_enabled: true }
    const extract = vi.fn().mockRejectedValue(new MemoryError(status, 'Error de modelo verificado'))
    const model = new MemoryAI(async () => config, vault, fetch, { extract } as unknown as OpenCodeRuntime)
    const source = await store.ingest({ kind: 'meeting', external_id: 'opencode-error', title: 'Prueba', text: 'Una decisión explícita.' })
    await store.update(source.entity_id, { data: { project_decision: 'none' } })
    const runner = new JobRunner(store, model, vault, new GoogleAuth(vault, 'http://127.0.0.1/callback'), async () => config)
    await runner.once(new AbortController().signal)
    expect((await operations.call('list_jobs', { kind: 'process' })).items[0]).toMatchObject({ state: status === 409 ? 'failed' : 'waiting', attempts: 1 })
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('recupera trabajos con lease vencido y los ejecuta una sola vez', async () => {
    const source = await store.ingest({ kind: 'document', external_id: 'job', title: 'Trabajo', text: 'Texto.' })
    await db.query("UPDATE jobs SET state='running',lease_owner='old',lease_until=now()-interval '1 minute'")
    const runner = new JobRunner(store, ai, vault, new GoogleAuth(vault, 'http://127.0.0.1/callback'), async () => defaultAI)
    await runner.schedule(); await runner.once(new AbortController().signal)
    const job = (await db.query('SELECT * FROM jobs WHERE payload->>\'version_id\'=$1', [source.version_id]))[0]!
    expect(job.state).toBe('completed')
    expect(await runner.once(new AbortController().signal)).toBe(false)
  })

  it('exporta y restaura originales, relaciones y vectores sin credenciales', async () => {
    const demo = await seedDemo(store)
    const fragment = (await store.fragments(demo.meeting)).items[0]!
    await db.query('INSERT INTO embeddings(fragment_id,model,dimension,embedding) VALUES($1,$2,3,$3::vector)', [fragment.id, 'fixture', '[1,0,0]'])
    vault.save('deepseek', { api_key: 'private-test-value' })
    const backup = await exportMemory(store), content = await readFile(join(directory, 'backups', `${backup.id}.json`), 'utf8')
    expect(content).not.toContain('private-test-value')
    await expect(restoreMemory(store, JSON.parse(content))).rejects.toThrow('vacía')
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='agenthub_memory' AND tablename<>'schema_versions'")
    await db.query(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} RESTART IDENTITY CASCADE`)
    await restoreMemory(store, JSON.parse(content))
    expect((await store.fragments(demo.meeting)).total).toBe(4)
    expect((await db.query('SELECT * FROM embeddings')).length).toBe(1)
    expect((await store.records(demo.collection)).total).toBe(1)
    expect(await store.original(fragment.version_id)).toBeTruthy()
  })

  it('borra fuentes, vectores y filas dependientes sin borrar un proyecto relacionado', async () => {
    const demo = await seedDemo(store)
    await operations.call('delete_entity', { id: demo.meeting })
    expect((await store.list({ kind: 'project' })).total).toBe(2)
    expect((await store.records(demo.collection)).total).toBe(0)
    expect((await db.query('SELECT * FROM fragments f JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1', [demo.meeting])).length).toBe(0)
  })
})
