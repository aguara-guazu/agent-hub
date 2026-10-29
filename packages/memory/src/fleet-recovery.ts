import { createHash, randomUUID } from 'node:crypto'
import type { UsageQuotaTransition } from '@agenthub/shared'
import type { MemoryDatabase } from './database.js'
import type { HubResumeRequest, HubTeamStatus } from './team-hub.js'
import type { LeaderClosedEvent, ResumptionEvent } from './usage-notices.js'
import { isRestored, type UsageQuotas } from './usage-quotas.js'

/** Fixed instruction of a resumed member; it carries no task text so the conversation itself stays the source of truth. */
export const QUOTA_RESUME_PROMPT = 'Quota restored: resume exactly your current task; check inbox and last work_update.'
/** Observed exhaustion is accepted this long after the failure, because adapters can report a limit after the CLI stopped. */
export const QUOTA_EVIDENCE_WINDOW_MS = 120_000

export type QuotaEvidence = 'protocol' | 'protocol+quota_observation'
export interface QuotaFailure { evidence: QuotaEvidence; pool_key: string | null }
export type ResumeAction = 'resumed' | 'resume_unsupported' | 'resume_failed'
export interface RecoveryOutcome {
  member_id: string
  team_id: string
  worktree_name: string
  cli: string
  model: string
  /** Generation of the failed process this outcome is about; with the member it identifies an episode. */
  generation: string
  /** `restarted`: the CLI cannot resume, so the approved member was started again in a new conversation over the same worktree. */
  result: 'resumed' | 'restarted' | 'unsupported' | 'failed' | 'skipped'
  reason: string
  evidence?: QuotaEvidence
}
export interface RecoveryNotices {
  publishResumption(event: ResumptionEvent): Promise<boolean>
  publishLeaderClosed(event: LeaderClosedEvent): Promise<boolean>
}
export interface ResumeRuntime {
  resumeMember(handle: string, request: HubResumeRequest): Promise<unknown>
  checkResume(handle: string, request: HubResumeRequest): Promise<{ ready: boolean; kind: string; plan?: { rung?: string; reason?: string } }>
}
/**
 * Last resort for a CLI that cannot resume: restart the member in a new conversation over its own worktree, as `team_control` edit + clear would.
 * It runs at most once per member and generation, because it sits behind the same claim as the resume attempt.
 */
export interface RecoveryFallback {
  restart(member: { member_id: string; team_id: string; generation: string }): Promise<'restarted' | 'refused' | 'failed'>
}
/** One attempt per member, generation and cause: claim() is the atomic gate and reports whether this call won it. */
export interface RecoveryIncidentLog {
  claim(input: { member_id: string; team_id: string; session_id: string | null; generation: string; cause: 'quota_exhausted' | 'quota_resume'; detail: Record<string, unknown> }): Promise<boolean>
  settle(input: { member_id: string; generation: string; action: ResumeAction; detail?: Record<string, unknown> }): Promise<void>
}

/**
 * Codex states the cause in its protocol (error_cause). Claude does not document one, so a failed turn only counts when the
 * Hub's own quota observations had the pool exhausted around the failure. Kiro and any other failure stay generic.
 */
export async function classifyQuotaFailure(runtime: HubTeamStatus, usage: Pick<UsageQuotas, 'exhaustedAt'>): Promise<QuotaFailure | undefined> {
  if (runtime.state !== 'failed') return undefined
  const pool = () => usage.exhaustedAt(runtime.cli, runtime.model, runtime.updated_at, QUOTA_EVIDENCE_WINDOW_MS)
  if (runtime.cli === 'codex_cli' && runtime.error_cause === 'quota_exhausted') return { evidence: 'protocol', pool_key: (await pool())?.pool_key ?? null }
  if (runtime.cli === 'claude_code' && runtime.error_code === 'fleet_turn_failed') {
    const exhausted = await pool()
    return exhausted ? { evidence: 'protocol+quota_observation', pool_key: exhausted.pool_key } : undefined
  }
  return undefined
}

/**
 * Restarts members that stopped because their quota ran out, once that same pool recovers. Never switches account or model,
 * makes at most one attempt per member and generation, and leaves anything unverifiable to the manual path.
 */
export class FleetQuotaRecovery {
  constructor(
    private readonly db: Pick<MemoryDatabase, 'query'>,
    private readonly usage: Pick<UsageQuotas, 'exhaustedAt' | 'forCli'>,
    private readonly runtime: ResumeRuntime,
    private readonly log: RecoveryIncidentLog,
    private readonly notices?: RecoveryNotices,
    private readonly fallback?: RecoveryFallback,
  ) {}

