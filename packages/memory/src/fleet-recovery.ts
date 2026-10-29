import type { UsageQuotaTransition } from '@agenthub/shared'
import type { MemoryDatabase } from './database.js'
import type { HubResumeRequest, HubTeamStatus } from './team-hub.js'
import { isRestored, type UsageQuotas } from './usage-quotas.js'

/** Fixed instruction of a resumed member; it carries no task text so the conversation itself stays the source of truth. */
export const QUOTA_RESUME_PROMPT = 'La cuota se restableció; continúa exactamente la tarea en curso; revisa tu inbox y tu último work_update.'
/** Observed exhaustion is accepted this long after the failure, because adapters can report a limit after the CLI stopped. */
export const QUOTA_EVIDENCE_WINDOW_MS = 120_000

export type QuotaEvidence = 'protocol' | 'protocol+quota_observation'
export interface QuotaFailure { evidence: QuotaEvidence; pool_key: string | null }
export type ResumeAction = 'resumed' | 'resume_unsupported' | 'resume_failed'
export interface RecoveryOutcome {
  member_id: string
  team_id: string
  result: 'resumed' | 'unsupported' | 'failed' | 'skipped'
  reason: string
  evidence?: QuotaEvidence
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
    private readonly runtime: { resumeMember(handle: string, request: HubResumeRequest): Promise<unknown> },
    private readonly log: RecoveryIncidentLog,
  ) {}

  /** Entry point for the quota recovery event: only a pool leaving exhaustion or cooldown triggers a sweep. */
  async onTransitions(transitions: UsageQuotaTransition[]): Promise<RecoveryOutcome[]> {
    const clis = new Set(transitions.flatMap(item => isRestored(item).clis))
    return clis.size ? this.recover([...clis]) : []
  }

  /** Also used after a Hub restart, when the recovery may have happened while nobody was listening. */
  async recover(clis?: string[]): Promise<RecoveryOutcome[]> {
    const rows = await this.db.query<{ id: string; team_id: string; session_id: string | null; runtime: unknown }>(`SELECT m.id,m.team_id,m.session_id,m.runtime
      FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id
      WHERE m.state='joined' AND m.runtime IS NOT NULL AND t.state NOT IN ('paused','cancelled','completed','prepared') ORDER BY m.team_id,m.ordinal`)
    const outcomes: RecoveryOutcome[] = []
    for (const row of rows) {
      const runtime = parseRuntime(row.runtime)
      if (!runtime || runtime.state !== 'failed' || (clis && !clis.includes(runtime.cli))) continue
      outcomes.push(await this.attempt(String(row.id), String(row.team_id), row.session_id ? String(row.session_id) : null, runtime))
    }
    return outcomes
  }

  private async attempt(memberId: string, teamId: string, sessionId: string | null, runtime: HubTeamStatus): Promise<RecoveryOutcome> {
    const skip = (reason: string, evidence?: QuotaEvidence): RecoveryOutcome => ({ member_id: memberId, team_id: teamId, result: 'skipped', reason, ...(evidence ? { evidence } : {}) })
    const failure = await classifyQuotaFailure(runtime, this.usage)
    if (!failure) return skip('generic_failure')
    if (!failure.pool_key) return skip('pool_not_identified', failure.evidence)
    const base = { member_id: memberId, team_id: teamId, session_id: sessionId, generation: runtime.generation }
    const detail = { evidence: failure.evidence, pool_key: failure.pool_key, cli: runtime.cli, model: runtime.model }
    await this.log.claim({ ...base, cause: 'quota_exhausted', detail })
    const current = await this.usage.forCli(runtime.cli, runtime.model)
    if (!['available', 'low'].includes(current.status) || !current.pools.some(pool => pool.id === failure.pool_key && ['available', 'low'].includes(pool.status))) return skip('quota_not_recovered', failure.evidence)
    if (!await this.log.claim({ ...base, cause: 'quota_resume', detail })) return skip('already_attempted', failure.evidence)
    try {
      await this.runtime.resumeMember(memberId, { prompt: QUOTA_RESUME_PROMPT, pool_key: failure.pool_key })
      await this.log.settle({ member_id: memberId, generation: runtime.generation, action: 'resumed', detail })
      return { member_id: memberId, team_id: teamId, result: 'resumed', reason: 'exclusive_resume', evidence: failure.evidence }
    } catch (error) {
      const plan = (error as { continuity?: { rung?: string; reason?: string } }).continuity
      const unsupported = plan !== undefined && plan.rung !== 'exclusive_resume'
      await this.log.settle({ member_id: memberId, generation: runtime.generation, action: unsupported ? 'resume_unsupported' : 'resume_failed', detail: { ...detail, ...(plan?.reason ? { reason: plan.reason } : {}) } })
      return { member_id: memberId, team_id: teamId, result: unsupported ? 'unsupported' : 'failed', reason: plan?.reason ?? 'resume_failed', evidence: failure.evidence }
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
