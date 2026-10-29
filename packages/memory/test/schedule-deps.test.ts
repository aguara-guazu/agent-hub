import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { scheduleDeps } from '../src/schedule-deps.js'
import { dailyTemplates } from '../src/daily-templates.js'
import { confirmAssignment } from '../src/daily-close.js'
import type { AttentionReaders, CollectDeps, JiraGuard, RunContext, ScheduleAutomation, ScheduleEffects } from '../src/schedule-contract.js'
import type { DailyDeps } from '../src/daily-types.js'

let dir: string, db: MemoryDatabase, memory: MemoryStore, operations: MemoryOperations
const NOW = '2026-10-28T17:30:30.000Z'
const empty = async () => []
const jira: JiraGuard = { ownerAccountId: async () => 'acc-owner', assigneeOf: async () => ({ account_id: 'acc-owner', verified: true }) }
const effectsWith = (attention: ScheduleEffects['attention']): ScheduleEffects => ({ attention, jira }) as ScheduleEffects
const own: AttentionReaders = { uncertain_deliveries: empty, overdue_close: empty }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-deps-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  memory = new MemoryStore(db, dir)
  operations = new MemoryOperations(memory, new MemoryAI(async () => defaultAI, new Vault(dir)))
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

const template = (id: string) => dailyTemplates.find(entry => entry.id === id)!
const collect = async (id: string, automation: ScheduleAutomation) => {
  const deps = { store: memory, now: () => new Date(NOW), statusProjects: async () => [] as string[], ...scheduleDeps(own, operations.projectAutomation, automation) } as CollectDeps
  const pkg = await template(id).collect({ scheduled_for: NOW, covered_since: null, trigger: 'clock', deferred_until: null, extend_from: null, run_id: 'run-1' } as unknown as RunContext, deps)
  return pkg.sections.find(section => section.id === (id === 'daily_brief' ? 'brief' : 'close'))!.data as { gaps: string[] }
}

it('con los lectores de cada dueño cableados, el brief solo declara lo que ninguna área lee todavía y el cierre no declara huecos', async () => {
  const automation: ScheduleAutomation = { enabled: () => true, effects: effectsWith({ pending_responses: empty, carryover_items: empty }) }
  expect((await collect('daily_brief', automation)).gaps.sort()).toEqual(['incidentes del supervisor', 'menciones de Slack'])
  expect((await collect('daily_close', automation)).gaps).toEqual([])
})

it('los efectos que el core inyecta después de construir el servicio se leen en la siguiente ejecución', async () => {
  const automation: ScheduleAutomation = { enabled: () => true }
  const before = (await collect('daily_close', automation)).gaps
  expect(before).toEqual(expect.arrayContaining(['identidad de Jira del dueño']))
  automation.effects = effectsWith({ pending_responses: empty, carryover_items: empty })
  expect((await collect('daily_close', automation)).gaps).toEqual([])
  expect(scheduleDeps(own, operations.projectAutomation, automation).jira).toBe(jira)
})

it('un lector que lanza deja su hueco declarado y no interrumpe la ejecución', async () => {
  const boom = async () => { throw new Error('lectura fallida') }
  const automation: ScheduleAutomation = { enabled: () => true, effects: effectsWith({ pending_responses: boom, carryover_items: boom }) }
  expect((await collect('daily_brief', automation)).gaps).toEqual(expect.arrayContaining(['pedidos sin responder', 'pendientes arrastrados']))
})

it('liveness_incidents no entra a las dependencias mientras no exista el supervisor', () => {
  const automation: ScheduleAutomation = { enabled: () => true, effects: effectsWith({ pending_responses: empty, carryover_items: empty }) }
  expect(Object.keys(scheduleDeps(own, operations.projectAutomation, automation).attention!).sort())
    .toEqual(['activated_projects', 'carryover_items', 'overdue_close', 'pending_responses', 'push_candidates', 'uncertain_deliveries'])
})

it('una asignación verificada que no es del dueño, o que no tiene asignado, no se propone; sin verificar se propone sin garantía', async () => {
  const seen: Record<string, { account_id: string | null; verified: boolean }> = {
    'APP-1': { account_id: 'acc-owner', verified: true }, 'APP-2': { account_id: 'acc-other', verified: true }, 'APP-3': { account_id: null, verified: true }, 'APP-4': { account_id: null, verified: false },
  }
  const deps = { jira: { ownerAccountId: async () => 'acc-owner', assigneeOf: async (key: string) => seen[key]! } } as unknown as DailyDeps
  expect([...(await confirmAssignment(deps, 'acc-owner', Object.keys(seen))).entries()]).toEqual([['APP-1', 'verified'], ['APP-4', 'unverified']])
  expect([...(await confirmAssignment({} as DailyDeps, 'acc-owner', ['APP-1'])).entries()]).toEqual([['APP-1', 'unverified']])
})