  /** Entry point for the quota recovery event: only a pool leaving exhaustion or cooldown triggers a sweep. */
  async onTransitions(transitions: UsageQuotaTransition[]): Promise<RecoveryOutcome[]> {
    const clis = new Set(transitions.flatMap(item => isRestored(item).clis))
    if (!clis.size) return []
    const trigger = transitions.filter(item => isRestored(item).restored).map(item => item.id).sort().join(',')
    return this.recover([...clis], trigger)
  }

  /** Also used after a Hub restart, when the recovery may have happened while nobody was listening. */
  async recover(clis?: string[], trigger = 'sweep'): Promise<RecoveryOutcome[]> {
    const rows = await this.db.query<{ id: string; team_id: string; worktree_name: string; session_id: string | null; runtime: unknown }>(`SELECT m.id,m.team_id,m.worktree_name,m.session_id,m.runtime
      FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id
      WHERE m.state='joined' AND m.runtime IS NOT NULL AND t.state NOT IN ('paused','cancelled','completed','prepared') ORDER BY m.team_id,m.ordinal`)
    const outcomes: RecoveryOutcome[] = []
    for (const row of rows) {
      const runtime = parseRuntime(row.runtime)
      if (!runtime || runtime.state !== 'failed' || (clis && !clis.includes(runtime.cli))) continue
      outcomes.push(await this.attempt(String(row.id), String(row.team_id), String(row.worktree_name), row.session_id ? String(row.session_id) : null, runtime))
    }
    await this.notifyLeaders(outcomes, trigger)
    return outcomes
  }

  /** One short notice per team, only about what the Hub actually tried; skipped members produce none. */
  private async notifyLeaders(outcomes: RecoveryOutcome[], trigger: string) {
    if (!this.notices) return
    const teams = new Map<string, ResumptionEvent['members']>()
    for (const outcome of outcomes) {
      if (outcome.result === 'skipped') continue
      const list = teams.get(outcome.team_id) ?? []
      list.push({ member_id: outcome.member_id, worktree_name: outcome.worktree_name, cli: outcome.cli, model: outcome.model, result: outcome.result, reason: outcome.reason })
      teams.set(outcome.team_id, list)
    }
    const closed = new Map<string, RecoveryOutcome[]>()
    for (const outcome of outcomes) if (outcome.result === 'skipped' && outcome.reason === 'leader_closed') closed.set(outcome.team_id, [...(closed.get(outcome.team_id) ?? []), outcome])
    for (const [teamId, waiting] of closed) {
      const episode = createHash('sha256').update(JSON.stringify(waiting.map(item => [item.member_id, item.generation]).sort())).digest('hex').slice(0, 16)
      await this.notices.publishLeaderClosed({ key: `leader_closed:${teamId}:${episode}`, team_id: teamId, observed_at: new Date().toISOString(), members: waiting.map(item => item.worktree_name) }).catch(() => false)
    }
    for (const [teamId, members] of teams) {
      const generation = createHash('sha256').update(JSON.stringify(members.map(item => [item.member_id, item.result]).sort())).digest('hex').slice(0, 16)
      await this.notices.publishResumption({ key: `fleet_resumption:${teamId}:${trigger}:${generation}`, team_id: teamId, observed_at: new Date().toISOString(), members }).catch(() => false)
    }
  }

  /** The CLI cannot continue the conversation: leave the incident and, when a fallback is configured, start the member again in a new conversation. */
  private async unsupported(named: Pick<RecoveryOutcome, 'member_id' | 'team_id' | 'worktree_name' | 'cli' | 'model' | 'generation'>, detail: Record<string, unknown>, planReason: string | undefined, evidence: QuotaEvidence): Promise<RecoveryOutcome> {
    const fallback = this.fallback ? await this.fallback.restart({ member_id: named.member_id, team_id: named.team_id, generation: named.generation }).catch(() => 'failed' as const) : undefined
    await this.log.settle({ member_id: named.member_id, generation: named.generation, action: 'resume_unsupported',
      detail: { ...detail, ...(planReason ? { reason: planReason } : {}), ...(fallback ? { fallback } : {}) } })
    if (fallback === 'restarted') return { ...named, result: 'restarted', reason: 'new_conversation', evidence }
    return { ...named, result: 'unsupported', reason: fallback ? `fallback_${fallback}` : planReason ?? 'resume_unsupported', evidence }
  }

