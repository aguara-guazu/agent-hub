import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Vault } from '@agenthub/memory'
import type { ConnectionPool } from '@agenthub/gateway'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { createCoreScheduleEffects } from '../src/effects/wiring.js'

let dir: string, db: Database, store: Store, ownerId: string
let authority: 'live' | 'unavailable', closeRuns: string[]
const worklog = { kind: 'jira_worklog', site: 'https://example.atlassian.net', account_id: '5b10ac8d82e05b22cc7d4ef5', issue_key: 'ABC-1', seconds: 3600, started: '2026-10-29T08:00:00.000Z', marker: 'cierre', estimate_id: 'est-1' }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'effects-attention-')); db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id; authority = 'live'; closeRuns = [] })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function build() {
  const memoryDb = { query: async (sql: string, params?: unknown[]) => {
    if (!sql.includes('schedule_artifacts')) return [] as any[]
    const asked = JSON.parse(String(params?.[0])) as string[]
    return asked.filter(run => closeRuns.includes(run)).map(run_id => ({ run_id })) as any[]
  } }
  return createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: () => true,
    host: { directory: dir, vault: new Vault(dir), google: { granted: () => false } as never, load: async () => ({ db: memoryDb,
      schedules: { set: async () => {}, artifactAuthority: async () => authority, artifactOfRun: async () => undefined, replaceDecisionRef: async () => true } }) } })
}
const propose = (effects: ReturnType<typeof build>, run: string, ttlMs: number, items = [{ ordinal: 1, kind: 'jira_worklog' as const, project_id: 'p1', summary: 'ABC-1 · 1 h', effect: worklog }]) =>
  effects.decisions.prepareDecision({ run_id: run, artifact_id: `art-${run}`, owner_id: ownerId, project_ids: ['p1'], expires_at: new Date(Date.now() + ttlMs).toISOString(), items })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it('pending_responses lista solo la cantidad, el vencimiento y el run, sin código ni digest', async () => {
  const effects = build()
  const prepared = await propose(effects, 'run-1', 60_000, [
    { ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: worklog }, { ordinal: 2, kind: 'jira_worklog', project_id: 'p1', summary: 'dos', effect: { ...worklog, issue_key: 'ABC-2' } }])
  const lines = await effects.attention!.pending_responses!()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ ref: 'run-1', project_id: 'p1' })
  expect(lines[0]!.summary).toMatch(/^Decisión pendiente: 2 ítems por aprobar \(vence /)
  const { store: decisions } = await effects.ready()
  const text = JSON.stringify(lines)
  expect(text).not.toContain(decisions.codeFor(prepared.decision_request_ref).replace(/-/g, ''))
  expect(text).not.toContain(decisions.publicRequest(prepared.decision_request_ref).canonical_digest)
  expect(text).not.toContain(prepared.decision_request_ref)
})

it('pending_responses omite la solicitud que ya no se puede responder por falta de autoridad vigente', async () => {
  const effects = build()
  await propose(effects, 'run-1', 60_000)
  authority = 'unavailable'
  expect(await effects.attention!.pending_responses!()).toEqual([])
})

it('carryover_items devuelve la copia guardada de lo que un cierre propuso y venció, con el tipo fuera del efecto', async () => {
  const effects = build()
  closeRuns = ['run-close']
  await propose(effects, 'run-close', 120)
  expect(await effects.attention!.carryover_items!()).toEqual([])
  await sleep(250)
  const { store: decisions } = await effects.ready()
  decisions.expireDue()
  const lines = await effects.attention!.carryover_items!()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ ref: 'run-close', project_id: 'p1', summary: 'ABC-1 · 1 h', effect: worklog, kind: 'jira_worklog' })
  expect((lines[0] as { effect: object }).effect).toStrictEqual(worklog)
  expect(JSON.stringify(lines)).not.toContain(decisions.codeFor(decisions.requestsOfRun('run-close')[0]!.request_id).replace(/-/g, ''))
})

it('carryover_items ignora lo que no viene de un cierre, de modo que lo arrastrado una vez no vuelve a arrastrarse', async () => {
  const effects = build()
  closeRuns = []
  await propose(effects, 'run-brief', 120)
  await sleep(250)
  const { store: decisions } = await effects.ready()
  decisions.expireDue()
  expect(await effects.attention!.carryover_items!()).toEqual([])
})

it('carryover_items no vuelve a ofrecer el ítem del cierre que el brief ya arrastró y venció', async () => {
  const effects = build()
  closeRuns = ['run-close']
  await propose(effects, 'run-close', 120)
  await sleep(250)
  const { store: decisions } = await effects.ready()
  decisions.expireDue()
  expect(await effects.attention!.carryover_items!()).toHaveLength(1)
  await propose(effects, 'run-brief', 120)
  await sleep(250)
  decisions.expireDue()
  expect(await effects.attention!.carryover_items!()).toEqual([])
})
