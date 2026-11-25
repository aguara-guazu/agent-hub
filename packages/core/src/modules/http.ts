import type { FastifyRequest } from 'fastify'
import type { User } from '../types.js'
import type { Store } from '../store.js'
import { CATALOG_RESTORE_WINDOW_MS } from '@agenthub/shared'

export interface CatalogContext {
  store: Store
  currentUser(request: FastifyRequest): Promise<User>
  notifyAfterCommit(scope: 'agent' | 'user', id: string): void
}

/** Error HTTP con código explícito, como las `HTTPException` del backend. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function isAdmin(user: User): boolean {
  return user.org_role === 'admin' || user.org_role === 'owner'
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(422, 'el cuerpo debe ser un objeto JSON')
  return body
}

export function rejectUnknown(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new HttpError(422, `campo desconocido: ${key}`)
    }
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(422, `falta el campo ${field}`)
  return value
}

export function optionalString(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(422, `el campo ${field} debe ser texto`)
  return value
}

export function withinRestoreWindow(deletedAt: string): boolean {
  const at = Date.parse(deletedAt)
  return Number.isFinite(at) && Date.now() - at <= CATALOG_RESTORE_WINDOW_MS
}
