import { randomUUID } from "node:crypto"
import type { AgentContext } from "./agents.js"
import type { AdmissionGate } from "./admission-gate.js"
import { check, MemoryError } from "./contracts.js"
import type { MemoryDatabase, TransactionSql } from "./database.js"
import type { LocalChat } from "./local-chat.js"
import type { HubLog } from "./report.js"
import type { CoordinatedFleetMember, CoordinatedFleetReceipt, HubTeamRuntime } from "./team-hub.js"
import type { DrainResult, UpdateDrain } from "./update-drain.js"

const TERMINAL_STATES = ["resumed", "postponed", "cancelled"] as const
const ACTIVE_PLAN_SQL = "('launching','launched','partial','uncertain','active')"
const UPDATE_DEADLINE_MS = 30 * 60_000
const QUIT_GRACE_MS = 15 * 60_000
const GATE_RENEW_MS = 5 * 60_000
const QUIT_READY_TIMEOUT_MS = 15 * 60_000

export type HubStopReason = "update" | "quit"
export type HubStopState = "requested" | "notifying" | "waiting_confirmations" | "waiting_members" | "stopping_fleet" | "ready" | "applied" | typeof TERMINAL_STATES[number]

export interface HubStopRequest {
  source_id: string
  reason: HubStopReason
  target_version?: string
}

export interface HubStopView {
  stop_id: string
  source_id: string
  reason: HubStopReason
  state: HubStopState
  target_version: string | null
  transaction_id: string | null
  requested_at: string
  deadline_at: string
  force_at: string | null
  grace_started_at: string | null
  backup_id: string | null
  retry_not_before: string | null
  ready: boolean
  forced: boolean
  waiting_for: { coordinators: string[]; leaders_in_turn: string[]; members: Array<{ member_id: string; state: string; proof_complete: boolean }> }
  receipts: Array<{ member_id: string; generation: string; attempt: number; outcome: string; observed_at: string }>
  error: { code: string; detail: string | null; actions: Array<"retry" | "cancel" | "commit"> } | null
  drain: { owner: string | null; boot_id: string | null; generation: number | null; lease: string | null }
}

type StopRow = Record<string, any> & { id: string; reason: HubStopReason; state: HubStopState }
type BackupReceipt = { id: string }

