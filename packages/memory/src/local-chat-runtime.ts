import { AsyncLocalStorage } from "node:async_hooks"
import { UsageNotices, usageWakeText } from './usage-notices.js'
import { inspectNativeProcess, isStableProcessStart } from '@agenthub/gateway'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findExtractionCli } from './cli-extraction.js'
import { LocalChat } from './local-chat.js'
import { teamBootstrap } from './local-chat-team.js'
import { markSessionActivity } from './chat-wrap-up.js'

const exec = promisify(execFile)
/** Delivery state of a Hub-owned process as seen by its manager: only 'idle' and 'mid_turn' accept input without error. */
export type FleetReadiness = 'idle' | 'mid_turn' | 'busy' | 'unowned'
export const chatWakeText = (ids: string[]) => `Agent Hub: pending mentions/private notices (${ids.join(', ')}). Before continuing, read memory_chat_inbox (your session_key) and verify team.leader_id. Requests: reply in-thread via reply_to. response_due: check your pending request in work_thread_id. Other status notices: request any missing report in the existing thread. Never read another agent's terminal, output, logs or transcript. memory_chat_ack the id only once handled. No polling or empty auto-replies.`

/** A probe of a process or peer the tick does not own; past this the session is skipped until the next tick. */
export const TICK_PROBE_TIMEOUT_MS = 5_000
/** A tick still running after this no longer holds back the next one; the step it was in is reported. */
export const TICK_STUCK_MS = 60_000
const TICK_SLOW_MS = 10_000
const TIMED_OUT = Symbol("timed_out")
const FAILED = Symbol("failed")
export type TickEvent = { event: "probe_timeout" | "probe_failed" | "tick_slow" | "tick_stuck" | "tick_failed" | "dispatch_in_flight" | "delivery_failed" | "delivery_notified" | "delivery_retry_later" | "bootstrap_failed" | "notice" | "process_incident"; step: string; duration_ms: number
  session_id?: string; recipient_id?: string; notice_id?: string; cause?: string; count?: number; uncertain?: boolean; action?: string; member_id?: string; generation?: string }
/** Diagnostic state of one tick; overlapping ticks never share it. */
type TickRun = { started: number; step: string; phaseStarted: number; slowest: { step: string; ms: number } }
const newRun = (): TickRun => ({ started: Date.now(), step: "read_access", phaseStarted: Date.now(), slowest: { step: "idle", ms: 0 } })

