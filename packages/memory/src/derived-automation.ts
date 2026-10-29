import type { DecisionService } from './decisions/service.js'
import type { DerivedPorts } from './team-orchestration.js'
import { MemoryError } from './contracts.js'

export interface DerivedPortsOptions {
  decisions: DecisionService
  ownerId(): string
  automationsEnabled(): boolean
  actionProfile?: DerivedPorts['actionProfile']
  revokeProfiles?: DerivedPorts['revokeProfiles']
}

const DEAD_REQUEST = ['revoked', 'superseded', 'expired']

/**
 * Adapter of the private decision store for derived plans, built only on its public API. Ids, kinds, digests, public summaries and the person's
 * follow-up text cross it; approval codes never do. Intent states are folded into the item states the plan builder understands.
 */
export function createDerivedPorts(o: DerivedPortsOptions): DerivedPorts {
  const store = o.decisions.store
  return {
    async approved(requestId) {
      const request = store.publicRequest(requestId)
      const summaries = new Map(request.items.map(item => [item.ordinal, item.summary]))
      return {
        canonical_digest: request.canonical_digest,
        items: store.getApprovedItems(requestId).map(item => ({ item_id: item.item_id, ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, summary: summaries.get(item.ordinal) ?? '',
          effect_digest: item.effect_digest, state: item.state === 'pending' || item.state === 'prepared' ? 'approved' : item.state })),
        follow_ups: store.getFollowUps(requestId).map(entry => ({ project_id: entry.project_id, ordinal: entry.ordinal, text: entry.text, ref: entry.ref, source: 'channel_reply' as const, expires_at: entry.expires_at })),
      }
    },
    async live(requestId) {
      try {
        const request = store.publicRequest(requestId)
        if (DEAD_REQUEST.includes(request.state) || !(Date.parse(request.expires_at) > store.clock().getTime())) return false
        return await o.decisions.live(requestId)
      } catch { return false }
    },
    async claimFollowUp(requestId, projectId, consumerRef) {
      const outcome = await o.decisions.claimFollowUp(requestId, projectId, consumerRef)
      return outcome.gated ? 'authority_unavailable' : outcome.value
    },
    ...(o.actionProfile ? { actionProfile: o.actionProfile } : {}),
    ...(o.revokeProfiles ? { revokeProfiles: o.revokeProfiles } : {}),
    automationsEnabled: o.automationsEnabled,
    ownerId: o.ownerId,
  }
}

/** What the dispatcher needs of the team orchestration; also what a host hands over so the ports can be attached lazily. */
export interface DerivedTeams {
  attachAutomation(ports: DerivedPorts): void
  launchDerived(input: { project_id: string; delegation_version: number; request_id: string }): Promise<unknown>
  expireDerived(): Promise<{ closed: string[]; failed: string[] }>
  derivedAvailable(): boolean
}

export interface DerivedDispatcherOptions {
  db: { query(sql: string, params?: unknown[]): Promise<Array<Record<string, any>>> }
  teams: Pick<DerivedTeams, 'launchDerived' | 'expireDerived' | 'derivedAvailable'>
  decisions: DecisionService
  /** How far back to look for decision requests that may still carry an unclaimed follow-up. */
  lookbackMs?: number
  /** Failed launch attempts per request before the dispatcher stops offering it in this process. */
  maxAttempts?: number
  now?(): number
}

export interface DerivedTick { expired: { closed: string[]; failed: string[] } | null; launched: string[]; failed: string[]; skipped: 'unavailable' | null }

/**
 * Rides the scheduler clock. It never decides anything: it offers each unclaimed follow-up of an activated project to `launchDerived`, which
 * revalidates the delegation, the channel, the authority and the claim, and it closes plans whose runtime limit elapsed.
 */
export class DerivedDispatcher {
  private readonly attempts = new Map<string, number>()
  constructor(private readonly o: DerivedDispatcherOptions) {}

  async tick(): Promise<DerivedTick> {
    const result: DerivedTick = { expired: await this.o.teams.expireDerived().catch(() => null), launched: [], failed: [], skipped: null }
    if (!this.o.teams.derivedAvailable()) return { ...result, skipped: 'unavailable' }
    const since = new Date((this.o.now?.() ?? Date.now()) - (this.o.lookbackMs ?? 3 * 86_400_000)).toISOString()
    const projects = (await this.o.db.query(`SELECT a.project_id,a.delegation_version,d.document FROM project_automation a
      JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version AND d.revoked_at IS NULL WHERE a.enabled=1 AND a.coordinator_session_id IS NOT NULL`))
      .filter(row => (typeof row.document === 'string' ? JSON.parse(row.document) : row.document)?.channel)
    if (!projects.length) return result
    const requests = (await this.o.db.query('SELECT DISTINCT decision_request_ref AS ref FROM schedule_artifacts WHERE decision_request_ref IS NOT NULL AND created_at>=$1', [since])).map(row => String(row.ref))
    // A plan that was inserted but never launched (a transient failure before its first effect) already holds its follow-up: offer it again until its limit elapses.
    const waiting = (await this.o.db.query("SELECT delegation_project_id AS project_id,delegation_version,decision_request_id AS ref FROM chat_team_plans WHERE delegation_project_id IS NOT NULL AND state='prepared'"))
    for (const plan of waiting) {
      const key = `${plan.project_id}:${plan.ref}`
      if (!projects.some(row => row.project_id === plan.project_id) || (this.attempts.get(key) ?? 0) >= (this.o.maxAttempts ?? 3)) continue
      try {
        await this.o.teams.launchDerived({ project_id: plan.project_id, delegation_version: plan.delegation_version, request_id: plan.ref })
        result.launched.push(key)
      } catch (error) {
        this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1)
        result.failed.push(`${key}:${error instanceof MemoryError ? error.statusCode : 'error'}`)
      }
    }
    for (const ref of requests) {
      let followUps
      try { followUps = this.o.decisions.store.getFollowUps(ref).filter(entry => !entry.consumed) } catch { continue }
      for (const entry of followUps) {
        const project = projects.find(row => row.project_id === entry.project_id)
        const key = `${entry.project_id}:${ref}`
        if (!project || (this.attempts.get(key) ?? 0) >= (this.o.maxAttempts ?? 3)) continue
        try {
          await this.o.teams.launchDerived({ project_id: entry.project_id, delegation_version: project.delegation_version, request_id: ref })
          result.launched.push(key)
        } catch (error) {
          this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1)
          result.failed.push(`${key}:${error instanceof MemoryError ? error.statusCode : 'error'}`)
        }
      }
    }
    return result
  }
}
