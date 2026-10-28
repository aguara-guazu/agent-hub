import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { codeHmac, deriveCode, formatCode, sameHmac } from './codes.js'
import { MAX_FOLLOW_UP_CHARS } from './verifier.js'
import {
  DecisionError, canonicalJson, sha256,
  type ApprovedItem, type ConsumeResult, type FollowUp, type OutboxState, type DecisionItemKind, type DecisionRequestInput, type Exclusion, type ExclusionSink, type Integration,
  type IntentState, type ItemState, type ParsedReply, type PublicDecisionRequest, type PublicItemState, type PublicStateSink, type RequestState,
} from './contract.js'

export const MAX_FAILED_ATTEMPTS = 5
export const ACCOUNT_FAILURE_LIMIT = 10
export const ACCOUNT_FAILURE_WINDOW_MS = 10 * 60_000
const SCHEMA_VERSION = 2

const SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decision_requests (
  request_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  canonical_digest TEXT NOT NULL,
  project_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','locked','expired','revoked','superseded','closed')),
  code_salt INTEGER NOT NULL DEFAULT 0,
  code_hmac TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_requests_live_code ON decision_requests(owner_id, code_hmac) WHERE state IN ('open','locked');
CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES decision_requests(request_id),
  owner_id TEXT NOT NULL,
  integration TEXT NOT NULL CHECK(integration IN ('gmail','slack')),
  account TEXT NOT NULL,
  conversation TEXT,
  team TEXT,
  remote_user TEXT,
  provenance TEXT NOT NULL DEFAULT '',
  delivery_ref TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','active','quarantined','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decision_items (
  request_id TEXT NOT NULL REFERENCES decision_requests(request_id),
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  exact_effect TEXT NOT NULL,
  effect_digest TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','revoked','superseded','blocked_uncertain')),
  PRIMARY KEY(request_id, item_id),
  UNIQUE(request_id, ordinal)
);
CREATE TABLE IF NOT EXISTS outbox (
  delivery_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES decision_requests(request_id),
  binding_id TEXT NOT NULL REFERENCES channel_bindings(id),
  integration TEXT NOT NULL,
  account TEXT NOT NULL,
  correlation TEXT NOT NULL,
  native_id TEXT,
  native_thread TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','sending','sent','uncertain','failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(integration, account, correlation)
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_target ON outbox(request_id, integration, account) WHERE state <> 'failed';
CREATE INDEX IF NOT EXISTS outbox_native ON outbox(integration, account, native_id);
CREATE TABLE IF NOT EXISTS inbound (
  integration TEXT NOT NULL, account TEXT NOT NULL, native_message_id TEXT NOT NULL,
  request_id TEXT, outcome TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY(integration, account, native_message_id)
);
CREATE TABLE IF NOT EXISTS follow_ups (
  request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, project_id TEXT NOT NULL, text TEXT NOT NULL,
  integration TEXT NOT NULL, account TEXT NOT NULL, native_message_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(request_id, ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_project ON follow_ups(request_id, project_id);
CREATE TABLE IF NOT EXISTS reply_failures (integration TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reply_failures_account ON reply_failures(integration, account, at);
CREATE TABLE IF NOT EXISTS grants (
  request_id TEXT NOT NULL, item_id TEXT NOT NULL,
  integration TEXT NOT NULL, account TEXT NOT NULL, native_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(request_id, item_id)
);
CREATE TABLE IF NOT EXISTS action_intents (
  intent_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL, item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  effect TEXT NOT NULL,
  effect_digest TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('pending','prepared','dispatching','succeeded','rejected_before_dispatch','uncertain')),
  remote_ref TEXT, result_digest TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(request_id, item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_live_effect ON action_intents(effect_digest) WHERE state IN ('dispatching','uncertain','succeeded');
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_live_operation ON action_intents(operation_key) WHERE state IN ('dispatching','uncertain','succeeded');
`

interface RequestRow {
  request_id: string; owner_id: string; run_id: string; artifact_id: string; revision: number; canonical_digest: string; project_ids: string
  expires_at: string; state: RequestState; code_salt: number; code_hmac: string; failed_attempts: number
}
interface ItemRow { request_id: string; item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; summary: string; exact_effect: string; effect_digest: string; operation_key: string; state: ItemState }
type BindingState = 'reserved' | 'active' | 'quarantined' | 'closed'
interface BindingRow { id: string; request_id: string; owner_id: string; integration: Integration; account: string; conversation: string | null; team: string | null; remote_user: string | null; provenance: string; delivery_ref: string | null; state: BindingState }
interface OutboxRow { delivery_id: string; request_id: string; binding_id: string; integration: Integration; account: string; correlation: string; native_id: string | null; native_thread: string | null; state: OutboxState }
export interface IntentRow { intent_id: string; request_id: string; item_id: string; kind: DecisionItemKind; effect: string; effect_digest: string; operation_key: string; generation: number; state: IntentState; remote_ref: string | null; result_digest: string | null; error_code: string | null }

export interface DecisionStoreOptions {
  /** Secreto del verificador (Vault). Deriva los códigos y firma su HMAC; nunca se persiste en este archivo. */
  key: Buffer | Uint8Array
  /** Registro de exclusiones no secretas. Obligatorio: sin él no se reserva ni se activa ninguna entrega. */
  exclusions: ExclusionSink
  now?: () => Date
  publicState?: PublicStateSink
  /** Valida el efecto canónico de un ítem (esquema, tipo, fechas, alcance) antes de persistirlo o corregirlo. Debe lanzar si es inválido. */
  validateEffect?: (kind: DecisionItemKind, effect: unknown) => void
}

export interface ReserveDeliveryInput {
  request_id: string
  integration: Integration
  account: string
  /** Gmail: Message-ID RFC que genera el Hub. Slack: marca de entrega propia. */
  correlation: string
  conversation?: string
  team?: string
  remote_user?: string
  provenance: string
}
export interface Reservation { delivery_id: string; binding_id: string; correlation: string; state: 'reserved' | 'sending' }

export type NativeReceipt = { native_id: string; thread_id?: string; delivery_ref?: string }

const PUBLIC_STATE: Record<ItemState, PublicItemState> = {
  pending: 'proposed', approved: 'approved', rejected: 'rejected', expired: 'expired', revoked: 'expired', superseded: 'superseded', blocked_uncertain: 'uncertain',
}
const LIVE_INTENT = '(\'pending\',\'prepared\',\'dispatching\',\'uncertain\',\'succeeded\')'

/**
 * Almacén privado de decisiones: solicitudes, ítems, bindings de canal, outbox, respuestas consumidas e intenciones.
 *
 * Vive en su propio archivo SQLite, fuera del respaldo, de FTS y de embeddings. Ningún otro módulo lee estas tablas:
 * lo que sale de aquí hacia la memoria o la app es el estado público por ítem y los identificadores opacos.
 * Todo cambio de estado es una transición cerrada (compare-and-set sobre el estado esperado) dentro de BEGIN IMMEDIATE;
 * los efectos sobre sistemas externos nunca ocurren dentro de una transacción de este archivo.
 */
export class DecisionStore {
  private readonly db: DatabaseSync
  private readonly now: () => Date
  private readonly key: Buffer
  private readonly exclusions: ExclusionSink
  private readonly publicState: PublicStateSink | undefined
  private readonly validateEffect: ((kind: DecisionItemKind, effect: unknown) => void) | undefined
  private readonly dirty = new Set<string>()

  constructor(path: string, options: DecisionStoreOptions) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.key = Buffer.from(options.key)
    if (this.key.length < 32) throw new DecisionError('weak_key', 'La clave del verificador debe tener al menos 32 bytes')
    if (!options.exclusions) throw new DecisionError('exclusions_required', 'El registro de exclusiones es obligatorio')
    this.now = options.now ?? (() => new Date())
    this.exclusions = options.exclusions
    this.publicState = options.publicState
    this.validateEffect = options.validateEffect
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    this.db.exec(SCHEMA)
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }

  close(): void { this.db.close() }

  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* la conexión ya abortó la transacción */ } throw error }
  }
  private get<T>(sql: string, ...params: unknown[]): T | undefined { return this.db.prepare(sql).get(...params as never[]) as T | undefined }
  private all<T>(sql: string, ...params: unknown[]): T[] { return this.db.prepare(sql).all(...params as never[]) as T[] }
  private run(sql: string, ...params: unknown[]): number { return Number(this.db.prepare(sql).run(...params as never[]).changes) }
  private iso(): string { return this.now().toISOString() }

  // ---------------------------------------------------------------- solicitudes

  /**
   * Crea la solicitud de decisión de un run. Idempotente por (run_id, revisión 1): un reintento tras caída devuelve
   * la misma solicitud. Con ítems distintos, una solicitud que aún no salió del almacén se reemplaza; una ya entregada, respondida o con intenciones es un conflicto, nunca una regeneración.
   * `operation_key` es la identidad semántica de la operación (por ejemplo, issue + inicio de un worklog); por defecto es el digest del efecto.
   */
  prepareDecision(input: DecisionRequestInput): { request_id: string; revision: number; created: boolean } {
    const items = input.items.map((item, index) => this.buildItem(item.kind, item.exact_effect, index + 1, item.project_id, item.summary, item.operation_key))
    const digest = this.requestDigest(input.owner_id, input.run_id, input.artifact_id, 1, input.expires_at, items)
    return this.tx(() => {
      const existing = this.get<RequestRow>('SELECT * FROM decision_requests WHERE run_id = ? AND revision = 1', input.run_id)
      if (existing) {
        if (existing.canonical_digest === digest) return { request_id: existing.request_id, revision: 1, created: false }
        // Una solicitud que nunca salió del almacén (sin entrega, respuesta ni intención) se reemplaza: el run se recomputó tras una caída previa a su artefacto.
        const touched = ['outbox', 'channel_bindings', 'action_intents'].some(table => this.get(`SELECT 1 FROM ${table} WHERE request_id = ?`, existing.request_id))
          || this.get('SELECT 1 FROM inbound WHERE request_id = ?', existing.request_id)
        if (touched || existing.state !== 'open') throw new DecisionError('request_conflict', 'La solicitud de este run ya existe con otro contenido')
        this.run('DELETE FROM decision_items WHERE request_id = ?', existing.request_id)
        this.run('DELETE FROM decision_requests WHERE request_id = ?', existing.request_id)
      }
      const request_id = randomUUID()
      this.insertRequest({ request_id, owner_id: input.owner_id, run_id: input.run_id, artifact_id: input.artifact_id, revision: 1,
        canonical_digest: digest, project_ids: input.project_ids, expires_at: input.expires_at, items })
      return { request_id, revision: 1, created: true }
    })
  }

  private buildItem(kind: DecisionItemKind, effect: unknown, ordinal: number, projectId: string, summary: string, operationKey?: string) {
    this.validateEffect?.(kind, effect)
    const exact = canonicalJson(effect), digest = sha256(exact)
    return { item_id: randomUUID(), ordinal, kind, project_id: projectId, summary, exact, digest, operation_key: operationKey ?? digest }
  }

  private requestDigest(owner: string, run: string, artifact: string, revision: number, expiresAt: string, items: Array<{ ordinal: number; kind: string; project_id: string; digest: string; operation_key: string }>): string {
    return sha256(canonicalJson({ v: 2, owner, run, artifact, revision, expires_at: expiresAt,
      items: items.map(item => ({ ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, effect_digest: item.digest, operation_key: item.operation_key })) }))
  }

  private insertRequest(row: { request_id: string; owner_id: string; run_id: string; artifact_id: string; revision: number; canonical_digest: string; project_ids: string[]; expires_at: string;
    items: Array<{ item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; summary: string; exact: string; digest: string; operation_key: string }> }): void {
    const at = this.iso()
    for (let salt = 0; ; salt++) {
      const hmac = codeHmac(this.key, row.owner_id, deriveCode(this.key, row.owner_id, row.request_id, row.revision, salt))
      if (this.get('SELECT 1 FROM decision_requests WHERE owner_id = ? AND code_hmac = ? AND state IN (\'open\',\'locked\')', row.owner_id, hmac)) continue
      this.run(`INSERT INTO decision_requests(request_id, owner_id, run_id, artifact_id, revision, canonical_digest, project_ids, expires_at, state, code_salt, code_hmac, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`, row.request_id, row.owner_id, row.run_id, row.artifact_id, row.revision, row.canonical_digest,
        JSON.stringify(row.project_ids), row.expires_at, salt, hmac, at, at)
      break
    }
    for (const item of row.items) {
      this.run(`INSERT INTO decision_items(request_id, item_id, ordinal, kind, project_id, summary, exact_effect, effect_digest, operation_key, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        row.request_id, item.item_id, item.ordinal, item.kind, item.project_id, item.summary, item.exact, item.digest, item.operation_key)
      this.dirty.add(`${row.request_id}\u0000${item.item_id}`)
    }
  }

  private request(requestId: string): RequestRow {
    const row = this.get<RequestRow>('SELECT * FROM decision_requests WHERE request_id = ?', requestId)
    if (!row) throw new DecisionError('request_not_found')
    return row
  }

  /** Código de la solicitud, solo para el transporte y la ruta autenticada de la app. Se re-deriva; no se guarda en claro. */
  codeFor(requestId: string): string {
    const row = this.request(requestId)
    return formatCode(deriveCode(this.key, row.owner_id, row.request_id, row.revision, row.code_salt))
  }

  publicRequest(requestId: string): PublicDecisionRequest {
    const row = this.request(requestId)
    const items = this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? ORDER BY ordinal', requestId)
    return { request_id: row.request_id, run_id: row.run_id, revision: row.revision, state: row.state, expires_at: row.expires_at, canonical_digest: row.canonical_digest,
      items: items.map(item => ({ ordinal: item.ordinal, kind: item.kind, summary: item.summary, state: item.state, effect_digest: item.effect_digest })) }
  }

  /** `authority_unavailable` cuando la referencia no existe en este archivo (por ejemplo, tras restaurar un respaldo sin decisions.sqlite). Prueba existencia, no autorización vigente. */
  authorityOf(requestId: string): 'verified' | 'authority_unavailable' {
    return this.get('SELECT 1 FROM decision_requests WHERE request_id = ?', requestId) ? 'verified' : 'authority_unavailable'
  }

  /** Ítems aprobados de una solicitud con el estado de su intención. Sin código ni efecto. */
  getApprovedItems(requestId: string): ApprovedItem[] {
    return this.all<ApprovedItem>(
      `SELECT i.item_id, i.ordinal, i.kind, i.project_id, i.effect_digest, a.state FROM decision_items i JOIN action_intents a ON a.request_id = i.request_id AND a.item_id = i.item_id
       WHERE i.request_id = ? ORDER BY i.ordinal`, requestId)
  }

  /**
   * Instrucciones de seguimiento escritas por la persona en la misma respuesta que aprobó el ítem. El proyecto sale del ítem aprobado,
   * una por proyecto. Es texto libre de la persona: no se ejecuta como comando ni se registra en logs.
   */
  getFollowUps(requestId: string): FollowUp[] {
    return this.all<FollowUp>('SELECT project_id, ordinal, text FROM follow_ups WHERE request_id = ? ORDER BY ordinal', requestId)
  }

  /** Solicitudes de un run, la más reciente primero. */
  requestsOfRun(runId: string): PublicDecisionRequest[] {
    return this.all<RequestRow>('SELECT * FROM decision_requests WHERE run_id = ? ORDER BY revision DESC', runId).map(row => this.publicRequest(row.request_id))
  }

  /**
   * Nueva revisión por corrección de un ítem. Solo se corrigen ítems `pending`, nunca despachados: lo aprobado, despachado, incierto o
   * ya exitoso conserva su identidad y no se reemplaza. La anterior queda `superseded` y sin efecto; la nueva copia los ítems pendientes,
   * conserva su `operation_key` y exige aprobar de nuevo.
   */
  reviseRequest(requestId: string, ordinal: number, effect: unknown, expiresAt?: string): { request_id: string; revision: number } {
    return this.tx(() => {
      const old = this.request(requestId)
      if (old.state !== 'open') throw new DecisionError('request_not_open')
      const items = this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? ORDER BY ordinal', requestId)
      const target = items.find(item => item.ordinal === ordinal)
      if (!target || target.state !== 'pending') throw new DecisionError('item_not_revisable')
      if (this.get(`SELECT 1 FROM action_intents WHERE request_id = ? AND item_id = ?`, requestId, target.item_id)) throw new DecisionError('item_not_revisable')
      const next = items.filter(item => item.state === 'pending').map(item => {
        if (item.ordinal !== ordinal) return { item_id: randomUUID(), ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, summary: item.summary, exact: item.exact_effect, digest: item.effect_digest, operation_key: item.operation_key }
        const built = this.buildItem(item.kind, effect, item.ordinal, item.project_id, item.summary, item.operation_key)
        return { ...built }
      })
      const revision = old.revision + 1, request_id = randomUUID(), at = this.iso(), expires = expiresAt ?? old.expires_at
      this.run('UPDATE decision_requests SET state = \'superseded\', updated_at = ? WHERE request_id = ? AND state = \'open\'', at, requestId)
      for (const item of items) if (item.state === 'pending') this.setItemState(item, 'superseded')
      this.insertRequest({ request_id, owner_id: old.owner_id, run_id: old.run_id, artifact_id: old.artifact_id, revision,
        canonical_digest: this.requestDigest(old.owner_id, old.run_id, old.artifact_id, revision, expires, next), project_ids: JSON.parse(old.project_ids) as string[], expires_at: expires, items: next })
      return { request_id, revision }
    })
  }

  /** Revoca la solicitud y toda intención que aún no despachó. Lo despachado, incierto o exitoso se conserva. */
  revokeRequest(requestId: string): void {
    this.tx(() => this.revoke(this.request(requestId)))
  }

  private revoke(row: RequestRow): void {
    if (row.state === 'expired' || row.state === 'revoked' || row.state === 'superseded') return
    this.run('UPDATE decision_requests SET state = \'revoked\', updated_at = ? WHERE request_id = ?', this.iso(), row.request_id)
    for (const item of this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND state = \'pending\'', row.request_id)) this.setItemState(item, 'revoked')
    this.rejectIntents('request_id = ?', [row.request_id], 'revoked')
  }

  /** Revoca toda solicitud con algo por aprobar o por despachar (interruptor de automatizaciones). */
  revokeAll(): number {
    return this.tx(() => {
      const rows = this.all<RequestRow>(`SELECT r.* FROM decision_requests r WHERE r.state IN ('open','locked')
        OR (r.state = 'closed' AND EXISTS (SELECT 1 FROM action_intents a WHERE a.request_id = r.request_id AND a.state IN ('pending','prepared')))`)
      for (const row of rows) this.revoke(row)
      return rows.length
    })
  }

  /** Vence solicitudes y rechaza intenciones aprobadas que no despacharon antes del plazo. */
  expireDue(): number {
    return this.tx(() => {
      const at = this.iso()
      const rows = this.all<RequestRow>('SELECT * FROM decision_requests WHERE state IN (\'open\',\'locked\') AND expires_at <= ?', at)
      for (const row of rows) this.closeRequest(row, 'expired', 'expired')
      this.rejectIntents('request_id IN (SELECT request_id FROM decision_requests WHERE expires_at <= ?)', [at], 'expired')
      return rows.length
    })
  }

  private closeRequest(row: RequestRow, state: RequestState, itemState: ItemState): void {
    this.run('UPDATE decision_requests SET state = ?, updated_at = ? WHERE request_id = ?', state, this.iso(), row.request_id)
    for (const item of this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND state = \'pending\'', row.request_id)) this.setItemState(item, itemState)
  }

  private rejectIntents(where: string, params: unknown[], code: string): void {
    const rows = this.all<IntentRow>(`SELECT * FROM action_intents WHERE state IN ('pending','prepared') AND ${where}`, ...params)
    for (const row of rows) {
      this.run('UPDATE action_intents SET state = \'rejected_before_dispatch\', error_code = ?, updated_at = ? WHERE intent_id = ? AND state IN (\'pending\',\'prepared\')', code, this.iso(), row.intent_id)
      this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
    }
  }

  private setItemState(item: ItemRow, state: ItemState): void {
    this.run('UPDATE decision_items SET state = ? WHERE request_id = ? AND item_id = ?', state, item.request_id, item.item_id)
    this.dirty.add(`${item.request_id}\u0000${item.item_id}`)
  }

  // ---------------------------------------------------------------- outbox y bindings

  /**
   * Reserva la entrega por (solicitud, integración, cuenta): persiste la correlación propia y el binding ANTES de enviar y registra la
   * exclusión no secreta. Idempotente y a prueba de concurrencia: la comprobación se repite dentro de la transacción y un índice único
   * impide dos entregas vivas al mismo destino. Una entrega `sent` o `uncertain` no se reserva de nuevo.
   * Destinos distintos (Gmail y Slack) tienen outbox y binding independientes sobre la misma solicitud.
   */
  async reserveDelivery(input: ReserveDeliveryInput): Promise<Reservation> {
    if (this.request(input.request_id).state !== 'open') throw new DecisionError('request_not_open')
    const entries: Exclusion[] = input.integration === 'gmail'
      ? [{ integration: 'gmail', account: input.account, kind: 'rfc_message_id', native_id: input.correlation }]
      : input.conversation ? [{ integration: 'slack', account: input.account, kind: 'conversation', native_id: input.conversation }] : []
    if (entries.length) await this.exclusions.add(entries)
    return this.tx(() => {
      const request = this.request(input.request_id)
      if (request.state !== 'open') throw new DecisionError('request_not_open')
      const prior = this.get<OutboxRow>('SELECT * FROM outbox WHERE request_id = ? AND integration = ? AND account = ? AND state <> \'failed\'', input.request_id, input.integration, input.account)
      if (prior) {
        if (prior.state === 'reserved' || prior.state === 'sending') return { delivery_id: prior.delivery_id, binding_id: prior.binding_id, correlation: prior.correlation, state: prior.state }
        throw new DecisionError('delivery_already_dispatched')
      }
      const delivery_id = randomUUID(), binding_id = randomUUID(), at = this.iso()
      this.run(`INSERT INTO channel_bindings(id, request_id, owner_id, integration, account, conversation, team, remote_user, provenance, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`, binding_id, input.request_id, request.owner_id, input.integration, input.account, input.conversation ?? null,
        input.team ?? null, input.remote_user ?? null, input.provenance, at, at)
      this.run(`INSERT INTO outbox(delivery_id, request_id, binding_id, integration, account, correlation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        delivery_id, input.request_id, binding_id, input.integration, input.account, input.correlation, at, at)
      return { delivery_id, binding_id, correlation: input.correlation, state: 'reserved' as const }
    })
  }

  private outbox(deliveryId: string): OutboxRow {
    const row = this.get<OutboxRow>('SELECT * FROM outbox WHERE delivery_id = ?', deliveryId)
    if (!row) throw new DecisionError('delivery_not_found')
    return row
  }

  /**
   * Persiste `sending` ANTES de invocar la red. Devuelve false si otro actor ya reclamó el envío: quien recibe false no debe enviar.
   * Tras una caída, un `sending` sin recibo pasa a `uncertain` (recover) y nunca se reintenta solo.
   */
  beginSend(deliveryId: string): boolean {
    return this.tx(() => {
      const row = this.outbox(deliveryId)
      if (this.request(row.request_id).state !== 'open') return false
      return this.run('UPDATE outbox SET state = \'sending\', updated_at = ? WHERE delivery_id = ? AND state = \'reserved\'', this.iso(), deliveryId) === 1
    })
  }

  /** Registra el recibo nativo DESPUÉS del envío y activa el binding. Solo desde `sending`; los IDs nunca provienen de argumentos del agente. */
  async recordNative(deliveryId: string, native: NativeReceipt): Promise<void> {
    await this.finishSent(deliveryId, native, ['sending'])
  }

  private async finishSent(deliveryId: string, native: NativeReceipt, from: OutboxState[]): Promise<void> {
    const row = this.outbox(deliveryId)
    const entries: Exclusion[] = [{ integration: row.integration, account: row.account, kind: 'message', native_id: native.native_id }]
    if (native.thread_id) entries.push({ integration: row.integration, account: row.account, kind: 'thread', native_id: native.thread_id })
    await this.exclusions.add(entries)
    this.tx(() => {
      const at = this.iso()
      const marks = from.map(() => '?').join(',')
      if (this.run(`UPDATE outbox SET state = 'sent', native_id = ?, native_thread = ?, updated_at = ? WHERE delivery_id = ? AND state IN (${marks})`, native.native_id, native.thread_id ?? null, at, deliveryId, ...from) !== 1) {
        throw new DecisionError('bad_transition', 'La entrega no está en un estado que admita este recibo')
      }
      this.run('UPDATE channel_bindings SET state = \'active\', conversation = COALESCE(?, conversation), delivery_ref = ?, updated_at = ? WHERE id = ?',
        native.thread_id ?? null, native.delivery_ref ?? native.native_id, at, row.binding_id)
    })
  }

  /** Sin recibo tras un timeout o error ambiguo: el binding queda en cuarentena hasta reconciliar. Solo desde `sending`. */
  markDeliveryUncertain(deliveryId: string): void {
    this.tx(() => {
      const row = this.outbox(deliveryId)
      if (this.run('UPDATE outbox SET state = \'uncertain\', updated_at = ? WHERE delivery_id = ? AND state = \'sending\'', this.iso(), deliveryId) !== 1) throw new DecisionError('bad_transition')
      this.run('UPDATE channel_bindings SET state = \'quarantined\', updated_at = ? WHERE id = ?', this.iso(), row.binding_id)
    })
  }

  /** Falla comprobada, con prueba de que el proveedor no aceptó nada (no se envió): cierra el binding y permite una reserva nueva. Un `uncertain` jamás pasa a `failed` por esta vía. */
  markDeliveryFailed(deliveryId: string): void {
    this.tx(() => {
      const row = this.outbox(deliveryId)
      if (this.run('UPDATE outbox SET state = \'failed\', updated_at = ? WHERE delivery_id = ? AND state IN (\'reserved\',\'sending\')', this.iso(), deliveryId) !== 1) throw new DecisionError('bad_transition')
      this.run('UPDATE channel_bindings SET state = \'closed\', updated_at = ? WHERE id = ?', this.iso(), row.binding_id)
    })
  }

  /**
   * Salida de `uncertain` con evidencia explícita de un adaptador confiable: el mensaje existe (recibo nativo) o hay prueba CONCLUYENTE de que no se envió.
   * Una búsqueda sin resultados, un 404 o la ausencia de un marcador no es esa prueba: en esos casos la entrega sigue `uncertain`.
   */
  async reconcileDelivery(deliveryId: string, evidence: { found: true; native: NativeReceipt } | { found: false }): Promise<void> {
    if (evidence.found) { await this.finishSent(deliveryId, evidence.native, ['uncertain']); return }
    this.tx(() => {
      const row = this.outbox(deliveryId)
      if (this.run('UPDATE outbox SET state = \'failed\', updated_at = ? WHERE delivery_id = ? AND state = \'uncertain\'', this.iso(), deliveryId) !== 1) throw new DecisionError('bad_transition')
      this.run('UPDATE channel_bindings SET state = \'closed\', updated_at = ? WHERE id = ?', this.iso(), row.binding_id)
    })
  }

  /** Bindings de una solicitud, uno por destino. */
  bindingsOf(requestId: string): Array<{ id: string; integration: Integration; account: string; conversation: string | null; team: string | null; remote_user: string | null; delivery_ref: string | null; state: BindingState; delivery_state: OutboxState; correlations: string[]; native_ids: string[] }> {
    return this.all<BindingRow>('SELECT * FROM channel_bindings WHERE request_id = ? ORDER BY created_at', requestId).map(binding => {
      const sent = this.all<OutboxRow>('SELECT * FROM outbox WHERE binding_id = ?', binding.id)
      return { id: binding.id, integration: binding.integration, account: binding.account, conversation: binding.conversation, team: binding.team, remote_user: binding.remote_user,
        delivery_ref: binding.delivery_ref, state: binding.state, delivery_state: sent.at(-1)?.state ?? 'reserved', correlations: sent.map(row => row.correlation),
        native_ids: sent.flatMap(row => row.native_id ? [row.native_id] : []) }
    })
  }

  /** Solicitud a la que responde un binding. */
  requestOfBinding(bindingId: string): string | undefined {
    return this.get<{ request_id: string }>('SELECT request_id FROM channel_bindings WHERE id = ?', bindingId)?.request_id
  }

  /** Run al que pertenece una solicitud. */
  runOfRequest(requestId: string): string | undefined {
    return this.get<{ run_id: string }>('SELECT run_id FROM decision_requests WHERE request_id = ?', requestId)?.run_id
  }

  /** Solicitud de una intención. */
  requestOfIntent(intentId: string): string | undefined {
    return this.intent(intentId)?.request_id
  }

  /** Bindings activos con una solicitud abierta (para que el sondeo de respuestas sepa qué hilos mirar). */
  openBindings(integration: Integration): Array<{ binding_id: string; request_id: string; account: string }> {
    return this.all<{ binding_id: string; request_id: string; account: string }>(
      `SELECT b.id AS binding_id, r.request_id AS request_id, b.account AS account FROM channel_bindings b JOIN decision_requests r ON r.request_id = b.request_id
       WHERE r.state = 'open' AND b.state = 'active' AND b.integration = ?`, integration)
  }

  /** Consulta local para el gate de ingesta: el mensaje, hilo, Message-ID o conversación pertenecen al control del Hub. */
  isExcluded(entry: Exclusion): boolean {
    if (entry.kind === 'rfc_message_id') return !!this.get('SELECT 1 FROM outbox WHERE integration = ? AND account = ? AND correlation = ?', entry.integration, entry.account, entry.native_id)
    if (entry.kind === 'message') return !!this.get('SELECT 1 FROM outbox WHERE integration = ? AND account = ? AND native_id = ?', entry.integration, entry.account, entry.native_id)
      || !!this.get('SELECT 1 FROM inbound WHERE integration = ? AND account = ? AND native_message_id = ?', entry.integration, entry.account, entry.native_id)
    if (entry.kind === 'thread') return !!this.get('SELECT 1 FROM outbox WHERE integration = ? AND account = ? AND native_thread = ?', entry.integration, entry.account, entry.native_id)
    return !!this.get('SELECT 1 FROM channel_bindings WHERE integration = ? AND account = ? AND conversation = ?', entry.integration, entry.account, entry.native_id)
  }

  // ---------------------------------------------------------------- consumo de respuestas

  /**
   * Consume una respuesta ya verificada contra su binding (identidad, hilo, remitente). Todo ocurre en una transacción:
   * se registra el mensaje entrante (UNIQUE), se valida código, vencimiento y selección, y se crean los grants y las intenciones.
   * La solicitud sale del binding: una respuesta a un mensaje de una revisión anterior no aprueba la vigente.
   * Dos aprobaciones concurrentes del mismo mensaje no crean dos intenciones; un duplicado devuelve el resultado previo.
   */
  consumeReply(input: { integration: Integration; account: string; native_message_id: string; binding_id: string; parsed: ParsedReply }): ConsumeResult {
    return this.tx((): ConsumeResult => {
      const seen = this.get<{ request_id: string | null; outcome: string }>('SELECT request_id, outcome FROM inbound WHERE integration = ? AND account = ? AND native_message_id = ?',
        input.integration, input.account, input.native_message_id)
      if (seen) return { outcome: 'duplicate', ...(seen.request_id ? { request_id: seen.request_id } : {}) }
      const done = (outcome: ConsumeResult['outcome'], extra: Partial<ConsumeResult> = {}, requestId?: string): ConsumeResult => {
        this.run('INSERT INTO inbound(integration, account, native_message_id, request_id, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?)',
          input.integration, input.account, input.native_message_id, requestId ?? null, outcome, this.iso())
        return { outcome, ...(requestId ? { request_id: requestId } : {}), ...extra }
      }
      const binding = this.get<BindingRow>('SELECT * FROM channel_bindings WHERE id = ?', input.binding_id)
      if (!binding || binding.state !== 'active' || binding.integration !== input.integration || binding.account !== input.account) return done('binding_unavailable')
      const request = this.request(binding.request_id)
      if (request.state === 'expired') return done('expired', {}, request.request_id)
      if (request.state === 'revoked' || request.state === 'superseded') return done('revoked', {}, request.request_id)
      if (request.state === 'closed') return done('no_open_request', {}, request.request_id)
      if (request.state === 'locked') return done('locked', {}, request.request_id)
      if (request.expires_at <= this.iso()) { this.closeRequest(request, 'expired', 'expired'); return done('expired', {}, request.request_id) }
      const parsed = input.parsed
      if (parsed.kind === 'unrecognized') return done('unrecognized', {}, request.request_id)
      const since = this.now().getTime() - ACCOUNT_FAILURE_WINDOW_MS
      const failures = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM reply_failures WHERE integration = ? AND account = ? AND at > ?', input.integration, input.account, since)?.n ?? 0
      if (failures >= ACCOUNT_FAILURE_LIMIT) return done('rate_limited', {}, request.request_id)
      if (parsed.code !== null) {
        if (!sameHmac(request.code_hmac, codeHmac(this.key, request.owner_id, parsed.code))) {
          const attempts = request.failed_attempts + 1
          this.run('INSERT INTO reply_failures(integration, account, at) VALUES (?, ?, ?)', input.integration, input.account, this.now().getTime())
          this.run('UPDATE decision_requests SET failed_attempts = ?, state = ?, updated_at = ? WHERE request_id = ?', attempts, attempts >= MAX_FAILED_ATTEMPTS ? 'locked' : 'open', this.iso(), request.request_id)
          return done(attempts >= MAX_FAILED_ATTEMPTS ? 'locked' : 'invalid_code', {}, request.request_id)
        }
      }
      const items = this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? ORDER BY ordinal', request.request_id)
      const selection = (wanted: number[] | 'all'): ItemRow[] | null => {
        const pending = items.filter(item => item.state === 'pending')
        if (wanted === 'all') return pending
        const chosen = wanted.map(ordinal => items.find(item => item.ordinal === ordinal))
        return chosen.every(item => item?.state === 'pending') ? chosen as ItemRow[] : null
      }
      if (parsed.kind === 'revise') {
        const target = items.find(item => item.ordinal === parsed.ordinal)
        if (!target || target.state !== 'pending') return done('bad_selection', {}, request.request_id)
        return done('revision_requested', { revision: { ordinal: parsed.ordinal, value: parsed.value } }, request.request_id)
      }
      const chosen = selection(parsed.items)
      if (!chosen || chosen.length === 0) return done('bad_selection', {}, request.request_id)
      let outcome: ConsumeResult
      if (parsed.kind === 'reject') {
        for (const item of chosen) this.setItemState(item, 'rejected')
        outcome = { outcome: 'rejected', request_id: request.request_id, rejected: chosen.map(item => item.ordinal) }
      } else {
        const approved: NonNullable<ConsumeResult['approved']> = [], blocked: number[] = []
        for (const item of chosen) {
          if (this.get(`SELECT 1 FROM action_intents WHERE (effect_digest = ? OR operation_key = ?) AND state IN ${LIVE_INTENT}`, item.effect_digest, item.operation_key)) {
            this.setItemState(item, 'blocked_uncertain'); blocked.push(item.ordinal); continue
          }
          const intent_id = randomUUID(), at = this.iso()
          this.setItemState(item, 'approved')
          this.run('INSERT INTO grants(request_id, item_id, integration, account, native_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            item.request_id, item.item_id, input.integration, input.account, input.native_message_id, at)
          this.run(`INSERT INTO action_intents(intent_id, request_id, item_id, kind, effect, effect_digest, operation_key, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
            intent_id, item.request_id, item.item_id, item.kind, item.exact_effect, item.effect_digest, item.operation_key, at, at)
          approved.push({ item_id: item.item_id, ordinal: item.ordinal, intent_id })
        }
        let recorded = 0
        for (const follow of parsed.follow_ups ?? []) {
          const item = chosen.find(candidate => candidate.ordinal === follow.ordinal)
          if (!item || !approved.some(entry => entry.item_id === item.item_id) || follow.text.length > MAX_FOLLOW_UP_CHARS) continue
          if (this.run('INSERT OR IGNORE INTO follow_ups(request_id, ordinal, project_id, text, integration, account, native_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            item.request_id, item.ordinal, item.project_id, follow.text, input.integration, input.account, input.native_message_id, this.iso()) === 1) recorded++
        }
        outcome = { outcome: 'approved', request_id: request.request_id, approved, ...(blocked.length ? { blocked_uncertain: blocked } : {}), ...(recorded ? { follow_ups_recorded: recorded } : {}) }
      }
      if (!this.get('SELECT 1 FROM decision_items WHERE request_id = ? AND state = \'pending\'', request.request_id)) {
        this.run('UPDATE decision_requests SET state = \'closed\', updated_at = ? WHERE request_id = ? AND state = \'open\'', this.iso(), request.request_id)
      }
      this.run('INSERT INTO inbound(integration, account, native_message_id, request_id, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        input.integration, input.account, input.native_message_id, request.request_id, outcome.outcome, this.iso())
      return outcome
    })
  }

  // ---------------------------------------------------------------- intenciones

  intent(intentId: string): IntentRow | undefined { return this.get<IntentRow>('SELECT * FROM action_intents WHERE intent_id = ?', intentId) }

  pendingIntents(): IntentRow[] { return this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'pending\' ORDER BY created_at') }

  /** Por qué una intención ya no puede avanzar hacia el dispatch, o null si la solicitud, el ítem y el plazo siguen vigentes. */
  private gate(intent: IntentRow): 'revoked' | 'expired' | 'item_not_approved' | null {
    const request = this.request(intent.request_id)
    if (request.state === 'revoked' || request.state === 'superseded') return 'revoked'
    if (request.state === 'expired' || request.expires_at <= this.iso()) return 'expired'
    const item = this.get<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND item_id = ?', intent.request_id, intent.item_id)
    return item?.state === 'approved' ? null : 'item_not_approved'
  }

  private reject(intent: IntentRow, code: string): void {
    this.run('UPDATE action_intents SET state = \'rejected_before_dispatch\', error_code = ?, updated_at = ? WHERE intent_id = ? AND state IN (\'pending\',\'prepared\')', code, this.iso(), intent.intent_id)
    this.dirty.add(`${intent.request_id}\u0000${intent.item_id}`)
  }

  /**
   * Autoriza y reclama una intención con fencing: solo quien presenta la generación vigente avanza, y la generación sube en cada reclamo.
   * Rechaza si la solicitud se revocó o venció, o si el ítem ya no está aprobado.
   */
  claimIntent(intentId: string, expectedGeneration: number): { intent: IntentRow; generation: number } | { rejected: string } {
    return this.tx(() => {
      const row = this.intent(intentId)
      if (!row) return { rejected: 'intent_not_found' }
      if (row.generation !== expectedGeneration) return { rejected: 'stale_generation' }
      if (row.state !== 'pending' && row.state !== 'prepared') return { rejected: `state_${row.state}` }
      const why = this.gate(row)
      if (why) { this.reject(row, why); return { rejected: why } }
      const generation = row.generation + 1
      this.run('UPDATE action_intents SET state = \'prepared\', generation = ?, updated_at = ? WHERE intent_id = ?', generation, this.iso(), intentId)
      return { intent: { ...row, state: 'prepared' as const, generation }, generation }
    })
  }

  /**
   * Compuerta atómica del dispatch: en la misma transacción revalida solicitud, ítem, plazo y generación, y persiste `dispatching`
   * ANTES de invocar la red o el proceso. Si otro intento ya despachó el mismo efecto u operación, el índice único lo impide.
   */
  markDispatching(intentId: string, generation: number): 'ok' | 'stale' | 'duplicate_effect' | 'revoked' | 'expired' {
    return this.tx(() => {
      const row = this.intent(intentId)
      if (!row || row.generation !== generation || row.state !== 'prepared') return 'stale'
      const why = this.gate(row)
      if (why) { this.reject(row, why); return why === 'expired' ? 'expired' : 'revoked' }
      try {
        if (this.run('UPDATE action_intents SET state = \'dispatching\', updated_at = ? WHERE intent_id = ? AND generation = ? AND state = \'prepared\'', this.iso(), intentId, generation) !== 1) return 'stale'
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) return 'duplicate_effect'
        throw error
      }
      this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
      return 'ok'
    })
  }

  /** Un fallo antes del dispatch devuelve la intención a su estado y permite que otro reclamo la retome. */
  releaseIntent(intentId: string, generation: number, errorCode: string, state: 'pending' | 'rejected_before_dispatch'): void {
    this.run('UPDATE action_intents SET state = ?, error_code = ?, updated_at = ? WHERE intent_id = ? AND generation = ? AND state = \'prepared\'', state, errorCode, this.iso(), intentId, generation)
    const row = this.intent(intentId)
    if (row) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
  }

  completeIntent(intentId: string, generation: number, receipt: { state: 'succeeded' | 'rejected_before_dispatch' | 'uncertain'; remote_ref?: string; result_digest?: string; error_code?: string }): boolean {
    const changes = this.run(`UPDATE action_intents SET state = ?, remote_ref = ?, result_digest = ?, error_code = ?, updated_at = ? WHERE intent_id = ? AND generation = ? AND state = 'dispatching'`,
      receipt.state, receipt.remote_ref ?? null, receipt.result_digest ?? null, receipt.error_code ?? null, this.iso(), intentId, generation)
    const row = this.intent(intentId)
    if (row) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
    return changes === 1
  }

  /**
   * Arranque tras caída: una intención `dispatching` pasa a `uncertain` (no se sabe si el efecto ocurrió), `prepared` vuelve a `pending`
   * (no hubo dispatch) y una entrega `sending` sin recibo pasa a `uncertain` con su binding en cuarentena. Lo incierto no se reintenta solo.
   */
  recover(): { uncertain: number; reopened: number; deliveries: number } {
    return this.tx(() => {
      const at = this.iso()
      const dispatching = this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'dispatching\'')
      const prepared = this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'prepared\'')
      this.run('UPDATE action_intents SET state = \'uncertain\', error_code = \'interrupted\', updated_at = ? WHERE state = \'dispatching\'', at)
      this.run('UPDATE action_intents SET state = \'pending\', updated_at = ? WHERE state = \'prepared\'', at)
      for (const row of [...dispatching, ...prepared]) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
      const sending = this.all<OutboxRow>('SELECT * FROM outbox WHERE state = \'sending\'')
      for (const row of sending) {
        this.run('UPDATE outbox SET state = \'uncertain\', updated_at = ? WHERE delivery_id = ? AND state = \'sending\'', at, row.delivery_id)
        this.run('UPDATE channel_bindings SET state = \'quarantined\', updated_at = ? WHERE id = ?', at, row.binding_id)
      }
      return { uncertain: dispatching.length, reopened: prepared.length, deliveries: sending.length }
    })
  }

  // ---------------------------------------------------------------- espejo público

  /** Marca todos los ítems para reenviar su estado público (tras reinicio, si el espejo quedó atrás). */
  resyncMirror(): void {
    for (const row of this.all<{ request_id: string; item_id: string }>('SELECT request_id, item_id FROM decision_items')) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
  }

  /** Publica el estado por ítem sin códigos ni autoridad. Lo que falla queda pendiente para el siguiente intento. */
  async flushMirror(): Promise<void> {
    if (!this.publicState) { this.dirty.clear(); return }
    for (const key of [...this.dirty]) {
      const [requestId, itemId] = key.split('\u0000') as [string, string]
      const item = this.get<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND item_id = ?', requestId, itemId)
      const request = this.get<RequestRow>('SELECT * FROM decision_requests WHERE request_id = ?', requestId)
      if (!item || !request) { this.dirty.delete(key); continue }
      const intent = this.get<IntentRow>('SELECT * FROM action_intents WHERE request_id = ? AND item_id = ?', requestId, itemId)
      let state = PUBLIC_STATE[item.state]
      if (intent) state = intent.state === 'dispatching' ? 'dispatching' : intent.state === 'succeeded' ? 'succeeded' : intent.state === 'uncertain' ? 'uncertain'
        : intent.state === 'rejected_before_dispatch' ? 'rejected' : 'approved'
      try {
        await this.publicState.set({ run_id: request.run_id, ordinal: item.ordinal, kind: item.kind, effect_digest: item.effect_digest, state })
        this.dirty.delete(key)
      } catch { /* queda marcado; el próximo flush lo reintenta */ }
    }
  }
}