  private async attempt(memberId: string, teamId: string, worktreeName: string, sessionId: string | null, runtime: HubTeamStatus): Promise<RecoveryOutcome> {
    const named = { member_id: memberId, team_id: teamId, worktree_name: worktreeName, cli: runtime.cli, model: runtime.model, generation: runtime.generation }
    const skip = (reason: string, evidence?: QuotaEvidence): RecoveryOutcome => ({ ...named, result: 'skipped', reason, ...(evidence ? { evidence } : {}) })
    const failure = await classifyQuotaFailure(runtime, this.usage)
    if (!failure) return skip('generic_failure')
    if (!failure.pool_key) return skip('pool_not_identified', failure.evidence)
    const base = { member_id: memberId, team_id: teamId, session_id: sessionId, generation: runtime.generation }
    const detail = { evidence: failure.evidence, pool_key: failure.pool_key, cli: runtime.cli, model: runtime.model }
    await this.log.claim({ ...base, cause: 'quota_exhausted', detail })
    const current = await this.usage.forCli(runtime.cli, runtime.model)
    if (!['available', 'low'].includes(current.status) || !current.pools.some(pool => pool.id === failure.pool_key && ['available', 'low'].includes(pool.status))) return skip('quota_not_recovered', failure.evidence)
    const request: HubResumeRequest = { prompt: QUOTA_RESUME_PROMPT, pool_key: failure.pool_key }
    // The single attempt is spent only when the outcome is final: a missing authority or exit proof can change in a minute.
    const verdict = await this.runtime.checkResume(memberId, request)
    if (!verdict.ready && verdict.kind !== 'unsupported') return skip(verdict.kind, failure.evidence)
    if (!await this.log.claim({ ...base, cause: 'quota_resume', detail })) return skip('already_attempted', failure.evidence)
    if (!verdict.ready) return this.unsupported(named, detail, verdict.plan?.reason, failure.evidence)
    try {
      await this.runtime.resumeMember(memberId, request)
      await this.log.settle({ member_id: memberId, generation: runtime.generation, action: 'resumed', detail })
      return { ...named, result: 'resumed', reason: 'exclusive_resume', evidence: failure.evidence }
    } catch (error) {
      const plan = (error as { continuity?: { rung?: string; reason?: string } }).continuity
      if (plan !== undefined && plan.rung !== 'exclusive_resume') return this.unsupported(named, detail, plan.reason, failure.evidence)
      await this.log.settle({ member_id: memberId, generation: runtime.generation, action: 'resume_failed', detail: { ...detail, ...(plan?.reason ? { reason: plan.reason } : {}) } })
      return { ...named, result: 'failed', reason: plan?.reason ?? 'resume_failed', evidence: failure.evidence }
    }
  }
}

function parseRuntime(raw: unknown): HubTeamStatus | undefined {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (value && typeof value === 'object' && (value as { provider?: unknown }).provider === 'hub' && typeof (value as { generation?: unknown }).generation === 'string') return value as HubTeamStatus
  } catch { /* A runtime that cannot be read establishes nothing. */ }
  return undefined
}

/** Durable attempt log over process_incidents: the unique (subject, generation, cause) index is what bounds the attempts. */
export class SqlRecoveryIncidentLog implements RecoveryIncidentLog {
  constructor(private readonly db: Pick<MemoryDatabase, 'query'>) {}
  async claim(input: Parameters<RecoveryIncidentLog['claim']>[0]): Promise<boolean> {
    const rows = await this.db.query(`INSERT INTO process_incidents(id,subject_kind,subject_id,generation,team_id,member_id,session_id,cause,action,observed_at,detail)
      VALUES($1,'fleet_member',$2,$3,$4,$2,$5,$6,'none',$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
    [randomUUID(), input.member_id, input.generation, input.team_id, input.session_id, input.cause, new Date().toISOString(), JSON.stringify(input.detail)])
    return rows.length > 0
  }
  async settle(input: Parameters<RecoveryIncidentLog['settle']>[0]): Promise<void> {
    await this.db.query(`UPDATE process_incidents SET action=$3,detail=json_patch(detail,$4)
      WHERE subject_kind='fleet_member' AND subject_id=$1 AND generation=$2 AND cause='quota_resume'`,
    [input.member_id, input.generation, input.action, JSON.stringify(input.detail ?? {})])
  }
}

/** Builds the recovery over the Hub's own fleet runtime; absent when the runtime cannot resume members (another backend or no fleet). */
export function createFleetRecovery(db: Pick<MemoryDatabase, 'query'>, usage: Pick<UsageQuotas, 'exhaustedAt' | 'forCli'>,
  fleet: unknown, notices?: RecoveryNotices, fallback?: RecoveryFallback): FleetQuotaRecovery | undefined {
  const runtime = fleet as Partial<ResumeRuntime> | undefined
  if (!runtime || typeof runtime.resumeMember !== 'function' || typeof runtime.checkResume !== 'function') return undefined
  return new FleetQuotaRecovery(db, usage, runtime as ResumeRuntime, new SqlRecoveryIncidentLog(db), notices, fallback)
}
