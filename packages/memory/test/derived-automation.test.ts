import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryError } from '../src/contracts.js'
import { DecisionService, DecisionStore } from '../src/decisions/index.js'
import { createDerivedPorts, DerivedDispatcher } from '../src/derived-automation.js'

const key = randomBytes(32), OWNER = 'owner-1'
let now = new Date('2026-10-28T20:00:00.000Z'), dir: string, db: MemoryDatabase, store: DecisionStore, authority: 'live' | 'unavailable' | 'unknown', seq = 0, projectId: string, otherProject: string

function service() { return new DecisionService(store, async () => authority) }
const ports = () => createDerivedPorts({ decisions: service(), ownerId: () => OWNER, automationsEnabled: () => true })

/** An approved request whose reply also carries follow-ups; returns the request id. */
async function approved(items: Array<{ project: string; kind?: 'jira_worklog' | 'git_push' }>, followUps: Array<{ ordinal: number; text: string }>) {
  seq++
  const prepared = store.prepareDecision({ run_id: `run-${seq}`, artifact_id: `art-${seq}`, owner_id: OWNER, project_ids: items.map(item => item.project), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    items: items.map((item, index) => ({ kind: item.kind ?? 'jira_worklog', project_id: item.project, summary: `Ítem ${index + 1}`, exact_effect: { n: seq, index } })) })
  const reserved = await store.reserveDelivery({ request_id: prepared.request_id, integration: 'gmail', account: 'me@example.com', correlation: `<h${seq}@hub>`, provenance: 'test' })
  store.beginSend(reserved.delivery_id)
  await store.recordNative(reserved.delivery_id, { native_id: `n${seq}`, thread_id: `t${seq}` })
  const consumed = store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: `m${seq}`, binding_id: reserved.binding_id,
    parsed: { kind: 'approve', code: store.codeFor(prepared.request_id).replace(/-/g, ''), items: 'all', follow_ups: followUps } })
  if (consumed.outcome !== 'approved') throw new Error(`no aprobado: ${consumed.outcome}`)
  await db.query('INSERT INTO schedule_artifacts(id,run_id,kind,title,body_md,decision_request_ref) VALUES($1,$2,$3,$4,$5,$6)', [`art-${seq}`, `run-${seq}`, 'close', 't', 'b', prepared.request_id])
  return prepared.request_id
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-derived-ports-')); db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  // The artifacts here stand for runs that other areas own; only their decision_request_ref matters.
  await db.query('PRAGMA foreign_keys=OFF')
  now = new Date(); authority = 'live'; seq = 0; projectId = randomUUID(); otherProject = randomUUID()
  store = new DecisionStore(':memory:', { key, now: () => now, exclusions: { async add() {} } })
})
afterEach(async () => { store.close(); await db.close(); await rm(dir, { recursive: true, force: true }) })

