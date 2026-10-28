import { createHash } from 'node:crypto'
import { sessionStatus, type LocalChat } from './local-chat.js'
import { defaultWatchdogConfig, evaluateWatchdog, POLICY_VERSION, type WatchdogSnapshot } from './local-watchdog-policy.js'

const BATCH_SIZE = 100
const SCAN_INTERVAL_MS = 30_000
const HISTORY_LIMIT = 1000
const milliseconds = (value: unknown): number | null => typeof value === 'string' ? Date.parse(value) : null

/** Central, inference-free observer. There is deliberately no action executor in this version. */
export class LocalWatchdog {
  private timer?: ReturnType<typeof setInterval>
  private running: Promise<void> | undefined
  private stopped = false
  constructor(private readonly chat: LocalChat, private readonly enabled: (agentId: string) => boolean = () => true,
    private readonly clock: () => number = Date.now, private readonly onError: (error: unknown) => void = () => {},
    private readonly collaborationEnabled: () => boolean = () => true) {}

  start() {
    if (this.timer || this.stopped) return
    this.chat.events.on('change', this.kick)
    this.timer = setInterval(this.kick, 5000)
    this.timer.unref()
    this.kick()
  }
  private kick = () => { void this.tick().catch(this.onError) }
  /** Coalesces simultaneous lifecycle events/timer calls; each turn scans at most 100 due tasks. */
  tick(): Promise<void> {
    if (this.stopped || !this.collaborationEnabled()) return Promise.resolve()
    if (!this.running) this.running = this.observe().finally(() => { this.running = undefined })
    return this.running
  }
  async close() {
    this.stopped = true
    clearInterval(this.timer)
    this.chat.events.off('change', this.kick)
    await this.running
  }
  private async observe() {
    const now = this.clock(), observedAt = new Date(now).toISOString()
    await this.chat.db.transaction(async sql => {
      // The thread's channel owns coordination; a child channel's leader is not its master.
      // Keep unavailable sessions observable, but never resurrect revoked/closed scopes.
      const rows = await sql.query(`SELECT w.*,s.agent_id,s.state AS session_state,s.closed_at AS session_closed_at,
        s.last_seen_at,s.event_at,s.lease_until,c.leader_id AS recipient_id,
        recipient.closed_at AS recipient_closed_at,recipient.removed_at AS recipient_removed_at,recipient.lease_until AS recipient_lease_until,
        d.notified_at,d.read_at,d.handled_at,d.cancelled_at,d.attempts,d.next_attempt_at,d.error AS delivery_error,
        d.message_id AS delivery_message_id,o.fingerprint AS previous_fingerprint
        FROM chat_work_state w JOIN chat_sessions s ON s.id=w.session_id
        JOIN chat_threads t ON t.id=w.thread_id JOIN chat_channels c ON c.id=t.channel_id
        JOIN chat_channels own ON own.id=s.channel_id
        LEFT JOIN chat_team_plans p ON p.root_thread_id=COALESCE(t.team_root_thread_id,t.id)
        LEFT JOIN chat_sessions recipient ON recipient.id=c.leader_id
        LEFT JOIN chat_deliveries d ON d.message_id=w.report_message_id AND d.recipient_id=c.leader_id
        LEFT JOIN chat_watchdog_observations o ON o.session_id=w.session_id AND o.work_id=w.work_id
        WHERE s.removed_at IS NULL AND c.closed_at IS NULL AND own.closed_at IS NULL AND t.state='open'
        AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND (own.kind<>'virtual' OR own.activated_at IS NOT NULL)
        -- A thread linked to a team never falls back to the local case: without a live plan it stays unobserved.
        AND ((p.id IS NULL AND t.team_root_thread_id IS NULL AND s.channel_id=t.channel_id) OR (p.state IN ('launching','launched','partial','uncertain','active')
          AND p.master_channel_id=t.channel_id
          AND p.created_by=c.leader_id AND EXISTS(SELECT 1 FROM chat_sessions leader WHERE leader.id=p.created_by AND leader.removed_at IS NULL AND leader.closed_at IS NULL)
          AND ((s.id=p.created_by AND s.channel_id=p.master_channel_id) OR EXISTS(SELECT 1 FROM chat_team_members member
            WHERE member.team_id=p.id AND member.session_id=s.id AND member.channel_id=s.channel_id AND member.state='joined'))))
        AND (o.session_id IS NULL OR o.work_version<>w.version OR o.next_scan_at<=$1)
        ORDER BY COALESCE(o.next_scan_at,'1970-01-01T00:00:00.000Z'),w.session_id,w.work_id LIMIT $2`, [observedAt,BATCH_SIZE])
      for (const row of rows) {
        if (this.stopped) break
        const snapshot: WatchdogSnapshot = {
          now, work: {status:row.status,updatedAt:milliseconds(row.updated_at) ?? NaN,
            lastProgressAt:milliseconds(row.last_progress_at),waitingFor:row.waiting_for,reportMessageId:row.report_message_id},
          session: {state:sessionStatus({state:row.session_state,event_at:row.event_at,closed_at:row.session_closed_at,lease_until:row.lease_until},now).state,
            observedAt:milliseconds(row.last_seen_at),stateSince:milliseconds(row.event_at),leaseUntil:milliseconds(row.lease_until)},
          // Observing a hypothetical wake is not an attempt. Never escalate based on a wake we did not send.
          recovery: {statusAttempts:0,lastStatusAttemptAt:null,alertedAt:null},
          delivery: row.delivery_message_id ? {notifiedAt:milliseconds(row.notified_at),readAt:milliseconds(row.read_at),
            handledAt:milliseconds(row.handled_at),cancelledAt:milliseconds(row.cancelled_at),attempts:row.attempts,
            nextAttemptAt:milliseconds(row.next_attempt_at),error:row.delivery_error} : null,
        }
        let decision = this.enabled(row.agent_id) ? evaluateWatchdog(snapshot)
          : {action:'WAIT',reason:'client_disabled',evidence:[],nextEvaluationAt:null}
        if (row.session_id===row.recipient_id && row.report_message_id && this.enabled(row.agent_id)) {
          decision={action:'WAIT',reason:'coordinator_report_persisted',evidence:['report_persisted','worker_is_coordinator'],nextEvaluationAt:null}
        }
        const recipientAvailable=Boolean(row.recipient_id && !row.recipient_closed_at && !row.recipient_removed_at &&
          (milliseconds(row.recipient_lease_until) ?? 0)>now)
        if (decision.action==='RETRY_DELIVERY' && !recipientAvailable) {
          decision={action:'UNKNOWN',reason:'report_recipient_unavailable',evidence:['report_persisted'],nextEvaluationAt:null}
        }
        // Exclude moving clocks/leases from deduplication. Retain the full structured snapshot only on a transition.
        const fingerprint = createHash('sha256').update(JSON.stringify({policy:POLICY_VERSION,config:defaultWatchdogConfig,
          version:row.version,action:decision.action,reason:decision.reason,evidence:decision.evidence,
          recipient:row.recipient_id,delivery:snapshot.delivery})).digest('hex')
        const recordedSnapshot=JSON.stringify({...snapshot,recipientId:row.recipient_id,recipientAvailable})
        const nextScan = new Date(Math.max(now+1,Math.min(now+SCAN_INTERVAL_MS,decision.nextEvaluationAt ?? Infinity))).toISOString()
        await sql.query(`INSERT INTO chat_watchdog_observations(session_id,work_id,work_version,policy_version,policy_config,decision,snapshot,
          fingerprint,first_observed_at,last_observed_at,next_scan_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
          ON CONFLICT(session_id,work_id) DO UPDATE SET work_version=excluded.work_version,policy_version=excluded.policy_version,
          policy_config=excluded.policy_config,decision=excluded.decision,snapshot=excluded.snapshot,fingerprint=excluded.fingerprint,
          last_observed_at=excluded.last_observed_at,next_scan_at=excluded.next_scan_at`,
        [row.session_id,row.work_id,row.version,POLICY_VERSION,JSON.stringify(defaultWatchdogConfig),JSON.stringify(decision),
          recordedSnapshot,fingerprint,observedAt,nextScan])
        if (fingerprint !== row.previous_fingerprint) await sql.query(`INSERT INTO chat_watchdog_events
          (session_id,work_id,work_version,policy_version,policy_config,decision,snapshot,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.session_id,row.work_id,row.version,POLICY_VERSION,JSON.stringify(defaultWatchdogConfig),JSON.stringify(decision),recordedSnapshot,observedAt])
      }
      await sql.query('DELETE FROM chat_watchdog_events WHERE seq <= (SELECT max(seq)-$1 FROM chat_watchdog_events)',[HISTORY_LIMIT])
    })
  }
}
