import type { ModuleEnabled } from '@agenthub/shared/modules'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getJiraSettings, saveJiraSettings } from './jira-settings.js'
import { MemoryService } from '../service.js'
import { check, id, MemoryError, parse } from '../contracts.js'
import { GMAIL_SEND_SCOPE, googleScopes } from './google-auth.js'
import { activateGoogleSource, ensureGoogleSource } from './google-setup.js'
import type { OwnerGuard } from '../http.js'

export function registerConnections(app: FastifyInstance, service: MemoryService, auth: OwnerGuard, enabled: ModuleEnabled) {
  app.get('/api/memory/jira-settings', { preHandler: auth }, async () => getJiraSettings((await service.get()).db))
  app.put('/api/memory/jira-settings', { preHandler: auth }, async request => saveJiraSettings((await service.get()).db,request.body))
  app.put('/api/memory/credentials/:key', { preHandler: auth }, async request => {
    const { key } = request.params as { key: string }
    if (!enabled('connections')) throw new MemoryError(409, 'Módulo desactivado en Ajustes', false, 'module_disabled')
    if (key === 'google-client') {
      const value = parse(z.object({ client_id: z.string().min(1).max(1000), client_secret: z.string().max(2000).optional() }).strict(), request.body)
      service.vault.save(key, value)
      const source = await ensureGoogleSource((await service.get()).store)
      return { configured: true, connector_id: source.id, authorization_url: service.google.start(source.id, googleScopes(source.config)) }
    } else {
      parse(id, key)
      const connector = (await (await service.get()).db.query('SELECT provider FROM connectors WHERE id=$1', [key]))[0]
      check(connector, 'Conector inexistente', 404)
      check(connector.provider !== 'google', 'Google se conecta con OAuth')
      service.vault.save(key, parse(z.object({ token: z.string().min(1).max(4000), email: z.email().optional() }).strict(), request.body))
    }
    return { configured: true }
  })
  app.post('/api/memory/connectors/:id/google/start', { preHandler: auth }, async request => {
    const connectorId = parse(id, (request.params as { id: string }).id)
    const row = (await (await service.get()).db.query("SELECT id,config FROM connectors WHERE id=$1 AND provider='google'", [connectorId]))[0]
    check(row, 'Conector de Google inexistente', 404)
    const { gmail_send } = parse(z.object({ gmail_send: z.boolean().optional() }).strict(), request.body ?? {})
    // Sending needs the read scope too (replies are read from the same mailbox), and a desktop app asks for every scope in one consent.
    if (gmail_send) check(row.config.gmail_enabled !== false, 'El envío por Gmail requiere mantener activada la lectura de Gmail', 409)
    const scopes = googleScopes(gmail_send ? { ...row.config, gmail_send_enabled: true } : row.config)
    return { authorization_url: service.google.start(connectorId, scopes, { gmailSend: gmail_send === true }), gmail_send: gmail_send === true }
  })
  app.get('/api/memory/google/callback', async (request, reply) => {
    const query = request.query as Record<string, string>
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
    try {
      check(query.state && query.code && !query.error, 'No se completó la autorización', 400)
      const { connector: connectorId, gmail_send_requested } = await service.google.complete(query.state, query.code)
      const { db } = await service.get()
      // The setting follows what Google actually granted: asking is not having it.
      const sendGranted = gmail_send_requested && service.google.granted(connectorId, GMAIL_SEND_SCOPE)
      if (sendGranted) await db.query("UPDATE connectors SET config=json_set(config,'$.gmail_send_enabled',json('true')),updated_at=now() WHERE id=$1 AND provider='google'", [connectorId])
      await activateGoogleSource((await service.get()).store, service.google, connectorId).catch(() => undefined)
      const send = gmail_send_requested ? (sendGranted ? '<p>El envío por Gmail quedó autorizado.</p>' : '<p>Google no concedió el envío por Gmail: la fuente sigue solo con lectura.</p>') : ''
      return reply.send(`<!doctype html><meta charset="utf-8"><title>Google conectado</title><h1>Google conectado a Agent Hub</h1><p>La fuente quedó activa y empezó a sincronizar. Esta ventana ya se puede cerrar.</p>${send}`)
    } catch { return reply.code(400).send('<!doctype html><meta charset="utf-8"><title>Conexión pendiente</title><h1>No se completó la conexión</h1><p>Vuelve al hub y revisa el cliente OAuth antes de reintentar.</p>') }
  })
}
