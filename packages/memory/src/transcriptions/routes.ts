import type { ModuleEnabled } from '@agenthub/shared/modules'
import { mediaSettings, queueMedia } from './media-processing.js'
import { ALL_MEDIA_MODULES, mediaSettingsInput } from './media-runtime.js'
import { registerRecordingRoutes } from "./recording-routes.js"
import { UpcomingEvents } from "./upcoming-events.js"
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MemoryService } from '../service.js'
import { parse } from '../contracts.js'
import type { MemoryRouteOptions, OwnerGuard } from '../http.js'

export function registerTranscriptions(app: FastifyInstance, service: MemoryService, auth: OwnerGuard, options: MemoryRouteOptions, enabled: ModuleEnabled) {
  registerRecordingRoutes(app, async () => ({ store: (await service.get()).store, directory: options.directory }),
    new UpcomingEvents(async () => (await service.get()).store, service.google), options.authorize, enabled)
  app.get('/api/memory/media', { preHandler: auth }, async () => ({ settings: await mediaSettings((await service.get()).store), modules: service.media.status() }))
  app.put('/api/memory/media', { preHandler: auth }, async request => {
    // Modules that are still downloading are skipped when processing, so saving does not wait for them.
    const settings = parse(mediaSettingsInput, request.body), { store } = await service.get()
    await store.db.query("INSERT INTO settings(key,value) VALUES('media',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(settings)])
    await queueMedia(store, {}, true, service.media)
    return { settings, modules: service.media.status() }
  })
  app.post('/api/memory/media/:module/:action', { preHandler: auth }, async (request, reply) => {
    const { module, action } = parse(z.object({ module: z.enum(ALL_MEDIA_MODULES), action: z.enum(['install','cancel']) }).strict(), request.params)
    return reply.code(action === 'install' ? 202 : 200).send(action === 'install' ? service.media[module].install() : await service.media[module].cancelInstall())
  })
}