/** Durable protocol that keeps MCP open while leaders coordinate and owns the non-MCP gate until UpdateDrain adopts it. */
export class HubStopCoordinator {
  readonly bootId = randomUUID()
  private gateToken: symbol | null = null
  private drain: UpdateDrain | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: {
    db: MemoryDatabase
    chat: LocalChat
    fleet?: HubTeamRuntime
    admission: AdmissionGate
    backup(): Promise<BackupReceipt>
    log: HubLog
    startupTransaction?: string
    legacyGateways?(): Promise<import("./update-drain.js").LegacyGatewayScan>
    now?: () => number
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private arm(stop: StopRow): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]) || stop.state === "applied") return
    const deadline = Date.parse(stop.deadline_at)
    const forcedRetryAt = stop.force_next_at ? Date.parse(stop.force_next_at) : null
    const protocolAt = forcedRetryAt ?? (stop.state === "ready"
      ? stop.reason === "update" && stop.gate_owner !== "drain" ? deadline
        : stop.reason === "quit" && stop.gate_owner !== "drain" && stop.ready_at ? Date.parse(stop.ready_at) + QUIT_READY_TIMEOUT_MS : Infinity
      : stop.reason === "quit" && stop.grace_started_at && stop.force_at ? Date.parse(stop.force_at) : deadline)
    const renewalAt = stop.gate_owner === "coordinator" ? this.now() + GATE_RENEW_MS : Infinity
    const drainCheckAt = stop.gate_owner === "drain" ? this.now() + 60_000 : Infinity
    const at = Math.min(protocolAt, renewalAt, drainCheckAt)
    if (!Number.isFinite(at)) return
    const delay = Math.max(1_000, at - this.now())
    this.timer = setTimeout(() => {
      void this.exclusive(async () => {
        try {
          await this.advance(stop.id)
        } catch (error) {
          this.log(stop.id, "blocked", { error_code: "advance_failed", error: error instanceof Error ? error.message : String(error) })
        }
        this.arm(await this.requireStop(stop.id))
      }).catch(error => {
        this.log(stop.id, "blocked", { error_code: "rearm_failed", error: error instanceof Error ? error.message : String(error) })
        // requireStop or arm failed: re-arm from the last known row after a fixed 5 s backoff.
        this.timer = setTimeout(() => this.arm(stop), 5_000)
        this.timer.unref()
      })
    }, delay)
    this.timer.unref()
  }

  private async event(sql: TransactionSql, stopId: string, type: string, payload: Record<string, unknown> = {}, actorSessionId?: string): Promise<string> {
    const id = randomUUID()
    await sql.query("INSERT INTO hub_stop_events(id,stop_id,type,actor_session_id,payload) VALUES($1,$2,$3,$4,$5)",
      [id, stopId, type, actorSessionId ?? null, JSON.stringify(payload)])
    return id
  }

  private log(stopId: string, event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
    this.deps.log.event("hub_stop", event, { stop_id: stopId, boot_id: this.bootId, ...fields })
  }

  private async active(): Promise<StopRow | undefined> {
    return (await this.deps.db.query<StopRow>(`SELECT * FROM hub_stops WHERE state NOT IN ('resumed','postponed','cancelled') ORDER BY requested_at DESC LIMIT 1`))[0]
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      const stop = await this.active()
      if (!stop) {
        await this.deps.db.query("DELETE FROM settings WHERE key='update_admission'")
        return
      }
      if (stop.state === "applied") {
        if (stop.reason === "quit" && stop.apply_boot_id !== this.bootId) await this.resume(stop)
        else if (stop.reason === "update" && this.deps.startupTransaction && this.deps.startupTransaction !== stop.apply_transaction_id) {
          await this.deps.db.query("UPDATE hub_stops SET last_error_code='resume_transaction_mismatch',last_error_detail='La actualización aplicada no coincide con la transacción de arranque; se conserva la evidencia.',updated_at=now() WHERE id=$1", [stop.id])
          this.log(stop.id, "blocked", { error_code: "resume_transaction_mismatch", startup_transaction: this.deps.startupTransaction })
        } else if (stop.reason === "update" && !this.deps.startupTransaction) {
          await this.deps.db.transaction(sql => this.event(sql, stop.id, "startup_tx_from_stop", { transaction_id: stop.apply_transaction_id }))
          this.log(stop.id, "startup_tx_from_stop", { transaction_id: stop.apply_transaction_id })
        }
        return
      }
      if (stop.reason === "quit") {
        if (stop.gate_owner === "drain") await this.releaseDrain(stop)
        await this.terminal(await this.requireStop(stop.id), "cancelled", "core_restarted")
        return
      }
      if (stop.gate_owner === "drain") {
        await this.deps.db.query("UPDATE hub_stops SET gate_owner=NULL,last_error_code='drain_owner_recovered',last_error_detail='El core anterior terminó; se reconstruyó el cierre con un token nuevo.',updated_at=now() WHERE id=$1", [stop.id])
        stop.gate_owner = null
      }
      if (["waiting_members", "stopping_fleet", "ready"].includes(stop.state)) await this.ensureGate(stop)
      await this.advance(stop.id)
      this.arm(await this.requireStop(stop.id))
    })
  }

  async request(input: HubStopRequest): Promise<HubStopView> {
    return this.exclusive(async () => {
      let stop = (await this.deps.db.query<StopRow>("SELECT * FROM hub_stops WHERE source_id=$1", [input.source_id]))[0]
      if (!stop && input.reason === "update") {
        const cooldown = (await this.deps.db.query<StopRow>("SELECT * FROM hub_stops WHERE state='postponed' AND retry_not_before>=$1 ORDER BY retry_not_before DESC LIMIT 1", [new Date(this.now()).toISOString()]))[0]
        if (cooldown) return this.view(cooldown.id)
      }
      if (!stop) {
        const current = await this.active()
        if (current && input.reason === "quit" && current.reason === "quit") {
          await this.deps.db.transaction(async sql => {
            await this.event(sql, current.id, "quit_adopted", { previous_source_id: current.source_id, requested_source_id: input.source_id })
          })
          this.log(current.id, "quit_adopted", { previous_source_id: current.source_id, requested_source_id: input.source_id })
          await this.advance(current.id)
          this.arm(await this.requireStop(current.id))
          return this.view(current.id)
        }
        check(!current, "Ya existe una parada coordinada activa.", 409)
        const now = this.now(), deadline = now + UPDATE_DEADLINE_MS
        const stopId = randomUUID()
        await this.deps.db.transaction(async sql => {
          await sql.query(`INSERT INTO hub_stops(id,reason,source_id,target_version,state,requested_at,deadline_at,force_at,updated_at)
            VALUES($1,$2,$3,$4,'requested',$5,$6,$7,$5)`, [stopId, input.reason, input.source_id, input.target_version ?? null,
            new Date(now).toISOString(), new Date(deadline).toISOString(), input.reason === "quit" ? new Date(deadline + QUIT_GRACE_MS).toISOString() : null])
          await this.event(sql, stopId, "requested", { reason: input.reason, target_version: input.target_version ?? null })
        })
        this.log(stopId, "requested", { reason: input.reason, target_version: input.target_version ?? null })
        stop = (await this.deps.db.query<StopRow>("SELECT * FROM hub_stops WHERE id=$1", [stopId]))[0]!
      } else {
        check(stop.reason === input.reason && (stop.target_version ?? null) === (input.target_version ?? null), "source_id ya pertenece a otra solicitud de parada.", 409)
      }
      await this.advance(stop.id)
      this.arm(await this.requireStop(stop.id))
      return this.view(stop.id)
    })
  }

  async retry(stopId: string): Promise<HubStopView> {
    return this.exclusive(async () => {
      const stop = await this.requireStop(stopId)
      check(!TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]) && stop.state !== "applied", "La parada ya terminó.", 409)
      check(!this.drainCommitted(stop), "El drain ya quedó comprometido; reintentá /api/internal/hub-stop/commit.", 409)
      if (stop.gate_owner === "drain" && (stop.drain_lease ? !this.drainLeaseValid(stop) : !this.drain?.hasPendingAttempt)) {
        await this.releaseDrain(stop)
        await this.deps.db.query("UPDATE hub_stops SET state='waiting_members',gate_owner=NULL,drain_lease=NULL,drain_generation=NULL,drain_boot_id=NULL,updated_at=now() WHERE id=$1", [stopId])
      }
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET last_error_code=NULL,last_error_detail=NULL,updated_at=now() WHERE id=$1", [stopId])
        await this.event(sql, stopId, "retry_requested")
      })
      this.log(stopId, "retry_requested")
      await this.advance(stopId)
      this.arm(await this.requireStop(stopId))
      return this.view(stopId)
    })
  }

  async confirm(agent: AgentContext | undefined, sessionKey: string, stopId: string): Promise<HubStopView> {
    const who = await this.deps.chat.identity(agent, sessionKey)
    return this.exclusive(async () => {
      const snapshot = await this.deps.fleet?.coordinatedSnapshot()
      const confirmedPlans = await this.deps.db.transaction(async sql => {
        const stop = (await sql.query<StopRow>("SELECT * FROM hub_stops WHERE id=$1", [stopId]))[0]
        check(stop && !TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]), "La parada no admite confirmaciones.", 409)
        const targets = await sql.query(`SELECT target.*,p.state AS plan_state,p.created_by,c.leader_id,c.leader_changed_at,c.closed_at AS channel_closed,
          actor.closed_at AS actor_closed,actor.removed_at AS actor_removed
          FROM hub_stop_targets target JOIN chat_team_plans p ON p.id=target.plan_id JOIN chat_channels c ON c.id=p.master_channel_id
          JOIN chat_sessions actor ON actor.id=target.session_id
          WHERE target.stop_id=$1 AND target.session_id=$2 AND target.target_kind='coordinator' AND target.required=1 AND target.invalidated_at IS NULL
          ORDER BY target.plan_id,target.id`, [stopId, who.id])
        check(targets.length > 0, "Esta sesión no es un coordinador requerido para la parada.", 403)
        const changed: string[] = []
        for (const target of targets) {
          check(!target.actor_closed && !target.actor_removed, "La sesión coordinadora está cerrada o removida y no puede confirmar.", 403)
          check(String(target.plan_state) && !["paused", "cancelled", "completed", "prepared"].includes(String(target.plan_state))
            && !target.channel_closed && target.created_by === who.id && target.leader_id === who.id,
          "La autoridad del coordinador cambió; la confirmación no se reutiliza.", 403)
          check(target.authority_generation === this.authorityGeneration(target), "La autoridad del coordinador cambió; volvé a consultar el estado.", 409)
          if (target.confirmed_at) continue
          await sql.query("UPDATE hub_stop_targets SET confirmed_at=now(),confirmed_members=$2 WHERE id=$1 AND confirmed_at IS NULL",
            [target.id, this.memberFingerprint(snapshot, String(target.plan_id))])
          await this.event(sql, stopId, "confirmed", { target_id: target.id, plan_id: target.plan_id }, String(who.id))
          changed.push(String(target.plan_id))
        }
        return changed
      })
      for (const planId of confirmedPlans) this.log(stopId, "confirmed", { session_id: String(who.id), plan_id: planId })
      this.deps.chat.events.emit("change")
      await this.advance(stopId)
      this.arm(await this.requireStop(stopId))
      return this.view(stopId)
    })
  }

  async cancel(stopId: string, reason: string): Promise<HubStopView> {
    return this.exclusive(async () => {
      const stop = await this.requireStop(stopId)
      check(!["applied", "resumed", "postponed", "cancelled"].includes(stop.state), "La parada ya no se puede cancelar.", 409)
      if (stop.gate_owner === "drain") await this.releaseDrain(stop)
      await this.terminal(await this.requireStop(stopId), "cancelled", reason)
      const result = await this.requireStop(stopId)
      check(result.state === "cancelled", "La reapertura no quedó confirmada; la parada sigue activa.", 409)
      return this.view(stopId)
    })
  }

  async status(stopId?: string): Promise<HubStopView | null> {
    return this.exclusive(async () => {
      const stop = stopId ? await this.requireStop(stopId) : await this.active()
      if (!stop) return null
      if (!TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]) && stop.state !== "applied") await this.advance(stop.id)
      this.arm(await this.requireStop(stop.id))
      return this.view(stop.id)
    })
  }

  async recoverAbandonedCommit(reason: string, reopened: boolean): Promise<void> {
    await this.exclusive(async () => {
      const stop = await this.active()
      if (!stop || stop.state !== "applied") return
      await this.deps.db.transaction(async sql => {
        await sql.query(`UPDATE hub_stops SET state='waiting_members',gate_owner=NULL,drain_boot_id=NULL,drain_generation=NULL,drain_lease=NULL,
          last_error_code='commit_abandoned',last_error_detail=$2,updated_at=now() WHERE id=$1 AND state='applied'`, [stop.id, reason])
        await this.event(sql, stop.id, "commit_abandoned", { reason, reopened })
      })
      this.drain = null
      this.deps.fleet?.endCoordinatedStop(stop.id)
      this.log(stop.id, "commit_abandoned", { reason, reopened })
      this.arm(await this.requireStop(stop.id))
    })
  }

  async appliedTransaction(): Promise<string | null> {
    const stop = await this.active()
    return stop?.state === "applied" && stop.reason === "update" && typeof stop.apply_transaction_id === "string" ? stop.apply_transaction_id : null
  }

  async assertStartupTransaction(transactionId: string): Promise<void> {
    const stop = await this.active()
    if (!stop || stop.state !== "applied") return
    check(stop.reason === "update" && stop.apply_transaction_id === transactionId
      && (!this.deps.startupTransaction || this.deps.startupTransaction === transactionId),
      "La transacción de arranque no coincide con la parada aplicada; el Hub conserva el bloqueo.", 409)
  }

  async resumeApplied(transactionId: string): Promise<HubStopView | null> {
    return this.exclusive(async () => {
      const stop = await this.active()
      if (!stop || stop.state !== "applied") return null
      check(stop.reason === "update" && stop.apply_transaction_id === transactionId
      && (!this.deps.startupTransaction || this.deps.startupTransaction === transactionId),
        "La admisión pertenece a otra transacción de actualización.", 409)
      await this.resume(stop)
      return this.view(stop.id)
    })
  }

  async acquireDrain(stopId: string, drain: UpdateDrain): Promise<DrainResult> {
    return this.exclusive(async () => {
      await this.advance(stopId)
      this.drain = drain
      const stop = await this.requireStop(stopId)
      check(stop.state === "ready", "La flota todavía no confirmó una parada segura.", 409)
      if (stop.gate_owner === "drain") {
        check(drain.hasPendingAttempt, "El dueño del cierre de admisiones es ambiguo; reintentá o cancelá la parada.", 409)
      } else {
        await this.ensureGate(stop)
        check(this.gateToken && this.deps.admission.isClosed(), "No se pudo probar el cierre de admisiones no-MCP.", 409)
        check(drain.adoptAdmission(this.deps.admission, this.gateToken), "El drenaje ya pertenece a otra operación.", 409)
        this.gateToken = null
        await this.deps.db.query("UPDATE hub_stops SET gate_owner='drain',updated_at=now() WHERE id=$1 AND state='ready'", [stopId])
      }
      const result = await drain.acquire()
      if (result.ok) {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stops SET drain_boot_id=$2,drain_generation=$3,drain_lease=$4,last_error_code=NULL,last_error_detail=NULL,updated_at=now() WHERE id=$1 AND state='ready'",
            [stopId, result.boot_id, result.generation, result.lease])
          await this.event(sql, stopId, "lease_granted", { boot_id: result.boot_id, generation: result.generation })
        })
        this.log(stopId, "lease_granted", { drain_boot_id: result.boot_id, generation: result.generation })
        this.arm(await this.requireStop(stopId))
        return result
      }
      const converging = result.reasons.every(item => item.code === "jobs_nonresumable" || item.code === "mcp_inflight")
      if (!converging) {
        await this.deps.db.query("UPDATE hub_stops SET state='waiting_members',gate_owner=NULL,last_error_code='drain_not_ready',last_error_detail=$2,updated_at=now() WHERE id=$1 AND state='ready'",
          [stopId, JSON.stringify(result.reasons)])
        this.log(stopId, "drain_refused", { reasons: result.reasons.map(item => item.code).join(",") })
      }
      this.arm(await this.requireStop(stopId))
      return result
    })
  }

  /** Commits the exact drain, records applied durably, then schedules core shutdown. Safe to retry after either boundary. */
  async commit(stopId: string, drain: UpdateDrain, transactionId?: string): Promise<HubStopView> {
    return this.exclusive(async () => {
      this.drain = drain
      let stop = await this.requireStop(stopId)
      check(stop.state === "ready" || stop.state === "applied", "La parada no está lista para aplicar.", 409)
      check(stop.drain_boot_id && stop.drain_lease && stop.drain_generation !== null && stop.drain_generation !== undefined,
        "La parada no tiene un lease verificable para aplicar.", 409)
      check(stop.reason !== "update" || transactionId, "Una actualización aplicada requiere la transacción durable.", 409)
      check(stop.state !== "applied" || stop.apply_transaction_id === (transactionId ?? null), "El commit reintentado pertenece a otra transacción.", 409)
      const lease = String(stop.drain_lease), generation = Number(stop.drain_generation), bootId = String(stop.drain_boot_id)
      if (!drain.isCommittedLease(lease, generation, bootId)) {
        check(drain.ownsLease(lease, generation, bootId), "El lease de drenaje venció o ya no pertenece a este core.", 409)
        check(drain.commit(lease, generation, bootId), "El lease cambió antes del commit.", 409)
      }
      if (stop.state === "ready") {
        await this.deps.db.transaction(async sql => {
          const changed = await sql.query(`UPDATE hub_stops SET state='applied',applied_at=now(),apply_boot_id=$2,apply_transaction_id=$3,updated_at=now()
            WHERE id=$1 AND state='ready' RETURNING id`, [stopId, this.bootId, transactionId ?? null])
          check(changed.length === 1, "La parada cambió durante el commit.", 409)
          await this.event(sql, stopId, "applied", { drain_boot_id: bootId, transaction_id: transactionId ?? null })
        })
        this.log(stopId, "applied", { drain_boot_id: bootId, transaction_id: transactionId ?? null })
        stop = await this.requireStop(stopId)
      }
      check(drain.requestCommittedStop(), "No se pudo programar el cierre del core; reintentá el mismo commit.", 503)
      clearTimeout(this.timer)
      this.timer = undefined
      return this.view(stop.id)
    })
  }

  private async requireStop(stopId: string): Promise<StopRow> {
    const stop = (await this.deps.db.query<StopRow>("SELECT * FROM hub_stops WHERE id=$1", [stopId]))[0]
    check(stop, "La parada coordinada no existe.", 404)
    return stop
  }

  private drainCommitted(stop: StopRow): boolean {
    return Boolean(stop.drain_lease && stop.drain_generation !== null && stop.drain_generation !== undefined && stop.drain_boot_id
      && this.drain?.isCommittedLease(String(stop.drain_lease), Number(stop.drain_generation), String(stop.drain_boot_id)))
  }

  private drainLeaseValid(stop: StopRow): boolean {
    return Boolean(stop.drain_lease && stop.drain_generation !== null && stop.drain_generation !== undefined && stop.drain_boot_id
      && this.drain?.ownsLease(String(stop.drain_lease), Number(stop.drain_generation), String(stop.drain_boot_id)))
  }

  private memberFingerprint(snapshot: Awaited<ReturnType<HubTeamRuntime["coordinatedSnapshot"]>> | undefined, planId: string): string {
    return JSON.stringify((snapshot?.members ?? []).filter(member => member.plan_id === planId)
      .map(member => [member.member_id, member.generation]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  }

  private authorityGeneration(row: Record<string, any>): string {
    return JSON.stringify([row.plan_id ?? row.id, row.created_by ?? row.session_id, row.leader_id ?? null, row.leader_changed_at ?? null])
  }

  private async ensureGate(stop: StopRow): Promise<boolean> {
    if (stop.gate_owner === "drain") return true
    if (this.gateToken && this.deps.admission.isClosed()) {
      const renewed = await this.deps.admission.renewConfirmed(this.gateToken)
      if (renewed) return true
      await this.deps.db.query("UPDATE hub_stops SET last_error_code='admission_publish_failed',last_error_detail='El worker no confirmó la renovación del cierre.',updated_at=now() WHERE id=$1", [stop.id])
      this.log(stop.id, "blocked", { error_code: "admission_publish_failed" })
      return false
    }
    try {
      this.gateToken = this.deps.admission.close()
      await this.deps.admission.flush()
      await this.deps.db.query("UPDATE hub_stops SET admission_closed_at=COALESCE(admission_closed_at,now()),gate_owner='coordinator',last_error_code=NULL,last_error_detail=NULL,updated_at=now() WHERE id=$1", [stop.id])
      this.log(stop.id, "admission_closed", { state: stop.state })
      return true
    } catch (error) {
      await this.deps.db.query("UPDATE hub_stops SET last_error_code='admission_close_failed',last_error_detail=$2,updated_at=now() WHERE id=$1", [stop.id, error instanceof Error ? error.message : String(error)])
      this.log(stop.id, "blocked", { error_code: "admission_close_failed" })
      return false
    }
  }

  private async reopenGate(stopId: string): Promise<boolean> {
    if (!this.gateToken) return this.deps.admission.confirmOpen()
    const token = this.gateToken
    this.gateToken = null
    const reopened = await this.deps.admission.reopenConfirmed(token)
    if (!reopened) {
      await this.deps.db.query("UPDATE hub_stops SET last_error_code='admission_reopen_unconfirmed',last_error_detail='El worker no confirmó la reapertura.',updated_at=now() WHERE id=$1", [stopId])
      this.log(stopId, "blocked", { error_code: "admission_reopen_unconfirmed" })
    }
    return reopened
  }

  private async prepare(stop: StopRow): Promise<void> {
    // Pre-runtime gateways do not block an update; their count is recorded so a client that loses the MCP after the swap can be traced.
    if (stop.reason === "update" && this.deps.legacyGateways && !stop.backup_id) {
      try {
        const legacy = await this.deps.legacyGateways()
        if (legacy.error === undefined && legacy.count > 0) this.log(stop.id, "legacy_gateways_ignored", { count: legacy.count })
      } catch { /* Diagnostic only. */ }
    }
    if (!stop.backup_id) {
      try {
        const backup = await this.deps.backup()
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stops SET backup_id=$2,last_error_code=NULL,last_error_detail=NULL,updated_at=now() WHERE id=$1", [stop.id, backup.id])
          await this.event(sql, stop.id, "backup_completed", { backup_id: backup.id })
        })
        this.log(stop.id, "backup_completed", { backup_id: backup.id })
      } catch (error) {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stops SET last_error_code='backup_failed',last_error_detail=$2,updated_at=now() WHERE id=$1", [stop.id, error instanceof Error ? error.message : String(error)])
          await this.event(sql, stop.id, "blocked", { error_code: "backup_failed" })
        })
        this.log(stop.id, "blocked", { error_code: "backup_failed" })
        return
      }
    }
    const snapshot = await this.deps.fleet?.coordinatedSnapshot()
    const livePlanIds = [...new Set((snapshot?.members ?? []).filter(member => member.live).map(member => member.plan_id))]
    await this.deps.db.transaction(async sql => {
      await sql.query("UPDATE hub_stops SET state='notifying',updated_at=now() WHERE id=$1 AND state IN ('requested','notifying')", [stop.id])
      const plans = livePlanIds.length ? await sql.query(`SELECT p.id AS plan_id,p.created_by,c.id AS channel_id,c.leader_id,c.leader_changed_at,c.closed_at AS channel_closed,
        leader.closed_at AS leader_closed,leader.removed_at AS leader_removed
        FROM chat_team_plans p JOIN chat_channels c ON c.id=p.master_channel_id JOIN chat_sessions leader ON leader.id=p.created_by
        WHERE p.id IN (${livePlanIds.map((_, index) => `$${index + 1}`).join(",")}) AND p.state IN ${ACTIVE_PLAN_SQL}`, livePlanIds) : []
      for (const plan of plans) {
        if (plan.channel_closed || plan.leader_id !== plan.created_by) {
          await sql.query("UPDATE hub_stops SET last_error_code='coordinator_authority_changed',last_error_detail='Un plan activo no conserva a su coordinador original.',updated_at=now() WHERE id=$1", [stop.id])
          await this.event(sql, stop.id, "blocked", { error_code: "coordinator_authority_changed", plan_id: plan.plan_id })
          continue
        }
        const inTurn = (snapshot?.members ?? []).some(member => member.plan_id === plan.plan_id && ["starting", "busy", "waiting_input"].includes(member.state))
        const required = !(plan.leader_closed || plan.leader_removed) || inTurn
        const target = { ...plan, id: plan.plan_id }
        const authority = this.authorityGeneration(target)
        const targetId = randomUUID()
        await sql.query(`INSERT OR IGNORE INTO hub_stop_targets(id,stop_id,plan_id,session_id,target_kind,required,authority_generation,exemption_reason)
          VALUES($1,$2,$3,$4,'coordinator',$5,$6,$7)`, [targetId, stop.id, plan.plan_id, plan.created_by, required ? 1 : 0, authority,
          required ? null : "leader_closed_or_removed"])
        if (!required) await this.event(sql, stop.id, "coordinator_exempt", { plan_id: plan.plan_id, session_id: plan.created_by, reason: "leader_closed_or_removed" })
      }
      const coordinators = await sql.query("SELECT session_id FROM hub_stop_targets WHERE stop_id=$1 AND target_kind='coordinator'", [stop.id])
      const excluded = coordinators.map(row => String(row.session_id))
      const tui = await sql.query(`SELECT s.id,s.channel_id FROM chat_sessions s WHERE s.cli_kind IN ('claude_code','codex_cli')
        AND s.closed_at IS NULL AND s.removed_at IS NULL AND s.capability<>'hub_fleet'
        AND NOT EXISTS(SELECT 1 FROM chat_team_members m WHERE m.session_id=s.id)`)
      for (const session of tui.filter(row => !excluded.includes(String(row.id)))) {
        await sql.query(`INSERT OR IGNORE INTO hub_stop_targets(id,stop_id,plan_id,session_id,target_kind,required,authority_generation)
          VALUES($1,$2,NULL,$3,'informative_tui',0,$4)`, [randomUUID(), stop.id, session.id, JSON.stringify([session.id, session.channel_id])])
      }
      const pending = Number((await sql.query("SELECT count(*) AS n FROM hub_stop_targets WHERE stop_id=$1 AND required=1 AND confirmed_at IS NULL AND invalidated_at IS NULL", [stop.id]))[0]?.n ?? 0)
      const next = pending ? "waiting_confirmations" : "waiting_members"
      const targets = await sql.query("SELECT target.*,s.channel_id FROM hub_stop_targets target JOIN chat_sessions s ON s.id=target.session_id WHERE target.stop_id=$1 AND target.notified_at IS NULL", [stop.id])
      for (const target of targets) await this.notice(sql, stop, target, "stop_requested", next)
      await sql.query("UPDATE hub_stops SET state=$2,updated_at=now() WHERE id=$1 AND state IN ('requested','notifying')", [stop.id, next])
      await this.event(sql, stop.id, "notified", { required: plans.filter(plan => !plan.leader_closed && !plan.leader_removed).length, informative: tui.length, next })
    })
    this.deps.chat.events.emit("change")
    this.log(stop.id, "notified", { plans: livePlanIds.length })
  }

  /** Finds launches admitted before the gate closed, including new members of an already confirmed plan. */
  private async discoverLateTargets(stop: StopRow, snapshot: Awaited<ReturnType<HubTeamRuntime["coordinatedSnapshot"]>> | undefined): Promise<number> {
    const livePlanIds = [...new Set((snapshot?.members ?? []).filter(member => member.live).map(member => member.plan_id))]
    if (!livePlanIds.length) return 0
    const known = new Set((await this.deps.db.query("SELECT plan_id FROM hub_stop_targets WHERE stop_id=$1 AND plan_id IS NOT NULL", [stop.id])).map(row => String(row.plan_id)))
    const missing = livePlanIds.filter(planId => !known.has(planId))
    let required = 0
    await this.deps.db.transaction(async sql => {
      const confirmed = await sql.query(`SELECT target.*,s.channel_id FROM hub_stop_targets target JOIN chat_sessions s ON s.id=target.session_id
        WHERE target.stop_id=$1 AND target.required=1 AND target.confirmed_at IS NOT NULL AND target.invalidated_at IS NULL`, [stop.id])
      for (const target of confirmed) {
        const fingerprint = this.memberFingerprint(snapshot, String(target.plan_id))
        const confirmedMembers = typeof target.confirmed_members === "string" ? target.confirmed_members : JSON.stringify(target.confirmed_members ?? null)
        if (confirmedMembers === fingerprint) continue
        await sql.query("UPDATE hub_stop_targets SET confirmed_at=NULL,confirmed_members=NULL,notified_at=now() WHERE id=$1", [target.id])
        await this.notice(sql, stop, target, "stop_requested", "waiting_confirmations", randomUUID())
        await this.event(sql, stop.id, "confirmation_invalidated", { plan_id: target.plan_id, reason: "member_set_changed" })
        required++
      }
      const plans = missing.length ? await sql.query(`SELECT p.id AS plan_id,p.created_by,c.id AS channel_id,c.leader_id,c.leader_changed_at,c.closed_at AS channel_closed,
        leader.closed_at AS leader_closed,leader.removed_at AS leader_removed
        FROM chat_team_plans p JOIN chat_channels c ON c.id=p.master_channel_id JOIN chat_sessions leader ON leader.id=p.created_by
        WHERE p.id IN (${missing.map((_, index) => `$${index + 1}`).join(",")}) AND p.state IN ${ACTIVE_PLAN_SQL}`, missing) : []
      for (const plan of plans) {
        if (plan.channel_closed || plan.leader_id !== plan.created_by) {
          await sql.query("UPDATE hub_stops SET last_error_code='coordinator_authority_changed',last_error_detail='Un plan descubierto durante el cierre no conserva a su coordinador original.',updated_at=now() WHERE id=$1", [stop.id])
          await this.event(sql, stop.id, "blocked", { error_code: "coordinator_authority_changed", plan_id: plan.plan_id })
          continue
        }
        const inTurn = (snapshot?.members ?? []).some(member => member.plan_id === plan.plan_id && ["starting", "busy", "waiting_input"].includes(member.state))
        const needsConfirmation = !(plan.leader_closed || plan.leader_removed) || inTurn
        const targetId = randomUUID(), authority = this.authorityGeneration({ ...plan, id: plan.plan_id })
        await sql.query(`INSERT OR IGNORE INTO hub_stop_targets(id,stop_id,plan_id,session_id,target_kind,required,authority_generation,exemption_reason)
          VALUES($1,$2,$3,$4,'coordinator',$5,$6,$7)`, [targetId, stop.id, plan.plan_id, plan.created_by, needsConfirmation ? 1 : 0, authority,
          needsConfirmation ? null : "leader_closed_or_removed"])
        const target = (await sql.query("SELECT target.*,s.channel_id FROM hub_stop_targets target JOIN chat_sessions s ON s.id=target.session_id WHERE target.id=$1", [targetId]))[0]
        if (target) await this.notice(sql, stop, target, "stop_requested", needsConfirmation ? "waiting_confirmations" : "waiting_members")
        if (needsConfirmation) required++
        else await this.event(sql, stop.id, "coordinator_exempt", { plan_id: plan.plan_id, session_id: plan.created_by, reason: "leader_closed_or_removed" })
      }
      if (required > 0) {
        await sql.query("UPDATE hub_stops SET state='waiting_confirmations',updated_at=now() WHERE id=$1", [stop.id])
        await this.event(sql, stop.id, "late_targets_discovered", { plans: missing, required })
      }
    })
    if (required > 0) {
      this.deps.chat.events.emit("change")
      this.log(stop.id, "late_targets_discovered", { required })
    }
    return required
  }

  private async notice(sql: TransactionSql, stop: StopRow, target: Record<string, any>, cause: "stop_requested" | "stop_grace" | "hub_resumed", payloadState = stop.state, noticeKey = String(target.id ?? "notice")): Promise<void> {
    const sender = `hub-stop:${stop.id}:${cause}:${target.channel_id}:${noticeKey}`
    await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,'agenthub-system',$1,'Agent Hub','hub',$2,'offline',now(),now())`, [sender, target.channel_id])
    const required = Boolean(target.required)
    const text = cause === "hub_resumed"
      ? `Agent Hub volvió a iniciar después de la parada ${stop.id} (${stop.reason}). Podés relanzar tus miembros; las menciones pendientes se conservan.`
      : cause === "stop_grace"
        ? `El cierre ${stop.id} entró en los 15 minutos finales de gracia. Ordená la parada de los miembros pendientes; al vencer se hará un cierre forzado ordenado.`
        : required
          ? `Agent Hub necesita ${stop.reason === "update" ? "reiniciarse para una actualización" : "cerrarse"}. Pedí a cada agente que llegue a un punto seguro, reporte y pare; podés usar memory_team_control action=interrupt o action=stop para reducir trabajo. Después confirmá con memory_hub_stop_confirm(session_key, stop_id=${stop.id}). MCP seguirá disponible hasta que todos estén parados.`
          : `Agent Hub prepara ${stop.reason === "update" ? "un reinicio por actualización" : "un cierre"}. Esta sesión TUI recibe el aviso pero no bloquea ni necesita confirmar.`
    const turn = `${cause}:${stop.id}:${target.session_id}:${noticeKey}`
    const payload = JSON.stringify({ stop_id: stop.id, reason: stop.reason, state: payloadState, deadline_at: stop.deadline_at, force_at: stop.force_at, required })
    const inserted = await sql.query(`INSERT OR IGNORE INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,team_id,recipient_id,work_thread_id,text,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [randomUUID(), sender, turn, cause, target.channel_id, target.plan_id ?? null,
      target.session_id, target.plan_id ? (await sql.query("SELECT root_thread_id FROM chat_team_plans WHERE id=$1", [target.plan_id]))[0]?.root_thread_id ?? null : null, text, payload])
    if (inserted.length && cause === "stop_requested") await sql.query("UPDATE hub_stop_targets SET notified_at=now() WHERE id=$1", [target.id])
    if (inserted.length) await this.event(sql, stop.id, cause === "hub_resumed" ? "resumed_notified" : cause === "stop_grace" ? "grace_notified" : "target_notified",
      { target_id: target.id, session_id: target.session_id, plan_id: target.plan_id ?? null, required })
  }

  private async reconcile(stop: StopRow, snapshot: Awaited<ReturnType<HubTeamRuntime["coordinatedSnapshot"]>> | undefined): Promise<void> {
    const targets = await this.deps.db.query(`SELECT target.*,p.state AS plan_state,p.created_by,c.leader_id,c.leader_changed_at,c.closed_at AS channel_closed,
      s.closed_at AS leader_closed,s.removed_at AS leader_removed FROM hub_stop_targets target
      JOIN chat_team_plans p ON p.id=target.plan_id JOIN chat_channels c ON c.id=p.master_channel_id JOIN chat_sessions s ON s.id=target.session_id
      WHERE target.stop_id=$1 AND target.target_kind='coordinator' AND target.invalidated_at IS NULL`, [stop.id])
    for (const target of targets) {
      const members = (snapshot?.members ?? []).filter(member => member.plan_id === target.plan_id)
      const inTurn = members.some(member => ["starting", "busy", "waiting_input"].includes(member.state))
      if ((target.leader_closed || target.leader_removed) && !inTurn) {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stop_targets SET required=0,invalidated_at=now(),exemption_reason='leader_closed_or_removed' WHERE id=$1", [target.id])
          await this.event(sql, stop.id, "coordinator_exempt", { plan_id: target.plan_id, session_id: target.session_id, reason: "leader_closed_or_removed" })
        })
        this.log(stop.id, "coordinator_exempt", { plan_id: target.plan_id, session_id: target.session_id })
      } else if (target.channel_closed || target.plan_state === "paused" || target.plan_state === "cancelled" || target.plan_state === "completed") {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stop_targets SET invalidated_at=now(),exemption_reason='plan_inactive' WHERE id=$1", [target.id])
          await this.event(sql, stop.id, "target_invalidated", { target_id: target.id, plan_id: target.plan_id, reason: "plan_inactive" })
        })
        this.log(stop.id, "target_invalidated", { plan_id: target.plan_id, session_id: target.session_id, reason: "plan_inactive" })
      } else if (target.created_by !== target.session_id || target.leader_id !== target.session_id || target.authority_generation !== this.authorityGeneration(target)) {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stops SET last_error_code='coordinator_authority_changed',last_error_detail='Cambió el coordinador de un plan durante la parada.',updated_at=now() WHERE id=$1", [stop.id])
          await this.event(sql, stop.id, "blocked", { error_code: "coordinator_authority_changed", plan_id: target.plan_id })
        })
        this.log(stop.id, "blocked", { error_code: "coordinator_authority_changed", plan_id: target.plan_id })
      }
    }
  }

  private async leaderTurns(stopId: string): Promise<string[]> {
    const rows = await this.deps.db.query(`SELECT DISTINCT target.session_id FROM hub_stop_targets target
      WHERE target.stop_id=$1 AND target.target_kind='coordinator' AND target.invalidated_at IS NULL AND EXISTS(
        SELECT 1 FROM chat_turn_state turn WHERE turn.session_id=target.session_id AND turn.terminal_at IS NULL
        UNION ALL SELECT 1 FROM chat_turns turn2 WHERE turn2.session_id=target.session_id AND turn2.terminal_at IS NULL
      )`, [stopId])
    return rows.map(row => String(row.session_id))
  }

  private async advance(stopId: string): Promise<void> {
    let stop = await this.requireStop(stopId)
    if (TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]) || stop.state === "applied") return
    const now = this.now(), deadline = Date.parse(stop.deadline_at), forceAt = stop.force_at ? Date.parse(stop.force_at) : Infinity
    // Manual quit is irreversible at force_at by explicit contract; it outranks backup, authority and liveness blockers.
    if (stop.reason === "quit" && now >= forceAt && stop.state !== "ready") {
      await this.forceStop(stop, await this.deps.fleet?.coordinatedSnapshot())
      return
    }
    const drainActive = stop.gate_owner === "drain" && (this.drainCommitted(stop) || this.drainLeaseValid(stop) || Boolean(this.drain?.hasPendingAttempt))
    if (stop.reason === "quit" && stop.state === "ready" && !drainActive && stop.ready_at && now >= Date.parse(stop.ready_at) + QUIT_READY_TIMEOUT_MS) {
      if (stop.gate_owner === "drain") await this.releaseDrain(stop)
      await this.terminal(await this.requireStop(stop.id), "cancelled", "quit_ready_timeout")
      return
    }
    if (stop.reason === "update" && now >= deadline && !drainActive) {
      if (stop.gate_owner === "drain") await this.releaseDrain(stop)
      await this.terminal(await this.requireStop(stop.id), "postponed", "deadline_elapsed")
      return
    }
    if (stop.gate_owner === "drain" && this.drainCommitted(stop)) {
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET last_error_code='commit_persistence_pending',last_error_detail='El drain quedó comprometido; reintentá el mismo commit para persistir applied y detener core.',updated_at=now() WHERE id=$1", [stop.id])
        await this.event(sql, stop.id, "blocked", { error_code: "commit_persistence_pending" })
      })
      this.log(stop.id, "blocked", { error_code: "commit_persistence_pending" })
      return
    }
    if (stop.gate_owner === "drain" && (stop.drain_lease ? !this.drainLeaseValid(stop) : !this.drain?.hasPendingAttempt)) {
      const code = stop.drain_lease ? "drain_lease_lost" : "drain_owner_lost"
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET last_error_code=$2,last_error_detail='El drain dejó de poseer la compuerta; usá retry para reconstruirla o cancel para salir.',updated_at=now() WHERE id=$1", [stop.id, code])
        await this.event(sql, stop.id, "blocked", { error_code: code })
      })
      this.log(stop.id, "blocked", { error_code: code })
      return
    }
    if (stop.reason === "quit" && now >= deadline && !stop.grace_started_at && stop.state !== "ready") {
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET grace_started_at=now(),updated_at=now() WHERE id=$1 AND grace_started_at IS NULL", [stop.id])
        const targets = await sql.query("SELECT target.*,s.channel_id FROM hub_stop_targets target JOIN chat_sessions s ON s.id=target.session_id WHERE target.stop_id=$1 AND target.required=1 AND target.invalidated_at IS NULL", [stop.id])
        for (const target of targets) await this.notice(sql, stop, target, "stop_grace")
        await this.event(sql, stop.id, "grace_started", { force_at: stop.force_at })
      })
      this.deps.chat.events.emit("change")
      this.log(stop.id, "grace_started", { force_at: stop.force_at })
    }
    stop = await this.requireStop(stopId)
    if (["requested", "notifying"].includes(stop.state)) {
      await this.prepare(stop)
      stop = await this.requireStop(stopId)
      if (stop.reason === "quit" && this.now() >= forceAt) return this.advance(stopId)
      if (stop.last_error_code) return
      if (this.now() >= deadline && now < deadline) return this.advance(stopId)
    }
    let snapshot = await this.deps.fleet?.coordinatedSnapshot()
    await this.reconcile(stop, snapshot)
    stop = await this.requireStop(stopId)
    if (stop.reason === "quit" && this.now() >= forceAt && stop.state !== "ready") return this.advance(stopId)
    if (stop.last_error_code === "coordinator_authority_changed") return
    const force = stop.reason === "quit" && this.now() >= forceAt
    if (force && stop.state !== "ready") {
      await this.forceStop(stop, snapshot)
      return
    }
    if (stop.gate_owner === "coordinator" && !await this.ensureGate(stop)) return
    const pending = Number((await this.deps.db.query("SELECT count(*) AS n FROM hub_stop_targets WHERE stop_id=$1 AND required=1 AND confirmed_at IS NULL AND invalidated_at IS NULL", [stop.id]))[0]?.n ?? 0)
    if (pending > 0) {
      if (stop.state !== "waiting_confirmations") {
        await this.deps.db.transaction(async sql => {
          await sql.query("UPDATE hub_stops SET state='waiting_confirmations',updated_at=now() WHERE id=$1", [stop.id])
          await this.event(sql, stop.id, "waiting_confirmations", { pending })
        })
        this.log(stop.id, "waiting_confirmations", { pending })
      }
      return
    }
    if (stop.state === "waiting_confirmations") {
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET state='waiting_members',updated_at=now() WHERE id=$1", [stop.id])
        await this.event(sql, stop.id, "waiting_members")
      })
      this.log(stop.id, "waiting_members")
    }
    stop = await this.requireStop(stopId)
    if (["waiting_members", "stopping_fleet", "ready"].includes(stop.state) && !await this.ensureGate(stop)) return
    // Recount only after the closure is durably published; no launch admitted before it may escape the snapshot.
    this.deps.fleet?.beginCoordinatedStop(stop.id)
    snapshot = await this.deps.fleet?.coordinatedSnapshot()
    if (await this.discoverLateTargets(stop, snapshot) > 0) {
      this.deps.fleet?.endCoordinatedStop(stop.id)
      return
    }
    stop = await this.requireStop(stop.id)
    if (stop.last_error_code === "coordinator_authority_changed") {
      this.deps.fleet?.endCoordinatedStop(stop.id)
      return
    }
    const leaders = await this.leaderTurns(stop.id)
    const blockers = (snapshot?.members ?? []).filter(member => ["starting", "busy", "waiting_input"].includes(member.state) || (!member.proof_complete && member.live))
    if (leaders.length || blockers.length || !snapshot?.proof_complete) {
      await this.deps.db.query("UPDATE hub_stops SET state='waiting_members',last_error_code=$2,last_error_detail=$3,updated_at=now() WHERE id=$1",
        [stop.id, snapshot?.proof_complete === false ? "fleet_ownership_unknown" : null,
          snapshot?.proof_complete === false ? "No se pudo probar la propiedad o salida de todos los procesos de la flota." : null])
      return
    }
    if (stop.state !== "ready") await this.stopFleet(stop, snapshot.members, false)
  }

  private async stopFleet(stop: StopRow, members: CoordinatedFleetMember[], force: boolean): Promise<void> {
    check(this.deps.fleet, "La flota no está disponible para completar la parada.", 503)
    const attempt = force ? Number(stop.force_attempts ?? 0) + 1 : 1
    await this.deps.db.transaction(async sql => {
      await sql.query("UPDATE hub_stops SET state='stopping_fleet',force_attempts=$2,force_next_at=NULL,updated_at=now() WHERE id=$1", [stop.id, force ? attempt : Number(stop.force_attempts ?? 0)])
      await this.event(sql, stop.id, force ? "quit_forced" : "fleet_stop_started", { members: members.length, attempt })
    })
    this.log(stop.id, force ? "quit_forced" : "fleet_stop_started", { members: members.length, attempt })
    const receipts = await this.deps.fleet.stopOrdered(stop.id, members, force)
    await this.storeReceipts(stop.id, receipts, attempt)
    const after = await this.deps.fleet.coordinatedSnapshot()
    const uncertain = receipts.some(receipt => receipt.outcome === "uncertain") || !after.proof_complete || after.fleet_live > 0
    if (uncertain && force && attempt < 4) {
      const backoff = [5_000, 15_000, 30_000][attempt - 1]!
      await this.deps.db.query(`UPDATE hub_stops SET last_error_code='fleet_stop_unconfirmed',last_error_detail='La parada forzada conserva procesos sin salida confirmada.',
        force_next_at=$2,updated_at=now() WHERE id=$1`, [stop.id, new Date(this.now() + backoff).toISOString()])
      this.log(stop.id, "force_retry_scheduled", { attempt, backoff_ms: backoff, fleet_live: after.fleet_live })
      return
    }
    if (uncertain && !force) {
      await this.deps.db.query("UPDATE hub_stops SET last_error_code='fleet_stop_unconfirmed',last_error_detail='La parada de uno o más procesos no quedó confirmada.',updated_at=now() WHERE id=$1", [stop.id])
      this.log(stop.id, "blocked", { error_code: "fleet_stop_unconfirmed", fleet_live: after.fleet_live })
      return
    }
    await this.deps.db.transaction(async sql => {
      await sql.query(`UPDATE hub_stops SET state='ready',ready_at=COALESCE(ready_at,now()),force_next_at=NULL,force_gate_failures=0,
        last_error_code=$2,last_error_detail=$3,updated_at=now() WHERE id=$1`, [stop.id,
        uncertain ? "forced_with_uncertain_members" : null, uncertain ? "El cierre continúa después de tres reintentos sin confirmar todos los procesos." : null])
      await this.event(sql, stop.id, "ready", { fleet_live: after.fleet_live, receipts: receipts.length, forced: force, uncertain, attempt })
    })
    this.log(stop.id, "ready", { fleet_live: after.fleet_live, receipts: receipts.length, forced: force, uncertain, attempt })
  }

  private async forceStop(stop: StopRow, snapshot: Awaited<ReturnType<HubTeamRuntime["coordinatedSnapshot"]>> | undefined): Promise<void> {
    if (stop.force_next_at && this.now() < Date.parse(stop.force_next_at)) return
    if (!await this.ensureGate(stop)) {
      const failures = Number(stop.force_gate_failures ?? 0) + 1
      const backoff = [5_000, 15_000, 30_000][Math.min(failures - 1, 2)]!
      await this.deps.db.transaction(async sql => {
        await sql.query("UPDATE hub_stops SET force_gate_failures=$2,force_next_at=$3,updated_at=now() WHERE id=$1",
          [stop.id, failures, new Date(this.now() + backoff).toISOString()])
        await this.event(sql, stop.id, "force_gate_retry_scheduled", { failures, backoff_ms: backoff, error_code: stop.last_error_code ?? "admission_close_failed" })
      })
      this.log(stop.id, "force_gate_retry_scheduled", { failures, backoff_ms: backoff })
      return
    }
    const leaders = (await this.deps.db.query("SELECT session_id FROM hub_stop_targets WHERE stop_id=$1 AND required=1 AND confirmed_at IS NULL AND invalidated_at IS NULL", [stop.id])).map(row => String(row.session_id))
    const members = (snapshot?.members ?? []).filter(member => member.live || !member.proof_complete)
    await this.deps.db.transaction(async sql => {
      await this.event(sql, stop.id, "quit_forced_pending", { leaders, members: members.map(member => ({ id: member.member_id, state: member.state, generation: member.generation, pid: member.pid ?? null })) })
    })
    for (const sessionId of leaders) this.log(stop.id, "quit_forced_pending_leader", { session_id: sessionId })
    for (const member of members) this.log(stop.id, "quit_forced_pending_member", { member_id: member.member_id, state: member.state, generation: member.generation, pid: member.pid ?? null })
    await this.stopFleet(stop, snapshot?.members ?? [], true)
  }

  private async storeReceipts(stopId: string, receipts: CoordinatedFleetReceipt[], attempt: number): Promise<void> {
    await this.deps.db.transaction(async sql => {
      for (const receipt of receipts) {
        await sql.query(`INSERT INTO hub_stop_member_receipts(stop_id,member_id,generation,attempt,before_state,outcome,detail)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(stop_id,member_id,generation,attempt) DO UPDATE SET outcome=excluded.outcome,observed_at=now(),detail=excluded.detail`,
        [stopId, receipt.member_id, receipt.generation, attempt, receipt.before_state, receipt.outcome, JSON.stringify(receipt.detail ?? {})])
        await this.event(sql, stopId, "member_stop_receipt", { member_id: receipt.member_id, generation: receipt.generation, attempt, outcome: receipt.outcome })
      }
    })
    for (const receipt of receipts) this.log(stopId, "member_stop_receipt", { member_id: receipt.member_id, generation: receipt.generation, attempt, outcome: receipt.outcome })
  }

  private async releaseDrain(stop: StopRow): Promise<void> {
    let reopened = false
    if (!this.drain) {
      reopened = !this.deps.admission.isClosed()
    } else if (stop.drain_lease && stop.drain_generation !== null && stop.drain_generation !== undefined) {
      const result = await this.drain.cancel(String(stop.drain_lease), Number(stop.drain_generation))
      reopened = result.reopened || (!this.drain.ownsLease(String(stop.drain_lease), Number(stop.drain_generation), String(stop.drain_boot_id ?? "")) && !this.deps.admission.isClosed())
    } else if (this.drain.hasPendingAttempt) {
      reopened = (await this.drain.cancelPending()).reopened
    } else {
      reopened = !this.deps.admission.isClosed()
    }
    check(reopened, "No se pudo confirmar la reapertura del drenaje; el bloqueo se conserva.", 409)
    this.drain = null
    await this.deps.db.query("UPDATE hub_stops SET gate_owner=NULL,drain_lease=NULL,drain_generation=NULL,drain_boot_id=NULL,updated_at=now() WHERE id=$1", [stop.id])
    this.log(stop.id, "drain_cancelled", { reopened: true })
  }

  private async terminal(stop: StopRow, state: "postponed" | "cancelled", reason: string): Promise<void> {
    if (stop.gate_owner === "drain") {
      this.arm(stop)
      throw new MemoryError(409, "El drenaje ya tomó la compuerta; esperá su resolución.")
    }
    const reopened = await this.reopenGate(stop.id)
    if (!reopened) {
      await this.deps.db.transaction(sql => this.event(sql, stop.id, "blocked", { error_code: "admission_reopen_unconfirmed", requested_terminal: state }))
      this.arm(await this.requireStop(stop.id))
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.deps.fleet?.endCoordinatedStop(stop.id)
    await this.deps.db.transaction(async sql => {
      await sql.query("UPDATE hub_stops SET state=$2,terminal_reason=$3,gate_owner=NULL,retry_not_before=$4,updated_at=now() WHERE id=$1",
        [stop.id, state, reason, state === "postponed" ? new Date(this.now() + UPDATE_DEADLINE_MS).toISOString() : null])
      await sql.query("UPDATE chat_status_notices SET cancelled_at=COALESCE(cancelled_at,now()),error=$2 WHERE turn_id LIKE $1 AND handled_at IS NULL", [`%:${stop.id}:%`, `Parada ${state}`])
      await this.event(sql, stop.id, state, { reason, reopened })
    })
    this.deps.chat.events.emit("change")
    this.log(stop.id, state, { reason, reopened })
  }

  private async resume(stop: StopRow): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.deps.db.transaction(async sql => {
      const targets = await sql.query("SELECT target.*,s.channel_id FROM hub_stop_targets target JOIN chat_sessions s ON s.id=target.session_id WHERE target.stop_id=$1 AND target.target_kind='coordinator'", [stop.id])
      for (const target of targets) await this.notice(sql, stop, target, "hub_resumed")
      await sql.query("UPDATE hub_stops SET state='resumed',resumed_at=now(),gate_owner=NULL,updated_at=now() WHERE id=$1 AND state='applied'", [stop.id])
      await this.event(sql, stop.id, "resumed", { previous_boot_id: stop.apply_boot_id, startup_transaction: this.deps.startupTransaction ?? null })
      await sql.query("DELETE FROM settings WHERE key='update_admission'")
    })
    this.deps.fleet?.endCoordinatedStop(stop.id)
    this.deps.chat.events.emit("change")
    this.log(stop.id, "resumed", { previous_boot_id: stop.apply_boot_id ?? null, startup_transaction: this.deps.startupTransaction ?? null })
  }

  private async view(stopId: string): Promise<HubStopView> {
    const stop = await this.requireStop(stopId)
    const targets = await this.deps.db.query("SELECT session_id,required,confirmed_at,invalidated_at FROM hub_stop_targets WHERE stop_id=$1", [stopId])
    const snapshot = await this.deps.fleet?.coordinatedSnapshot()
    const leaders = await this.leaderTurns(stopId)
    const receipts = await this.deps.db.query("SELECT member_id,generation,attempt,outcome,observed_at FROM hub_stop_member_receipts WHERE stop_id=$1 ORDER BY attempt,observed_at,member_id", [stopId])
    return {
      stop_id: stop.id, source_id: String(stop.source_id), reason: stop.reason, state: stop.state, target_version: stop.target_version ?? null,
      transaction_id: stop.apply_transaction_id ?? null,
      requested_at: String(stop.requested_at), deadline_at: String(stop.deadline_at), force_at: stop.force_at ? String(stop.force_at) : null,
      grace_started_at: stop.grace_started_at ? String(stop.grace_started_at) : null, backup_id: stop.backup_id ?? null,
      retry_not_before: stop.retry_not_before ? String(stop.retry_not_before) : null,
      ready: stop.state === "ready", forced: stop.reason === "quit" && Boolean(stop.force_at) && this.now() >= Date.parse(stop.force_at),
      waiting_for: {
        coordinators: targets.filter(row => Boolean(row.required) && !row.confirmed_at && !row.invalidated_at).map(row => String(row.session_id)),
        leaders_in_turn: leaders,
        members: (snapshot?.members ?? []).filter(member => member.live || !member.proof_complete).map(member => ({ member_id: member.member_id, state: member.state, proof_complete: member.proof_complete })),
      },
      receipts: receipts.map(row => ({ member_id: String(row.member_id), generation: String(row.generation), attempt: Number(row.attempt), outcome: String(row.outcome), observed_at: String(row.observed_at) })),
      error: stop.last_error_code ? { code: String(stop.last_error_code), detail: stop.last_error_detail ? String(stop.last_error_detail) : null,
        actions: stop.state === "applied" || TERMINAL_STATES.includes(stop.state as typeof TERMINAL_STATES[number]) ? []
          : stop.last_error_code === "commit_persistence_pending" ? ["commit"] : ["retry", "cancel"] } : null,
      drain: { owner: stop.gate_owner ?? null, boot_id: stop.drain_boot_id ?? null, generation: stop.drain_generation === null || stop.drain_generation === undefined ? null : Number(stop.drain_generation), lease: stop.drain_lease ?? null },
    }
  }
}
