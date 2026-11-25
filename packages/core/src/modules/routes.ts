import { isModuleId, moduleDefinition, moduleStates, routeModules, type ModuleId } from '@agenthub/shared/modules'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { moduleEnabled } from './settings.js'
import type { Store } from '../store.js'

/** Routes are matched at registration. The switch is read again on each request, including existing sessions. */
export function installModuleGuards(app: FastifyInstance, store: Store, authenticate: (request: FastifyRequest) => Promise<unknown>) {
  app.addHook('onRoute', route => {
    // Desktop reads the effective preference even while off and finalizes a capture already on disk.
    if (route.method === 'GET' && ['/api/memory/recordings/settings', '/api/memory/recordings/upcoming'].includes(route.url)) return
    if (route.url === '/api/memory/mcp') return // This upstream authenticates its own machine credential.
    if (route.method === 'POST' && route.url === '/api/memory/recordings') return
    const required = routeModules(route.url)
    if (!required.length) return
    const existing = route.preHandler
    const handlers = existing ? [existing].flat() : []
    route.preHandler = [...handlers, async (request, reply) => {
      const id = required.find(module => !moduleEnabled(store, module))
      if (!id) return
      if (!handlers.length && !['/api/oauth/callback', '/api/memory/google/callback'].includes(route.url)) await authenticate(request)
      return reply.code(409).send({ code: 'module_disabled', module: id, detail: 'El módulo «' + moduleDefinition(id).label + '» está desactivado en Ajustes' })
    }]
  })
}

export function registerModuleSettings(app: FastifyInstance, store: Store,
  authorize: (request: FastifyRequest) => Promise<unknown>, changed: (id: ModuleId) => Promise<void>) {
  const states = () => ({ ...moduleStates(id => moduleEnabled(store, id)), can_manage: true })
  const auth = { preHandler: async (request: FastifyRequest) => { await authorize(request) } }
  app.get('/api/modules', auth, async () => states())
  app.put('/api/modules/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isModuleId(id)) return reply.code(404).send({ detail: 'Módulo desconocido' })
    const body = request.body as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean' || Object.keys(body).length !== 1) return reply.code(422).send({ detail: 'Se requiere enabled booleano' })
    store.setSetting(moduleDefinition(id).setting, body.enabled ? '1' : '0')
    await changed(id)
    return states()
  })
}