describe('puertos de planes derivados sobre el almacén de decisiones', () => {
  it('exposes approved items with their public summary, the folded state and the follow-up text, and never a code', async () => {
    const request = await approved([{ project: projectId }, { project: otherProject }], [{ ordinal: 1, text: 'Revisa la rama feature/x' }])
    const view = await ports().approved(request)
    expect(view.items.map(item => [item.ordinal, item.project_id, item.kind, item.summary, item.state])).toEqual([[1, projectId, 'jira_worklog', 'Ítem 1', 'approved'], [2, otherProject, 'jira_worklog', 'Ítem 2', 'approved']])
    expect(view.items.every(item => /^[0-9a-f]{64}$/.test(item.effect_digest ?? ''))).toBe(true)
    expect(view.follow_ups).toEqual([{ project_id: projectId, ordinal: 1, text: 'Revisa la rama feature/x', ref: expect.stringMatching(/^[0-9a-f]{32}$/), source: 'channel_reply', expires_at: expect.any(String) }])
    expect(view.canonical_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toContain(store.codeFor(request))
  })

  it('reports a request as live only while it is neither dead nor expired and its artifact authority is live', async () => {
    const request = await approved([{ project: projectId }], [{ ordinal: 1, text: 'x' }])
    expect(await ports().live(request)).toBe(true)
    authority = 'unavailable'
    expect(await ports().live(request)).toBe(false)
    authority = 'live'
    expect(await ports().live('missing')).toBe(false)
    now = new Date(now.getTime() + 2 * 3600_000)
    expect(await ports().live(request)).toBe(false)
  })

  it('claims a follow-up once per consumer, denies another consumer, and denies everything without authority', async () => {
    const request = await approved([{ project: projectId }], [{ ordinal: 1, text: 'x' }])
    const claim = (consumer: string, project = projectId) => ports().claimFollowUp(request, project, consumer)
    expect(await claim('derived:a')).toBe('claimed')
    expect(await claim('derived:a')).toBe('already_claimed_by_same')
    expect(await claim('derived:b')).toBe('already_claimed_by_other')
    expect(await claim('derived:a', otherProject)).toBe('not_found')
    authority = 'unavailable'
    expect(await claim('derived:a')).toBe('authority_unavailable')
  })
})

describe('despachador de planes derivados', () => {
  const teams = { launchDerived: vi.fn(async () => ({}) as any), expireDerived: vi.fn(async () => ({ closed: [] as string[], failed: [] as string[] })), derivedAvailable: vi.fn(() => true) }
  async function activate(project: string, over: { coordinator?: boolean; channel?: boolean; revoked?: boolean } = {}) {
    await db.query("INSERT INTO entities(id,kind,title) VALUES($1,'project','P') ON CONFLICT DO NOTHING", [project])
    await db.query('INSERT INTO project_automation(project_id,enabled,delegation_version,coordinator_session_id,updated_by_user) VALUES($1,1,1,$2,$3)', [project, over.coordinator === false ? null : 'system:x', 'owner'])
    await db.query('INSERT INTO project_delegations(project_id,version,document,digest,approval_source,created_by_user,revoked_at) VALUES($1,1,$2,$3,$4,$5,$6)',
      [project, JSON.stringify(over.channel === false ? { item_kinds: [] } : { channel: { name: 'c', objective: 'o' } }), 'd', 'owner_ui', 'owner', over.revoked ? new Date().toISOString() : null])
  }
  const dispatcher = (over: Record<string, unknown> = {}) => new DerivedDispatcher({ db, teams, decisions: service(), now: () => now.getTime(), ...over })
  beforeEach(() => { for (const fn of Object.values(teams)) fn.mockClear(); teams.derivedAvailable.mockReturnValue(true) })

  it('offers each unclaimed follow-up of an activated project to launchDerived and nothing else', async () => {
    await activate(projectId)
    const request = await approved([{ project: projectId }, { project: otherProject }], [{ ordinal: 1, text: 'a' }, { ordinal: 2, text: 'b' }])
    const result = await dispatcher().tick()
    expect(teams.launchDerived).toHaveBeenCalledExactlyOnceWith({ project_id: projectId, delegation_version: 1, request_id: request })
    expect(result).toMatchObject({ launched: [`${projectId}:${request}`], failed: [], skipped: null })
    teams.launchDerived.mockClear()
    await ports().claimFollowUp(request, projectId, 'derived:x')
    await dispatcher().tick()
    expect(teams.launchDerived).not.toHaveBeenCalled()
  })

  it('skips projects without a coordinator, without an authorized channel or with a revoked version, and old requests', async () => {
    await activate(projectId, { coordinator: false }); await activate(otherProject, { channel: false })
    const third = randomUUID(); await activate(third, { revoked: true })
    await approved([{ project: projectId }, { project: otherProject }, { project: third }], [{ ordinal: 1, text: 'a' }, { ordinal: 2, text: 'b' }, { ordinal: 3, text: 'c' }])
    await dispatcher().tick()
    expect(teams.launchDerived).not.toHaveBeenCalled()
    const fresh = randomUUID(); await activate(fresh)
    await approved([{ project: fresh }], [{ ordinal: 1, text: 'a' }])
    await dispatcher({ lookbackMs: -1000 }).tick()
    expect(teams.launchDerived).not.toHaveBeenCalled()
  })

  it('does nothing but expire plans while derived plans cannot launch, and stops offering a request after repeated failures', async () => {
    await activate(projectId)
    await approved([{ project: projectId }], [{ ordinal: 1, text: 'a' }])
    teams.derivedAvailable.mockReturnValue(false)
    expect(await dispatcher().tick()).toMatchObject({ skipped: 'unavailable', launched: [] })
    expect(teams.expireDerived).toHaveBeenCalledTimes(1)
    expect(teams.launchDerived).not.toHaveBeenCalled()
    teams.derivedAvailable.mockReturnValue(true)
    teams.launchDerived.mockRejectedValue(new MemoryError(409, 'tope'))
    const repeated = dispatcher({ maxAttempts: 2 })
    for (let index = 0; index < 4; index++) await repeated.tick()
    expect(teams.launchDerived).toHaveBeenCalledTimes(2)
    expect((await repeated.tick()).failed).toEqual([])
  })
})
