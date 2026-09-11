/**
 * El dueño único del hub local. Espeja `backend/agenthub/modules/local/__init__.py`.
 *
 * En modo local no hay registro ni contraseña: la cuenta del sistema ya es la frontera.
 * Pero el esquema no cambia: es una organización con una sola persona. Cuando aparezca
 * el servicio con organizaciones de verdad, sólo cambia de dónde sale el usuario.
 */
import { hostname, userInfo } from 'node:os'
import { NO_LOCAL_PASSWORD } from './security.js'
import type { Store } from './store.js'
import type { User } from './types.js'

export const LOCAL_ORG_SLUG = 'local'

export function systemUser(): string {
  try {
    return userInfo().username || 'local'
  } catch {
    return 'local'
  }
}

export function localEmail(): string {
  return `${systemUser()}@${hostname() || 'localhost'}`
}

/** Devuelve al dueño de este hub, creándolo la primera vez. Idempotente. */
export function ensureLocalOwner(store: Store): User {
  let org = store.organizationBySlug(LOCAL_ORG_SLUG)
  if (!org) org = store.insertOrganization(LOCAL_ORG_SLUG, 'Local')

  let owner = store.firstUserOfOrg(org.id)
  if (!owner) {
    owner = store.insertUser({
      organization_id: org.id,
      email: localEmail(),
      full_name: systemUser(),
      password_hash: NO_LOCAL_PASSWORD,
      org_role: 'owner',
      is_active: true,
    })
  }
  return owner
}
