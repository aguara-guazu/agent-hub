/**
 * Hashing de contraseñas, tokens de sesión (JWT) y tokens de daemon.
 * Espeja `backend/agenthub/core/security.py`.
 *
 * Los dos principales del contrato son no intercambiables: el JWT firma la sesión de
 * la consola; el token opaco `ahd_...` identifica al daemon. Un JWT nunca sirve para
 * `/sync`, y un token de daemon nunca es un JWT.
 */
import { createHash, randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { Settings } from './config.js'

export const DAEMON_TOKEN_PREFIX = 'ahd_'

/** Centinela que marca una cuenta sin contraseña local (creada por SSO o dueño local). */
export const NO_LOCAL_PASSWORD = '!'

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain)
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  if (!hashed || hashed === NO_LOCAL_PASSWORD) return false
  try {
    return await argonVerify(hashed, plain)
  } catch {
    // Cualquier fallo (hash malformado, no-argon2) es "no verifica".
    return false
  }
}

function jwtKey(settings: Settings): Uint8Array {
  return new TextEncoder().encode(settings.jwtSecret)
}

export async function createAccessToken(
  settings: Settings,
  subject: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ ...extra })
    .setProtectedHeader({ alg: settings.jwtAlgorithm })
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + settings.accessTokenTtlSeconds)
    .sign(jwtKey(settings))
}

export async function decodeAccessToken(settings: Settings, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtKey(settings), {
    algorithms: [settings.jwtAlgorithm],
  })
  return payload
}

export function hashDaemonToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf-8').digest('hex')
}

/** Devuelve `[valor en claro, hash]`. El claro se muestra una sola vez. */
export function generateDaemonToken(): [string, string] {
  const raw = DAEMON_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return [raw, hashDaemonToken(raw)]
}