/** Only the local Hub owns the dispatcher. No inference process is created to listen. */
export class LocalChatRuntime {
  /** Diagnostics only: ids, steps and durations, never message content. Replaced by the Hub's history log when wired. */
  observer: (event: TickEvent) => void = event => { process.stderr.write(`[chat-runtime] ${JSON.stringify(event)}\n`) }
  private readonly runContext = new AsyncLocalStorage<TickRun>()
  private current: { run: TickRun; done: Promise<void> } | undefined
  private readonly runs = new Set<Promise<void>>()
  /** Sessions with a claim or wake in progress, possibly from a detached tick: no other tick claims or wakes them meanwhile. */
  private readonly inFlight = new Map<string, { since: number; reported: boolean }>()
  /** A probe still pending is reused by later ticks instead of stacking a new call on the same process or peer. */
  private readonly probes = new Map<string, Promise<unknown>>()
  private timer?: ReturnType<typeof setInterval>
  private running: Promise<void> | undefined
  private stopped = false
  private watchers = new Map<string,{ started:string; controller:AbortController }>()
  private controllers = new Set<AbortController>()
  private activityWritten = new Map<string,{at:string;written:number}>()
  constructor(readonly chat: LocalChat, private queue = async (nativeId: string, text: string) => {
    const binary = findExtractionCli('codex_cli')
    if (!binary) throw new Error('Codex CLI no está instalado')
    // No shell and no incoming message body in the command. Keep the existing CLI's approvals intact.
    const js = binary.endsWith('.js')
    try {
      await exec(js ? process.execPath : binary, [...(js ? [binary] : []),'queue','--thread',nativeId,'--message',text],
        { timeout: 15000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, ...(js ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } })
    } catch {
      // Without a native rejection receipt, even a timeout may follow acceptance. Never replay it blindly.
      throw Object.assign(new Error('Entrega de codex queue sin confirmar'),{retryable:false})
    }
  }, private enabled: (agentId:string) => boolean = () => true,
  private inspectProcess:typeof inspectNativeProcess = inspectNativeProcess,
  private collaborationEnabled: () => boolean = () => true,
  private fleet?: {wake(sessionId:string,text:string):Promise<boolean>;connected(sessionId:string):Promise<boolean>;readiness?(sessionId:string):Promise<FleetReadiness>;activityAt?(sessionId:string):Promise<{at:string;turn_id:string}|undefined>}) {}
  start() {
    if (this.timer) return
    this.chat.events.on('change',this.kick)
    this.timer = setInterval(this.kick,5000); this.timer.unref(); this.kick()
  }
  private kick = () => {
    if (this.stopped) return
    if (this.current) {
      const elapsed = Date.now() - this.current.run.started
      if (elapsed < TICK_STUCK_MS) return
      // A hung await must not stop deliveries, leases and notices for every session; inFlight keeps the hung sessions out of the next tick.
      this.report({ event: "tick_stuck", step: this.current.run.step, duration_ms: elapsed })
    }
    const run = newRun()
    const done: Promise<void> = this.runContext.run(run, () => this.tick()).catch(() => {
      this.report({ event: "tick_failed", step: run.step, duration_ms: Date.now() - run.started })
    }).finally(() => {
      this.runs.delete(done)
      const elapsed = Date.now() - run.started
      if (elapsed >= TICK_SLOW_MS) this.report({ event: "tick_slow", step: run.slowest.step, duration_ms: elapsed })
      if (this.current?.done === done) this.current = undefined
    })
    this.runs.add(done)
    this.current = { run, done }
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.chat.events.off('change',this.kick)
    for (const c of this.controllers) c.abort()
    // Shutdown has a few seconds before the supervisor kills the core; detached or hung ticks must not consume them.
    await Promise.race([Promise.allSettled([...this.runs]), new Promise(resolve => setTimeout(resolve, 2_000).unref())])
  }
  private historyNotices = { at: new Date().toISOString(), id: "" }
  private historyIncidents = { at: new Date().toISOString(), id: "" }
  /** Notices and process incidents written since the last pass, advancing each cursor only through rows actually observed. */
  private async recordHistory() {
    const notices = await this.chat.db.query("SELECT id,cause,session_id,recipient_id,created_at FROM chat_status_notices WHERE (created_at>$1 OR (created_at=$1 AND id>$2)) ORDER BY created_at,id LIMIT 200", [this.historyNotices.at, this.historyNotices.id])
    for (const row of notices) {
      this.report({ event: "notice", step: "history", duration_ms: 0, notice_id: String(row.id), cause: String(row.cause), session_id: String(row.session_id), recipient_id: String(row.recipient_id) })
      this.historyNotices = { at: String(row.created_at), id: String(row.id) }
    }
    const incidents = await this.chat.db.query("SELECT id,cause,action,member_id,session_id,generation,observed_at FROM process_incidents WHERE (observed_at>$1 OR (observed_at=$1 AND id>$2)) ORDER BY observed_at,id LIMIT 200", [this.historyIncidents.at, this.historyIncidents.id])
    for (const row of incidents) {
      this.report({ event: "process_incident", step: "history", duration_ms: 0, cause: String(row.cause), action: String(row.action),
        ...(row.member_id ? { member_id: String(row.member_id) } : {}), ...(row.session_id ? { session_id: String(row.session_id) } : {}), ...(row.generation ? { generation: String(row.generation) } : {}) })
      this.historyIncidents = { at: String(row.observed_at), id: String(row.id) }
    }
  }
  private report(event: TickEvent) { try { this.observer(event) } catch { /* Diagnostics never break delivery. */ } }
  private phase(step: string) {
    const run = this.runContext.getStore()
    if (!run) return
    const now = Date.now(), ms = now - run.phaseStarted
    if (ms > run.slowest.ms) run.slowest = { step: run.step, ms }
    run.step = step; run.phaseStarted = now
  }
  /**
   * One probe of a process or peer the tick does not own. TIMED_OUT past TICK_PROBE_TIMEOUT_MS, FAILED on rejection: the caller
   * skips that unit only. A pending probe with the same key is reused, so a probe that never settles is never duplicated.
   */
  private async bounded<T>(key: string, step: string, probe: () => Promise<T>, sessionId?: string): Promise<T | typeof TIMED_OUT | typeof FAILED> {
    let pending = this.probes.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = probe()
      this.probes.set(key, pending)
      const forget = () => { if (this.probes.get(key) === pending) this.probes.delete(key) }
      pending.then(forget, forget)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now(), detail = sessionId ? { session_id: sessionId } : {}
    try {
      const result = await Promise.race([pending, new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), TICK_PROBE_TIMEOUT_MS); timer.unref() })])
      if (result === TIMED_OUT) this.report({ event: "probe_timeout", step, duration_ms: Date.now() - started, ...detail })
      return result
    } catch {
      this.report({ event: "probe_failed", step, duration_ms: Date.now() - started, ...detail })
      return FAILED
    } finally { clearTimeout(timer) }
  }
  /** True when the session is held by another (possibly detached) tick; reports once when that hold outlives TICK_STUCK_MS. */
  private held(sid: string, step: string) {
    const hold = this.inFlight.get(sid)
    if (!hold) return false
    if (!hold.reported && Date.now() - hold.since >= TICK_STUCK_MS) {
      hold.reported = true
      this.report({ event: "dispatch_in_flight", step, duration_ms: Date.now() - hold.since, session_id: sid })
    }
    return true
  }
  async tick() {
    if (!this.collaborationEnabled()) return
    // Grants are re-checked on every read, but a session that closes or goes silent and then reconnects before a sweep would
    // regain one; a failure in any later step of the tick must not postpone revocation.
    await this.chat.sweepReadAccess().catch(() => undefined)
    this.phase("fleet_lease")
    if(this.fleet)for(const session of await this.chat.db.query("SELECT id FROM chat_sessions WHERE capability='hub_fleet' AND closed_at IS NULL")) {
      const fleet=this.fleet
      if(await this.bounded(`connected:${session.id}`,"fleet_connected",()=>fleet.connected(String(session.id)),String(session.id))===true) {
        await this.chat.db.query('UPDATE chat_sessions SET lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[session.id,new Date(Date.now()+90000).toISOString()])
        await this.recordFleetActivity(String(session.id))
      }
    }
    this.phase("pid_check")
    // PID birth time prevents a recycled PID from keeping a dead session online.
    const processes = await this.chat.db.query('SELECT s.id,s.process_id,s.process_started FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.closed_at IS NULL AND c.closed_at IS NULL AND s.process_id IS NOT NULL')
    for (const s of processes) {
      const live=await this.bounded(`process:${s.id}:${s.process_id}`,"inspect_process",()=>this.inspectProcess(s.process_id),String(s.id))
      if(live===undefined || live===TIMED_OUT || live===FAILED)continue
      if(live && !s.process_started)continue // No birth identity: a live PID cannot prove replacement.
      // A birth identity stored by an older version (ps lstart) cannot be compared with the stable Linux one; it proves nothing.
      if(live && isStableProcessStart(live.started)!==isStableProcessStart(s.process_started))continue
      if(live && live.started===s.process_started) {
        await this.chat.db.query('UPDATE chat_sessions SET lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[s.id,new Date(Date.now()+90000).toISOString()])
      } else {
        await this.chat.closeTurnForPid(s.id)
        await this.chat.db.query("UPDATE chat_sessions SET state='offline',closed_at=now(),lease_until=NULL WHERE id=$1 AND closed_at IS NULL",[s.id])
      }
    }
    // After the fleet and PID lease renewals, so a live session is never taken as disconnected.
    this.phase("archive")
    await this.chat.sweepArchive().catch(() => undefined)
    this.phase("turn_alerts")
    await this.chat.processTurnAlerts()
    this.phase("response_alerts")
    await this.chat.processResponseAlerts()
    this.phase("liveness")
    if(this.fleet?.readiness) {
      const now=Date.now()
      for(const candidate of await this.chat.fleetLivenessCandidates()) try {
        const runtime=typeof candidate.runtime==="string"?JSON.parse(candidate.runtime):candidate.runtime
        const fleet=this.fleet
        if(await this.bounded(`readiness:${candidate.session_id}`,"fleet_readiness",()=>fleet.readiness!(String(candidate.session_id)),String(candidate.session_id))==="unowned" && now-Date.parse(runtime.updated_at)>60_000)
          await this.chat.raiseLiveness(now,candidate,candidate.hub_restart?"hub_restart":["failed","stopped"].includes(runtime.state)?"exited":"unowned")
      } catch {
        // A malformed or unavailable runtime is retried on the next tick.
      }
    }
    this.phase("interhub")
    const interhub=this.chat.interhubSweep?.bind(this.chat)
    if(interhub)await this.bounded("interhub","interhub_sweep",()=>interhub())
    this.phase("read_access")
    await this.chat.sweepReadAccess()
    this.phase("deliveries")
    // Native queue addresses the exact conversation and verifies it at delivery time.
    // A managed app-server may not expose a per-TUI PID to hooks; its idle lease is
    // advisory presence, not a reason to silently suppress durable notifications.
    // Recipients of a stalled-delivery notice go last: the original delivery of this tick may resolve that notice before it wakes anyone.
    const sessions = await this.chat.db.query(`SELECT s.* FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
      WHERE s.nickname IS NOT NULL AND s.capability IN ('codex_queue','hub_fleet') AND (s.capability='hub_fleet' OR s.native_id IS NOT NULL) AND (s.state='idle' OR s.capability='hub_fleet' OR (s.state='busy' AND s.cli_kind='codex_cli')) AND s.closed_at IS NULL AND c.closed_at IS NULL
      AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL OR EXISTS(SELECT 1 FROM chat_channels led WHERE led.leader_id=s.id AND led.closed_at IS NULL))
      AND (EXISTS(SELECT 1 FROM chat_deliveries d WHERE d.recipient_id=s.id AND d.read_at IS NULL AND d.notified_at IS NULL AND d.cancelled_at IS NULL AND d.next_attempt_at<=now() AND d.attempts<5)
        OR EXISTS(SELECT 1 FROM chat_status_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.handled_at IS NULL AND n.cancelled_at IS NULL AND n.notified_at IS NULL AND n.next_attempt_at<=now() AND n.attempts<5) OR EXISTS(SELECT 1 FROM usage_quota_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.notified_at IS NULL AND n.next_attempt_at<=now() AND n.attempts<5))
      ORDER BY EXISTS(SELECT 1 FROM chat_status_notices n WHERE n.recipient_id=s.id AND n.cause='delivery_stalled' AND n.handled_at IS NULL AND n.cancelled_at IS NULL)`)
    for (const s of sessions) {
      if (this.stopped) return
      if (!this.enabled(s.agent_id) || this.held(String(s.id),"deliveries")) continue
      this.inFlight.set(String(s.id),{since:Date.now(),reported:false})
      try {
      // The persisted row of a Hub worker can lag its process; the manager decides whether input is accepted now.
      const probed=s.capability==='hub_fleet' ? await this.bounded(`readiness:${s.id}`,"fleet_readiness",()=>this.fleetReadiness(s),String(s.id)) : undefined
      if (probed===TIMED_OUT || probed===FAILED || probed==='busy' || this.stopped) continue
      const readiness=probed
      const deliveries = await this.claim(s.id,true,readiness!==undefined)
      const quota=new UsageNotices(this.chat),notices=await quota.claim(s.id)
      if (!deliveries.length && !notices.length) continue
      try {
        if (!this.collaborationEnabled() || !this.enabled(s.agent_id)) continue
        await this.dispatch(s,[deliveries.length?chatWakeText(deliveries.map(d=>d.message_id)):'',notices.length?usageWakeText:''].filter(Boolean).join('\n'))
        await quota.notified(s.id,notices.map(n=>String(n.id)))
        await this.notified(s.id,deliveries.map(d=>d.message_id))
        this.report({ event: "delivery_notified", step: "deliveries", duration_ms: 0, session_id: String(s.id), count: deliveries.length + notices.length })
      } catch (error) {
        if((error as {retryLater?:boolean}).retryLater) {
          this.report({ event: "delivery_retry_later", step: "deliveries", duration_ms: 0, session_id: String(s.id), count: deliveries.length + notices.length })
          await this.release(s.id,deliveries,notices)
          continue
        }
        const uncertain=(error as {retryable?:boolean}).retryable===false
        this.report({event:"delivery_failed",step:"deliveries",duration_ms:0,session_id:String(s.id),count:deliveries.length+notices.length,uncertain})
        await this.chat.db.query('UPDATE chat_sessions SET wake_error=$2 WHERE id=$1',[s.id,uncertain?'Entrega incierta; no se reenvía automáticamente. El mensaje sigue en inbox.':'No se pudo notificar a la sesión; comprobá versión, sesión y conexión. Se reintentará hasta 5 veces.'])
        if(uncertain)for(const notice of notices)await this.chat.db.query('UPDATE usage_quota_notices SET attempts=5 WHERE id=$1 AND recipient_id=$2',[notice.id,s.id])
        for (const d of deliveries) {
          const table=d.kind==='status_notice'?'chat_status_notices':'chat_deliveries',column=d.kind==='status_notice'?'id':'message_id'
          await this.chat.db.query(`UPDATE ${table} SET error=$3${uncertain?',attempts=5':''} WHERE recipient_id=$1 AND ${column}=$2 AND cancelled_at IS NULL`,[s.id,d.message_id,uncertain?'Entrega incierta; no se reenvía automáticamente. El mensaje sigue en inbox.':'No se pudo notificar a la CLI'])
        }
      }
      } finally { this.inFlight.delete(String(s.id)) }
    }
    this.phase("bootstrap")
    const newcomers=await this.chat.db.query(`SELECT s.* FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE c.leader_id IS NOT NULL AND c.closed_at IS NULL AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND s.team_seen=0 AND s.bootstrap_attempts<5 AND (s.bootstrap_sent_at IS NULL OR s.bootstrap_sent_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')) AND s.closed_at IS NULL AND s.state='idle' AND s.capability IN ('codex_queue','hub_fleet') AND s.native_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM chat_deliveries d WHERE d.recipient_id=s.id AND d.read_at IS NULL AND d.cancelled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM chat_status_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.cancelled_at IS NULL)`)
    for(const s of newcomers) {
      if(this.stopped)return
      if(!this.enabled(s.agent_id) || this.held(String(s.id),"bootstrap"))continue
      this.inFlight.set(String(s.id),{since:Date.now(),reported:false})
      try {
        if(!await this.claimBootstrap(s.id))continue
        if (!this.collaborationEnabled() || !this.enabled(s.agent_id) || this.stopped) continue
        try {await this.dispatch(s,s.nickname?teamBootstrap:'Agent Hub: register a nickname via memory_chat_set_nick.')}catch (error) {
          this.report({ event: "bootstrap_failed", step: "bootstrap", duration_ms: 0, session_id: String(s.id), uncertain: (error as { retryable?: boolean }).retryable === false })
          await this.chat.db.query("UPDATE chat_sessions SET wake_error='No se pudo iniciar el registro automático' WHERE id=$1",[s.id])
        }
      } finally { this.inFlight.delete(String(s.id)) }
    }
    // After dispatch, so a delivery this tick could still make never raises a notice that is cancelled moments later.
    this.phase("stalled_deliveries")
    await this.chat.processStalledDeliveries()
    this.phase("history")
    await this.recordHistory()
    this.phase("idle")
  }
  /**
   * Persists output evidence of a busy Hub worker at most every 30 s. Only output_at moves, plus the session activity record: the lifecycle
   * columns and chat_turns stay owned by native turn events, and an idle or closed row ignores a late timestamp.
   */
  private async recordFleetActivity(sid:string) {
    const fleet=this.fleet
    if(!fleet?.activityAt)return
    const evidence=await this.bounded(`activity:${sid}`,"fleet_activity",()=>fleet.activityAt!(sid),sid)
    if(!evidence || evidence===TIMED_OUT || evidence===FAILED)return
    const last=this.activityWritten.get(sid)
    if(last?.at===evidence.at || (last && Date.now()-last.written<30_000))return
    // Only an open turn with the same id may extend the busy interval; a late chunk of an earlier turn finds no match.
    const written=await this.chat.db.query(`UPDATE chat_sessions SET output_at=$2 WHERE id=$1 AND capability='hub_fleet' AND state='busy'
      AND closed_at IS NULL AND removed_at IS NULL AND (output_at IS NULL OR output_at<$2)
      AND EXISTS(SELECT 1 FROM chat_turns t WHERE t.session_id=$1 AND t.turn_id=$3 AND t.terminal_at IS NULL) RETURNING id`,[sid,evidence.at,evidence.turn_id])
    if(!written.length)return
    this.activityWritten.set(sid,{at:evidence.at,written:Date.now()})
    await markSessionActivity(this.chat.db,sid)
  }
  /** Undefined when the fleet cannot report readiness: the persisted state then gates delivery exactly as for any other session. */
  private async fleetReadiness(session:Record<string,any>):Promise<FleetReadiness | undefined> {
    return this.fleet?.readiness?.(String(session.id))
  }
  /** Returns the attempt a claim consumed when the target was only transiently unable to accept input. */
  private async release(sid:string,deliveries:{message_id:string;kind:string}[],notices:Record<string,any>[]) {
    for(const d of deliveries) {
      const table=d.kind==='status_notice'?'chat_status_notices':'chat_deliveries',column=d.kind==='status_notice'?'id':'message_id'
      await this.chat.db.query(`UPDATE ${table} SET attempts=MAX(attempts-1,0) WHERE recipient_id=$1 AND ${column}=$2 AND notified_at IS NULL AND read_at IS NULL AND cancelled_at IS NULL`,[sid,d.message_id])
    }
    for(const n of notices)await this.chat.db.query('UPDATE usage_quota_notices SET attempts=MAX(attempts-1,0) WHERE id=$1 AND recipient_id=$2 AND notified_at IS NULL AND read_at IS NULL',[n.id,sid])
  }
  private async dispatch(session:Record<string,any>,text:string) {
    if(session.capability==='hub_fleet') {
      if(!await this.fleet?.wake(String(session.id),text))throw new Error('El Hub no controla esta sesión')
    } else await this.queue(session.native_id,text)
  }
  private async claimBootstrap(sid:string) {
    return (await this.chat.db.query(`UPDATE chat_sessions SET bootstrap_sent_at=now(),bootstrap_attempts=bootstrap_attempts+1
      WHERE id=$1 AND team_seen=0 AND bootstrap_attempts<5 AND state='idle' AND closed_at IS NULL
      AND (bootstrap_sent_at IS NULL OR bootstrap_sent_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')) RETURNING id`,[sid])).length>0
  }
  /** managerApproved: the caller verified readiness with the process owner, so the persisted state does not gate the claim. */
  private async claim(sid: string, midTurn=false, managerApproved=false) {
    return this.chat.db.transaction(async()=>{
      await this.chat.cancelInvalidTurnAlerts()
      const mentions=await this.chat.db.query(`UPDATE chat_deliveries SET attempts=attempts+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(300,30*(attempts+1))||' seconds')
      WHERE recipient_id=$1 AND read_at IS NULL AND notified_at IS NULL AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=$1 AND s.closed_at IS NULL AND s.removed_at IS NULL AND (s.state='idle' OR $3=1 OR ($2=1 AND s.state='busy' AND s.cli_kind='codex_cli'))) AND attempts<5 AND next_attempt_at<=now() RETURNING message_id`,[sid,midTurn?1:0,managerApproved?1:0])
      const notices=await this.chat.db.query(`UPDATE chat_status_notices SET attempts=attempts+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(300,30*(attempts+1))||' seconds')
        WHERE recipient_id=$1 AND read_at IS NULL AND handled_at IS NULL AND cancelled_at IS NULL AND notified_at IS NULL
        AND EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=$1 AND s.closed_at IS NULL AND s.removed_at IS NULL AND (s.state='idle' OR $3=1 OR ($2=1 AND s.state='busy' AND s.cli_kind='codex_cli')))
        AND attempts<5 AND next_attempt_at<=now() RETURNING id AS message_id`,[sid,midTurn?1:0,managerApproved?1:0])
      return [...mentions.map(d=>({message_id:String(d.message_id),kind:'mention'})),...notices.map(d=>({message_id:String(d.message_id),kind:'status_notice'}))]
    })
  }
  private async notified(sid: string, ids: string[]) {
    for (const id of ids) {
      await this.chat.db.query('UPDATE chat_deliveries SET notified_at=COALESCE(notified_at,now()),error=NULL WHERE recipient_id=$1 AND message_id=$2 AND cancelled_at IS NULL',[sid,id])
      await this.chat.db.query('UPDATE chat_status_notices SET notified_at=COALESCE(notified_at,now()),error=NULL WHERE recipient_id=$1 AND id=$2 AND cancelled_at IS NULL',[sid,id])
    }
    await this.chat.db.query('UPDATE chat_sessions SET wake_error=NULL WHERE id=$1',[sid])
  }
  /** Native asyncRewake hook, not a model tool. HTTP waits are renewed without consuming context. */
  async wait(sid: string, signal?: AbortSignal, started = new Date().toISOString()) {
    const previous = this.watchers.get(sid)
    if (previous && previous.started > started) return { closed:true,messages:[] }
    previous?.controller.abort()
    const controller = new AbortController(); this.controllers.add(controller)
    this.watchers.set(sid,{started,controller})
    const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{ once:true })
    if (signal?.aborted || this.stopped) controller.abort()
    const deadline = Date.now()+25000
    try {
      while (!controller.signal.aborted && Date.now()<deadline) {
        // Subscribe before reading the DB so a delivery between the query and wait cannot be lost.
        let dispose=()=>{}
        const change=new Promise<void>(resolve=>{
          const finish=()=>{dispose();resolve()}
          const timer=setTimeout(finish,Math.min(5000,Math.max(1,deadline-Date.now())))
          dispose=()=>{clearTimeout(timer);this.chat.events.off('change',finish);controller.signal.removeEventListener('abort',finish)}
          this.chat.events.once('change',finish);controller.signal.addEventListener('abort',finish,{once:true})
          if(controller.signal.aborted)finish()
        })
        try {
          const s = (await this.chat.db.query('SELECT s.*,c.leader_id,c.orca_workspace_id,c.closed_at AS channel_closed_at,c.kind AS channel_kind,c.activated_at FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.id=$1',[sid]))[0]
          if (!this.collaborationEnabled() || !s || s.capability==='hub_fleet' || s.closed_at || s.channel_closed_at || !this.enabled(s.agent_id)) return { closed:true, messages:[] }
          if (s.state === 'idle') {
            if (!s.nickname && (s.channel_kind!=='virtual' || s.activated_at)) {
              if(await this.claimBootstrap(sid)) return {messages:[],bootstrap:true,context:'Agent Hub: register a nickname via memory_chat_set_nick.'}
              await change
              continue
            }
            if(s.leader_id && await this.claimBootstrap(sid)) {
              if (!this.collaborationEnabled() || !this.enabled(s.agent_id)) return { closed:true, messages:[] }
              return {messages:[],bootstrap:true,context:teamBootstrap}
            }
            const deliveries = await this.claim(sid)
            const quota=new UsageNotices(this.chat),notices=await quota.claim(sid)
            if (deliveries.length || notices.length) {
              if (!this.collaborationEnabled() || !this.enabled(s.agent_id)) return { closed:true, messages:[] }
              const ids = deliveries.map(d=>String(d.message_id)); await this.notified(sid,ids)
              await quota.notified(sid,notices.map(n=>String(n.id)))
              return { messages:[...ids,...notices.map(n=>String(n.id))], context:[ids.length?chatWakeText(ids):'',notices.length?usageWakeText:''].filter(Boolean).join('\n') }
            }
          }
          await change
        } finally {dispose()}
      }
      return { messages:[], ...(this.watchers.get(sid)?.started !== started ? {closed:true} : {}) }
    } finally { signal?.removeEventListener('abort',abort); this.controllers.delete(controller) }
  }
}
