import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { codeHmac, deriveCode, formatCode, sameHmac } from './codes.js'
import {
  DecisionError, canonicalJson, sha256,
  type ApprovedItem, type ConsumeResult, type DecisionItemKind, type DecisionRequestInput, type Exclusion, type ExclusionSink, type Integration,
  type IntentState, type ItemState, type ParsedReply, type PublicDecisionRequest, type PublicItemState, type PublicStateSink, type RequestState,
} from './contract.js'

export const MAX_FAILED_ATTEMPTS = 5
export const ACCOUNT_FAILURE_LIMIT = 10
export const ACCOUNT_FAILURE_WINDOW_MS = 10 * 60_000
const SCHEMA_VERSION = 1

const SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS decision_requests (
  request_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  canonical_digest TEXT NOT NULL,
  project_ids TEXT NOT NULL,
  binding_id TEXT REFERENCES channel_bindings(id),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','locked','expired','revoked','superseded','closed')),
  code_salt INTEGER NOT NULL DEFAULT 0,
  code_hmac TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(run_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_requests_live_code ON decision_requests(owner_id, code_hmac) WHERE state IN ('open','locked');
CREATE TABLE IF NOT EXISTS decision_items (
  request_id TEXT NOT NULL REFERENCES decision_requests(request_id),
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  exact_effect TEXT NOT NULL,
  effect_digest TEXT NOT NULL,
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
  state TEXT NOT NULL CHECK(state IN ('reserved','sent','uncertain','failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(integration, account, correlation)
);
CREATE INDEX IF NOT EXISTS outbox_native ON outbox(integration, account, native_id);
CREATE TABLE IF NOT EXISTS inbound (
  integration TEXT NOT NULL, account TEXT NOT NULL, native_message_id TEXT NOT NULL,
  request_id TEXT, outcome TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY(integration, account, native_message_id)
);
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
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('pending','prepared','dispatching','succeeded','rejected_before_dispatch','uncertain')),
  remote_ref TEXT, result_digest TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(request_id, item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_live_effect ON action_intents(effect_digest) WHERE state IN ('dispatching','uncertain','succeeded');
`

interface RequestRow {
  request_id: string; owner_id: string; run_id: string; artifact_id: string; revision: number; canonical_digest: string; project_ids: string
  binding_id: string | null; expires_at: string; state: RequestState; code_salt: number; code_hmac: string; failed_attempts: number
}
interface ItemRow { request_id: string; item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; summary: string; exact_effect: string; effect_digest: string; state: ItemState }
interface BindingRow { id: string; owner_id: string; integration: Integration; account: string; conversation: string | null; team: string | null; remote_user: string | null; provenance: string; delivery_ref: string | null; state: 'reserved' | 'active' | 'quarantined' | 'closed' }
interface OutboxRow { delivery_id: string; request_id: string; binding_id: string; integration: Integration; account: string; correlation: string; native_id: string | null; native_thread: string | null; state: 'reserved' | 'sent' | 'uncertain' | 'failed' }
export interface IntentRow { intent_id: string; request_id: string; item_id: string; kind: DecisionItemKind; effect: string; effect_digest: string; generation: number; state: IntentState; remote_ref: string | null; result_digest: string | null; error_code: string | null }

export interface DecisionStoreOptions {
  /** Secreto del verificador (Vault). Deriva los códigos y firma su HMAC; nunca se persiste en este archivo. */
  key: Buffer | Uint8Array
  now?: () => Date
  exclusions?: ExclusionSink
  publicState?: PublicStateSink
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

const PUBLIC_STATE: Record<ItemState, PublicItemState> = {
  pending: 'proposed', approved: 'approved', rejected: 'rejected', expired: 'expired', revoked: 'expired', superseded: 'superseded', blocked_uncertain: 'uncertain',
}

/**
 * Almacén privado de decisiones: solicitudes, ítems, bindings de canal, outbox, respuestas consumidas e intenciones.
 *
 * Vive en su propio archivo SQLite, fuera del respaldo, de FTS y de embeddings. Ningún otro módulo lee estas tablas:
 * lo que sale de aquí hacia la memoria o la app es el estado público por ítem y los identificadores opacos.
 * Los métodos que mutan estado usan BEGIN IMMEDIATE y devuelven recién tras el commit; los efectos sobre sistemas
 * externos nunca ocurren dentro de una transacción de este archivo.
 */
export class DecisionStore {
  private readonly db: DatabaseSync
  private readonly now: () => Date
  private readonly key: Buffer
  private readonly exclusions: ExclusionSink | undefined
  private readonly publicState: PublicStateSink | undefined
  private readonly dirty = new Set<string>()

  constructor(path: string, options: DecisionStoreOptions) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.key = Buffer.from(options.key)
    if (this.key.length < 32) throw new DecisionError('weak_key', 'La clave del verificador debe tener al menos 32 bytes')
    this.now = options.now ?? (() => new Date())
    this.exclusions = options.exclusions
    this.publicState = options.publicState
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
  private run(sql: string, ...params: unknown[]): { changes: number | bigint } { return this.db.prepare(sql).run(...params as never[]) }
  private iso(): string { return this.now().toISOString() }

  // ---------------------------------------------------------------- solicitudes

  /**
   * Crea la solicitud de decisión de un run. Idempotente por (run_id, revisión 1): un reintento tras caída devuelve
   * la misma solicitud. Una segunda llamada con ítems distintos es un conflicto, nunca una regeneración.
   */
  prepareDecision(input: DecisionRequestInput): { request_id: string; revision: number; created: boolean } {
    const items = input.items.map((item, index) => {
      const exact = canonicalJson(item.exact_effect)
      return { ...item, ordinal: index + 1, item_id: randomUUID(), exact, digest: sha256(exact) }
    })
    const digest = sha256(canonicalJson({ v: 1, owner: input.owner_id, run: input.run_id, artifact: input.artifact_id, expires_at: input.expires_at,
      items: items.map(item => ({ ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, effect_digest: item.digest })) }))
    return this.tx(() => {
      const existing = this.get<RequestRow>('SELECT * FROM decision_requests WHERE run_id = ? AND revision = 1', input.run_id)
      if (existing) {
        if (existing.canonical_digest !== digest) throw new DecisionError('request_conflict', 'La solicitud de este run ya existe con otro contenido')
        return { request_id: existing.request_id, revision: 1, created: false }
      }
      const request_id = randomUUID()
      this.insertRequest({ request_id, owner_id: input.owner_id, run_id: input.run_id, artifact_id: input.artifact_id, revision: 1,
        canonical_digest: digest, project_ids: input.project_ids, expires_at: input.expires_at, items })
      return { request_id, revision: 1, created: true }
    })
  }

  private insertRequest(row: { request_id: string; owner_id: string; run_id: string; artifact_id: string; revision: number; canonical_digest: string; project_ids: string[]; expires_at: string;
    items: Array<{ item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; summary: string; exact: string; digest: string }> }): void {
    const at = this.iso()
    let salt = 0
    for (;; salt++) {
      const hmac = codeHmac(this.key, row.owner_id, deriveCode(this.key, row.owner_id, row.request_id, row.revision, salt))
      if (this.get('SELECT 1 FROM decision_requests WHERE owner_id = ? AND code_hmac = ? AND state IN (\'open\',\'locked\')', row.owner_id, hmac)) continue
      this.run(`INSERT INTO decision_requests(request_id, owner_id, run_id, artifact_id, revision, canonical_digest, project_ids, expires_at, state, code_salt, code_hmac, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`, row.request_id, row.owner_id, row.run_id, row.artifact_id, row.revision, row.canonical_digest,
        JSON.stringify(row.project_ids), row.expires_at, salt, hmac, at, at)
      break
    }
    for (const item of row.items) {
      this.run(`INSERT INTO decision_items(request_id, item_id, ordinal, kind, project_id, summary, exact_effect, effect_digest, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        row.request_id, item.item_id, item.ordinal, item.kind, item.project_id, item.summary, item.exact, item.digest)
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

  /** `authority_unavailable` cuando la referencia no existe en este archivo (por ejemplo, tras restaurar un respaldo sin decisions.sqlite): sin autoridad para redespachar ni reproponer. */
  authorityOf(requestId: string): 'verified' | 'authority_unavailable' {
    return this.get('SELECT 1 FROM decision_requests WHERE request_id = ?', requestId) ? 'verified' : 'authority_unavailable'
  }

  /** Ítems aprobados de una solicitud con el estado de su intención. Sin código ni efecto. */
  getApprovedItems(requestId: string): ApprovedItem[] {
    return this.all<{ item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; effect_digest: string; state: IntentState }>(
      `SELECT i.item_id, i.ordinal, i.kind, i.project_id, i.effect_digest, a.state FROM decision_items i JOIN action_intents a ON a.request_id = i.request_id AND a.item_id = i.item_id
       WHERE i.request_id = ? ORDER BY i.ordinal`, requestId)
  }

  /** Solicitudes de un run, la más reciente primero. */
  requestsOfRun(runId: string): PublicDecisionRequest[] {
    return this.all<RequestRow>('SELECT * FROM decision_requests WHERE run_id = ? ORDER BY revision DESC', runId).map(row => this.publicRequest(row.request_id))
  }

  /**
   * Nueva revisión por corrección de un ítem. La anterior queda `superseded` y no ejecutable; todos los ítems de la nueva
   * vuelven a `pending` y exigen aprobar de nuevo. Un ítem incierto no se copia: conserva su identidad en la solicitud anterior.
   */
  reviseRequest(requestId: string, ordinal: number, effect: unknown, expiresAt?: string): { request_id: string; revision: number } {
    return this.tx(() => {
      const old = this.request(requestId)
      if (old.state !== 'open') throw new DecisionError('request_not_open')
      const items = this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? ORDER BY ordinal', requestId)
      if (!items.some(item => item.ordinal === ordinal)) throw new DecisionError('bad_selection')
      const next = items.filter(item => item.state === 'pending' || item.ordinal === ordinal).map(item => {
        const exact = item.ordinal === ordinal ? canonicalJson(effect) : item.exact_effect
        return { item_id: randomUUID(), ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, summary: item.summary, exact, digest: sha256(exact) }
      })
      const revision = old.revision + 1, request_id = randomUUID(), at = this.iso()
      this.run('UPDATE decision_requests SET state = \'superseded\', updated_at = ? WHERE request_id = ?', at, requestId)
      for (const item of items) if (item.state === 'pending') this.setItemState(item, 'superseded')
      const digest = sha256(canonicalJson({ v: 1, owner: old.owner_id, run: old.run_id, artifact: old.artifact_id, revision, expires_at: expiresAt ?? old.expires_at,
        items: next.map(item => ({ ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, effect_digest: item.digest })) }))
      this.insertRequest({ request_id, owner_id: old.owner_id, run_id: old.run_id, artifact_id: old.artifact_id, revision, canonical_digest: digest,
        project_ids: JSON.parse(old.project_ids) as string[], expires_at: expiresAt ?? old.expires_at, items: next })
      return { request_id, revision }
    })
  }

  revokeRequest(requestId: string): void {
    this.tx(() => {
      const row = this.request(requestId)
      if (row.state === 'open' || row.state === 'locked') this.closeRequest(row, 'revoked', 'revoked')
    })
  }

  /** Revoca toda solicitud viva y las intenciones que aún no despacharon (interruptor de automatizaciones). Lo despachado o incierto se conserva. */
  revokeAll(): number {
    return this.tx(() => {
      const rows = this.all<RequestRow>('SELECT * FROM decision_requests WHERE state IN (\'open\',\'locked\')')
      for (const row of rows) this.closeRequest(row, 'revoked', 'revoked')
      const at = this.iso()
      const pending = this.all<{ intent_id: string; request_id: string; item_id: string }>('SELECT intent_id, request_id, item_id FROM action_intents WHERE state IN (\'pending\',\'prepared\')')
      for (const intent of pending) {
        this.run('UPDATE action_intents SET state = \'rejected_before_dispatch\', error_code = \'revoked\', updated_at = ? WHERE intent_id = ?', at, intent.intent_id)
        this.dirty.add(`${intent.request_id}\u0000${intent.item_id}`)
      }
      return rows.length + pending.length
    })
  }

  /** Vence solicitudes cuyo plazo pasó. */
  expireDue(): number {
    return this.tx(() => {
      const rows = this.all<RequestRow>('SELECT * FROM decision_requests WHERE state IN (\'open\',\'locked\') AND expires_at <= ?', this.iso())
      for (const row of rows) this.closeRequest(row, 'expired', 'expired')
      return rows.length
    })
  }

  private closeRequest(row: RequestRow, state: RequestState, itemState: ItemState): void {
    this.run('UPDATE decision_requests SET state = ?, updated_at = ? WHERE request_id = ?', state, this.iso(), row.request_id)
    for (const item of this.all<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND state = \'pending\'', row.request_id)) this.setItemState(item, itemState)
  }

  private setItemState(item: ItemRow, state: ItemState): void {
    this.run('UPDATE decision_items SET state = ? WHERE request_id = ? AND item_id = ?', state, item.request_id, item.item_id)
    this.dirty.add(`${item.request_id}\u0000${item.item_id}`)
  }

  // ---------------------------------------------------------------- outbox y bindings

  /**
   * Reserva la entrega: persiste la correlación propia y el binding ANTES de enviar y registra la exclusión no secreta.
   * Idempotente mientras no se haya despachado; una entrega `sent` o `uncertain` no se vuelve a reservar.
   */
  async reserveDelivery(input: ReserveDeliveryInput): Promise<{ delivery_id: string; binding_id: string; correlation: string }> {
    const request = this.request(input.request_id)
    if (request.state !== 'open') throw new DecisionError('request_not_open')
    const prior = this.get<OutboxRow>('SELECT * FROM outbox WHERE request_id = ? ORDER BY created_at DESC LIMIT 1', input.request_id)
    if (prior && prior.state !== 'reserved' && prior.state !== 'failed') throw new DecisionError('delivery_already_dispatched')
    if (prior?.state === 'reserved') return { delivery_id: prior.delivery_id, binding_id: prior.binding_id, correlation: prior.correlation }
    const entries: Exclusion[] = input.integration === 'gmail'
      ? [{ integration: 'gmail', account: input.account, kind: 'rfc_message_id', native_id: input.correlation }]
      : input.conversation ? [{ integration: 'slack', account: input.account, kind: 'conversation', native_id: input.conversation }] : []
    if (entries.length) await this.exclusions?.add(entries)
    return this.tx(() => {
      const delivery_id = randomUUID(), binding_id = randomUUID(), at = this.iso()
      this.run(`INSERT INTO channel_bindings(id, owner_id, integration, account, conversation, team, remote_user, provenance, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`, binding_id, request.owner_id, input.integration, input.account, input.conversation ?? null,
        input.team ?? null, input.remote_user ?? null, input.provenance, at, at)
      this.run(`INSERT INTO outbox(delivery_id, request_id, binding_id, integration, account, correlation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        delivery_id, input.request_id, binding_id, input.integration, input.account, input.correlation, at, at)
      this.run('UPDATE decision_requests SET binding_id = ?, updated_at = ? WHERE request_id = ?', binding_id, at, input.request_id)
      return { delivery_id, binding_id, correlation: input.correlation }
    })
  }

  /** Registra el recibo nativo DESPUÉS del envío y activa el binding. Los IDs nunca provienen de argumentos del agente. */
  async recordNative(deliveryId: string, native: { native_id: string; thread_id?: string; delivery_ref?: string }): Promise<void> {
    const row = this.get<OutboxRow>('SELECT * FROM outbox WHERE delivery_id = ?', deliveryId)
    if (!row) throw new DecisionError('delivery_not_found')
    const entries: Exclusion[] = [{ integration: row.integration, account: row.account, kind: 'message', native_id: native.native_id }]
    if (native.thread_id) entries.push({ integration: row.integration, account: row.account, kind: 'thread', native_id: native.thread_id })
    await this.exclusions?.add(entries)
    this.tx(() => {
      const at = this.iso()
      this.run('UPDATE outbox SET state = \'sent\', native_id = ?, native_thread = ?, updated_at = ? WHERE delivery_id = ?', native.native_id, native.thread_id ?? null, at, deliveryId)
      this.run('UPDATE channel_bindings SET state = \'active\', conversation = COALESCE(?, conversation), delivery_ref = ?, updated_at = ? WHERE id = ?',
        native.thread_id ?? null, native.delivery_ref ?? native.native_id, at, row.binding_id)
    })
  }

  /** Sin recibo tras un timeout o caída: el binding queda en cuarentena hasta reconciliar y no hay reenvío automático. */
  markDeliveryUncertain(deliveryId: string): void {
    this.tx(() => {
      const row = this.get<OutboxRow>('SELECT * FROM outbox WHERE delivery_id = ?', deliveryId)
      if (!row || row.state === 'sent') return
      const at = this.iso()
      this.run('UPDATE outbox SET state = \'uncertain\', updated_at = ? WHERE delivery_id = ?', at, deliveryId)
      this.run('UPDATE channel_bindings SET state = \'quarantined\', updated_at = ? WHERE id = ?', at, row.binding_id)
    })
  }

  /** Falla comprobada antes de enviar (no salió nada): se cierra el binding y se permite una reserva nueva. */
  markDeliveryFailed(deliveryId: string): void {
    this.tx(() => {
      const row = this.get<OutboxRow>('SELECT * FROM outbox WHERE delivery_id = ?', deliveryId)
      if (!row || row.state === 'sent') return
      const at = this.iso()
      this.run('UPDATE outbox SET state = \'failed\', updated_at = ? WHERE delivery_id = ?', at, deliveryId)
      this.run('UPDATE channel_bindings SET state = \'closed\', updated_at = ? WHERE id = ?', at, row.binding_id)
    })
  }

  bindingOf(requestId: string): { id: string; integration: Integration; account: string; conversation: string | null; team: string | null; remote_user: string | null; delivery_ref: string | null; state: BindingRow['state']; correlations: string[] } | undefined {
    const request = this.request(requestId)
    if (!request.binding_id) return undefined
    const binding = this.get<BindingRow>('SELECT * FROM channel_bindings WHERE id = ?', request.binding_id)
    if (!binding) return undefined
    const correlations = this.all<{ correlation: string }>('SELECT correlation FROM outbox WHERE binding_id = ?', binding.id).map(row => row.correlation)
    return { id: binding.id, integration: binding.integration, account: binding.account, conversation: binding.conversation, team: binding.team, remote_user: binding.remote_user,
      delivery_ref: binding.delivery_ref, state: binding.state, correlations }
  }

  /** Binding activo de una cuenta con una solicitud abierta (para que el sondeo de respuestas sepa qué hilos mirar). */
  openBindings(integration: Integration): Array<{ binding_id: string; request_id: string; account: string }> {
    return this.all<{ binding_id: string; request_id: string; account: string }>(
      `SELECT b.id AS binding_id, r.request_id AS request_id, b.account AS account FROM decision_requests r JOIN channel_bindings b ON b.id = r.binding_id
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
   * Dos aprobaciones concurrentes del mismo mensaje no crean dos intenciones; un duplicado devuelve el resultado previo.
   */
  consumeReply(input: { integration: Integration; account: string; native_message_id: string; binding_id: string; parsed: ParsedReply }): ConsumeResult {
    const result = this.tx((): ConsumeResult => {
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
      const request = this.get<RequestRow>('SELECT * FROM decision_requests WHERE binding_id = ? ORDER BY revision DESC LIMIT 1', input.binding_id)
      if (!request) return done('no_open_request')
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
        const expected = request.code_hmac, given = codeHmac(this.key, request.owner_id, parsed.code)
        if (!sameHmac(expected, given)) {
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
          const live = this.get('SELECT 1 FROM action_intents WHERE effect_digest = ? AND state IN (\'pending\',\'prepared\',\'dispatching\',\'uncertain\',\'succeeded\')', item.effect_digest)
          if (live) { this.setItemState(item, 'blocked_uncertain'); blocked.push(item.ordinal); continue }
          const intent_id = randomUUID(), at = this.iso()
          this.setItemState(item, 'approved')
          this.run('INSERT INTO grants(request_id, item_id, integration, account, native_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            item.request_id, item.item_id, input.integration, input.account, input.native_message_id, at)
          this.run(`INSERT INTO action_intents(intent_id, request_id, item_id, kind, effect, effect_digest, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
            intent_id, item.request_id, item.item_id, item.kind, item.exact_effect, item.effect_digest, at, at)
          approved.push({ item_id: item.item_id, ordinal: item.ordinal, intent_id })
        }
        outcome = { outcome: 'approved', request_id: request.request_id, approved, ...(blocked.length ? { blocked_uncertain: blocked } : {}) }
      }
      if (!this.get('SELECT 1 FROM decision_items WHERE request_id = ? AND state = \'pending\'', request.request_id)) {
        this.run('UPDATE decision_requests SET state = \'closed\', updated_at = ? WHERE request_id = ?', this.iso(), request.request_id)
      }
      this.run('INSERT INTO inbound(integration, account, native_message_id, request_id, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        input.integration, input.account, input.native_message_id, request.request_id, outcome.outcome, this.iso())
      return outcome
    })
    return result
  }

  // ---------------------------------------------------------------- intenciones

  intent(intentId: string): IntentRow | undefined { return this.get<IntentRow>('SELECT * FROM action_intents WHERE intent_id = ?', intentId) }

  pendingIntents(): IntentRow[] { return this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'pending\' ORDER BY created_at') }

  /**
   * Autoriza y reclama una intención con fencing: solo quien presenta la generación vigente avanza, y la generación sube en cada reclamo.
   * Rechaza si la solicitud se revocó, venció o el ítem ya no está aprobado.
   */
  claimIntent(intentId: string, expectedGeneration: number): { intent: IntentRow; generation: number } | { rejected: string } {
    return this.tx(() => {
      const row = this.intent(intentId)
      if (!row) return { rejected: 'intent_not_found' }
      if (row.generation !== expectedGeneration) return { rejected: 'stale_generation' }
      if (row.state !== 'pending' && row.state !== 'prepared') return { rejected: `state_${row.state}` }
      const request = this.request(row.request_id)
      const item = this.get<ItemRow>('SELECT * FROM decision_items WHERE request_id = ? AND item_id = ?', row.request_id, row.item_id)
      if (item?.state !== 'approved') return { rejected: 'item_not_approved' }
      if (request.expires_at <= this.iso()) {
        this.run('UPDATE action_intents SET state = \'rejected_before_dispatch\', error_code = \'expired\', updated_at = ? WHERE intent_id = ?', this.iso(), intentId)
        this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
        return { rejected: 'expired' }
      }
      const generation = row.generation + 1
      this.run('UPDATE action_intents SET state = \'prepared\', generation = ?, updated_at = ? WHERE intent_id = ?', generation, this.iso(), intentId)
      return { intent: { ...row, state: 'prepared' as const, generation }, generation }
    })
  }

  /** Persiste `dispatching` ANTES de invocar la red o el proceso. Si otro intento ya despachó el mismo efecto, el índice único lo impide. */
  markDispatching(intentId: string, generation: number): 'ok' | 'stale' | 'duplicate_effect' {
    try {
      const changes = this.run('UPDATE action_intents SET state = \'dispatching\', updated_at = ? WHERE intent_id = ? AND generation = ? AND state = \'prepared\'', this.iso(), intentId, generation).changes
      if (Number(changes) !== 1) return 'stale'
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return 'duplicate_effect'
      throw error
    }
    const row = this.intent(intentId)!
    this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
    return 'ok'
  }

  /** Un fallo antes del dispatch devuelve la intención a su estado y permite que otro reclamo la retome. */
  releaseIntent(intentId: string, generation: number, errorCode: string, state: 'pending' | 'rejected_before_dispatch'): void {
    this.run('UPDATE action_intents SET state = ?, error_code = ?, updated_at = ? WHERE intent_id = ? AND generation = ? AND state = \'prepared\'', state, errorCode, this.iso(), intentId, generation)
    const row = this.intent(intentId)
    if (row) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
  }

  completeIntent(intentId: string, generation: number, receipt: { state: 'succeeded' | 'rejected_before_dispatch' | 'uncertain'; remote_ref?: string; result_digest?: string; error_code?: string }): boolean {
    const changes = this.run(`UPDATE action_intents SET state = ?, remote_ref = ?, result_digest = ?, error_code = ?, updated_at = ? WHERE intent_id = ? AND generation = ? AND state = 'dispatching'`,
      receipt.state, receipt.remote_ref ?? null, receipt.result_digest ?? null, receipt.error_code ?? null, this.iso(), intentId, generation).changes
    const row = this.intent(intentId)
    if (row) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
    return Number(changes) === 1
  }

  /**
   * Arranque tras caída: `dispatching` pasa a `uncertain` (no se sabe si el efecto ocurrió) y `prepared` vuelve a `pending`
   * (no hubo dispatch). Un resultado incierto no se reintenta solo.
   */
  recover(): { uncertain: number; reopened: number } {
    return this.tx(() => {
      const at = this.iso()
      const dispatching = this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'dispatching\'')
      const prepared = this.all<IntentRow>('SELECT * FROM action_intents WHERE state = \'prepared\'')
      this.run('UPDATE action_intents SET state = \'uncertain\', error_code = \'interrupted\', updated_at = ? WHERE state = \'dispatching\'', at)
      this.run('UPDATE action_intents SET state = \'pending\', updated_at = ? WHERE state = \'prepared\'', at)
      for (const row of [...dispatching, ...prepared]) this.dirty.add(`${row.request_id}\u0000${row.item_id}`)
      return { uncertain: dispatching.length, reopened: prepared.length }
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
