import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerMemory } from '../src/routes.js'
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE } from '../src/google-auth.js'

let dir: string, app: FastifyInstance, service: ReturnType<typeof registerMemory>['service'], granted: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-google-consent-'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('oauth2.googleapis.com/token')
    ? new Response(JSON.stringify({ access_token: 'token-de-prueba', refresh_token: 'refresco', expires_in: 3600, scope: granted }), { status: 200 })
    : new Response('{}', { status: 404 })))
  app = Fastify(); service = registerMemory(app, { directory: dir, baseUrl: 'http://127.0.0.1:1', authorize: async () => ({ id: 'owner' }) }).service
  service.vault.save('google-client', { client_id: 'cliente-de-prueba' })
})
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })

const connector = async (config: object = {}) => {
  const { db } = await service.get(), id = crypto.randomUUID()
  await db.query("INSERT INTO connectors(id,provider,name,config,enabled) VALUES($1,'google','Google',$2,0)", [id, JSON.stringify(config)])
  return id
}
const start = async (id: string, payload?: object) => app.inject({ method: 'POST', url: `/api/memory/connectors/${id}/google/start`, ...(payload ? { payload } : {}) })
const scopes = (url: string) => new URL(url).searchParams.get('scope')!.split(' ')
const state = (url: string) => new URL(url).searchParams.get('state')!
const config = async (id: string) => ((await (await service.get()).db.query('SELECT config FROM connectors WHERE id=$1', [id]))[0] as { config: Record<string, unknown> }).config

it('pedir el envío agrega gmail.send al mismo consentimiento y sin pedirlo no se solicita', async () => {
  const id = await connector()
  const plain = (await start(id)).json()
  expect(scopes(plain.authorization_url)).toContain(GMAIL_SCOPE); expect(scopes(plain.authorization_url)).not.toContain(GMAIL_SEND_SCOPE); expect(plain.gmail_send).toBe(false)
  const withSend = (await start(id, { gmail_send: true })).json()
  expect(scopes(withSend.authorization_url)).toEqual(expect.arrayContaining([GMAIL_SCOPE, GMAIL_SEND_SCOPE])); expect(withSend.gmail_send).toBe(true)
  expect(await config(id)).not.toHaveProperty('gmail_send_enabled')
})

it('el envío exige la lectura de Gmail y rechaza campos desconocidos', async () => {
  const id = await connector({ gmail_enabled: false })
  expect((await start(id, { gmail_send: true })).statusCode).toBe(409)
  expect((await start(id, { otro: true })).statusCode).toBeGreaterThanOrEqual(400)
})

it('el callback activa el envío solo si Google lo concedió', async () => {
  const id = await connector()
  granted = `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`
  const accepted = await app.inject({ method: 'GET', url: `/api/memory/google/callback?code=c&state=${state((await start(id, { gmail_send: true })).json().authorization_url)}` })
  expect(accepted.statusCode).toBe(200); expect(accepted.body).toContain('envío por Gmail quedó autorizado')
  expect((await config(id)).gmail_send_enabled).toBe(true)

  const refused = await connector()
  granted = GMAIL_SCOPE
  const denied = await app.inject({ method: 'GET', url: `/api/memory/google/callback?code=c&state=${state((await start(refused, { gmail_send: true })).json().authorization_url)}` })
  expect(denied.body).toContain('no concedió el envío'); expect(await config(refused)).not.toHaveProperty('gmail_send_enabled')

  const plain = await connector()
  granted = `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`
  await app.inject({ method: 'GET', url: `/api/memory/google/callback?code=c&state=${state((await start(plain)).json().authorization_url)}` })
  expect(await config(plain)).not.toHaveProperty('gmail_send_enabled')
})

it('list_connectors informa la dirección que Gmail reportó y null mientras no hay sincronización, sin inventarla', async () => {
  const { db, operations } = await service.get()
  const known = await connector(), unknown = await connector()
  await db.query("UPDATE connectors SET cursor=$2 WHERE id=$1", [known, JSON.stringify({ gmail: { mailbox: 'ana@example.com' } })])
  await db.query("INSERT INTO connectors(id,provider,name,config,enabled) VALUES('00000000-0000-4000-8000-000000000001','jira','Jira','{}',0)")
  const rows = Object.fromEntries((await operations.call('list_connectors', {})).map((row: any) => [row.id, row]))
  expect(rows[known].account_email).toBe('ana@example.com')
  expect(rows[unknown].account_email).toBeNull()
  expect(rows['00000000-0000-4000-8000-000000000001']).not.toHaveProperty('account_email')
  expect(JSON.stringify(rows)).not.toContain('mailbox')
})
