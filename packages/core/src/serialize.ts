/**
 * Validaciones y serializadores compartidos por los routers. Espejan las reglas de los
 * esquemas Pydantic de `backend/agenthub/api/schemas_*.py`.
 */
import type { Store } from './store.js'
import type { SquadMembership, User } from './types.js'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const CATALOG_SLUG_RE = /^[a-z][a-z0-9_-]{1,47}$/
const SECRET_REF_RE = /^[a-z][a-z0-9+.-]*:\/\/.+$/
const SECRET_SCHEMES = new Set(['env', 'file', 'keychain'])

export class ValidationError extends Error {}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new ValidationError('el email no tiene un formato valido')
  return email
}

export function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('el slug admite minusculas, digitos, guion y guion bajo, y empieza con letra o digito')
  }
  return slug
}

export function validateCatalogSlug(value: string): string {
  const slug = String(value ?? '')
  if (!CATALOG_SLUG_RE.test(slug)) {
    throw new ValidationError('el slug del catalogo debe empezar con letra, usar [a-z0-9_-] y tener 2..48 caracteres')
  }
  return slug
}

/**
 * Valida que cada valor de `secret_refs` sea una REFERENCIA y no un secreto pegado. El
 * mensaje nunca repite el valor: si el valor es el secreto, repetirlo lo copiaría al log.
 */
export function validateSecretRefs(refs: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [name, raw] of Object.entries(refs)) {
    const text = String(raw).trim()
    if (!SECRET_REF_RE.test(text)) {
      throw new ValidationError(
        `secret_refs[${JSON.stringify(name)}] no es una referencia: tiene que ser <backend>://<ruta>, ` +
          `por ejemplo keychain://agenthub/mi-token. Aca va el NOMBRE de un secreto, nunca su valor.`,
      )
    }
    const scheme = text.split('://', 1)[0]!
    if (!SECRET_SCHEMES.has(scheme)) {
      throw new ValidationError(
        `secret_refs[${JSON.stringify(name)}] usa el esquema ${JSON.stringify(scheme)}, que el daemon no ` +
          `resuelve. Disponibles: ${[...SECRET_SCHEMES].join(', ')}.`,
      )
    }
    clean[name] = text
  }
  return clean
}

// --------------------------------------------------------------- serializadores

export function isCurrent(membership: SquadMembership, nowMs: number): boolean {
  const started = membership.valid_from === null || Date.parse(membership.valid_from) <= nowMs
  const notEnded = membership.valid_to === null || Date.parse(membership.valid_to) >= nowMs
  return started && notEnded
}

export interface SquadRef {
  id: string
  slug: string
  name: string
  role: 'lead' | 'member'
}

export interface UserOut {
  id: string
  email: string
  full_name: string
  org_role: User['org_role']
  is_active: boolean
  squads: SquadRef[]
  organization: string
}

export function serializeUsers(store: Store, users: User[]): UserOut[] {
  const nowMs = Date.now()
  const byUser = new Map<string, SquadRef[]>(users.map((u) => [u.id, []]))
  for (const { membership, squad } of store.membershipsOfUsers(users.map((u) => u.id))) {
    if (!isCurrent(membership, nowMs)) continue
    byUser.get(membership.user_id)?.push({ id: squad.id, slug: squad.slug, name: squad.name, role: membership.role })
  }
  const orgNames = new Map(store.organizationsByIds([...new Set(users.map((u) => u.organization_id))]).map((o) => [o.id, o.name]))
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    org_role: u.org_role,
    is_active: u.is_active,
    squads: (byUser.get(u.id) ?? []).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
    organization: orgNames.get(u.organization_id) ?? '',
  }))
}

export function serializeUser(store: Store, user: User): UserOut {
  return serializeUsers(store, [user])[0]!
}

export interface SquadOut {
  id: string
  slug: string
  name: string
  client_account_id: string | null
  member_count: number
}

export function serializeSquads(store: Store, squadIds: { id: string; slug: string; name: string; client_account_id: string | null }[]): SquadOut[] {
  const nowMs = Date.now()
  const counts = new Map<string, number>(squadIds.map((s) => [s.id, 0]))
  for (const membership of store.membershipsOfSquads(squadIds.map((s) => s.id))) {
    if (isCurrent(membership, nowMs)) counts.set(membership.squad_id, (counts.get(membership.squad_id) ?? 0) + 1)
  }
  return squadIds.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    client_account_id: s.client_account_id,
    member_count: counts.get(s.id) ?? 0,
  }))
}
