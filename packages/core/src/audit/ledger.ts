/**
 * Ledger de auditoría encadenado por hash. Espeja `backend/agenthub/modules/audit/ledger.py`.
 *
 *     event_hash = sha256(prev_hash + canonical(body))
 *
 * El body son los campos del evento con claves ordenadas y `prev_hash`/`event_hash`
 * afuera. Alterar, borrar o intercalar una fila rompe la cadena a partir de ahí y
 * `verify` lo encuentra. No es a prueba de un atacante con escritura a la base: sirve
 * para detectar manipulación puntual y borrado silencioso.
 */
import { createHash } from 'node:crypto'
import { canonicalJson, newId } from '@agenthub/shared'
import type { Store } from '../store.js'
import type { AuditEventRow, User } from '../types.js'

export const GENESIS_HASH = ''

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** Campos que entran al hash. `prev_hash` y `event_hash` quedan afuera a propósito. */
function eventBody(event: AuditEventRow): Record<string, unknown> {
  return {
    id: event.id,
    organization_id: event.organization_id,
    actor_user_id: event.actor_user_id ?? '',
    actor_label: event.actor_label,
    action: event.action,
    target_type: event.target_type,
    target_id: event.target_id,
    detail: event.detail ?? {},
    created_at: event.created_at,
  }
}

export function computeHash(prevHash: string, event: AuditEventRow): string {
  return sha256(prevHash + canonicalJson(eventBody(event)))
}

function actorFields(actor: User | string | null): { userId: string | null; label: string } {
  if (actor === null) return { userId: null, label: 'sistema' }
  if (typeof actor === 'string') return { userId: null, label: actor }
  return { userId: actor.id, label: actor.email }
}

/**
 * Agrega un evento al final de la cadena. El `created_at` es estrictamente creciente:
 * si el reloj no avanzó desde el evento anterior, se le suma un milisegundo, para que
 * `verify` recorra en el mismo orden en que `record` encadenó.
 */
export function record(
  store: Store,
  organizationId: string,
  actor: User | string | null,
  action: string,
  targetType = '',
  targetId = '',
  detail: Record<string, unknown> = {},
): AuditEventRow {
  const { userId, label } = actorFields(actor)
  const previous = store.lastAuditEvent(organizationId)

  let createdAt = new Date().toISOString()
  if (previous && createdAt <= previous.created_at) {
    createdAt = new Date(new Date(previous.created_at).getTime() + 1).toISOString()
  }

  const event: AuditEventRow = {
    id: newId(),
    organization_id: organizationId,
    actor_user_id: userId,
    actor_label: label,
    action,
    target_type: targetType,
    target_id: targetId,
    detail,
    prev_hash: previous ? previous.event_hash : GENESIS_HASH,
    event_hash: '',
    created_at: createdAt,
  }
  event.event_hash = computeHash(event.prev_hash, event)
  store.insertAuditEvent(event)
  return event
}

/** Recorre la cadena en orden y devuelve `{ok, brokenAt}`. */
export function verify(store: Store, organizationId: string): { ok: boolean; brokenAt: string | null } {
  let prevHash = GENESIS_HASH
  for (const event of store.auditEventsChrono(organizationId)) {
    if (event.prev_hash !== prevHash) return { ok: false, brokenAt: event.id }
    if (computeHash(prevHash, event) !== event.event_hash) return { ok: false, brokenAt: event.id }
    prevHash = event.event_hash
  }
  return { ok: true, brokenAt: null }
}
