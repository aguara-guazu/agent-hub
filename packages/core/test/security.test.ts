import { describe, expect, it } from 'vitest'
import { loadSettings } from '../src/config.js'
import {
  createAccessToken,
  decodeAccessToken,
  generateDaemonToken,
  hashDaemonToken,
  hashPassword,
  verifyPassword,
  DAEMON_TOKEN_PREFIX,
  NO_LOCAL_PASSWORD,
} from '../src/security.js'

const settings = loadSettings({ jwtSecret: 'test-secret' })

describe('security', () => {
  it('hashea y verifica contraseñas con Argon2', async () => {
    const hash = await hashPassword('correcto horse battery')
    expect(await verifyPassword('correcto horse battery', hash)).toBe(true)
    expect(await verifyPassword('otra', hash)).toBe(false)
  })

  it('el centinela sin contraseña nunca verifica', async () => {
    expect(await verifyPassword('lo-que-sea', NO_LOCAL_PASSWORD)).toBe(false)
  })

  it('el JWT viaja con sub y se valida', async () => {
    const token = await createAccessToken(settings, 'user-1')
    const payload = await decodeAccessToken(settings, token)
    expect(payload.sub).toBe('user-1')
  })

  it('un JWT firmado con otro secreto no valida', async () => {
    const token = await createAccessToken(loadSettings({ jwtSecret: 'otro' }), 'user-1')
    await expect(decodeAccessToken(settings, token)).rejects.toThrow()
  })

  it('el token de daemon tiene el prefijo ahd_ y su hash es estable', () => {
    const [raw, digest] = generateDaemonToken()
    expect(raw.startsWith(DAEMON_TOKEN_PREFIX)).toBe(true)
    expect(hashDaemonToken(raw)).toBe(digest)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
  })
})
