import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { MemoryService } from '../service.js'
import { check, id, parse } from '../contracts.js'
import { workFolder } from "../store.js"
import { publicIdentity, publicIdentitySchema } from './crypto.js'
import { roleSchema } from './schema.js'
import { networkSettingsSchema } from './network.js'
import { exportProject, restoreProject } from './archive.js'
import { encodeInvitation } from './invitation-code.js'

const adminInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('rename'), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ operation: z.literal('network'), settings: networkSettingsSchema }).strict(),
  z.object({ operation: z.literal('create'), project_id: id }).strict(),
  z.object({ operation: z.literal("join"), invitation: z.unknown(), folder: workFolder.optional(), phrase: z.string().max(500).optional() }).strict(),
  z.object({ operation: z.literal('member'), project_id: id, identity: publicIdentitySchema, role: roleSchema, invite: z.boolean(), revoke: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('recover'), project_id: id, phrase: z.string().max(500) }).strict(),
  z.object({ operation: z.literal('recovery_phrase'), project_id: id }).strict(),
  z.object({ operation: z.literal('export'), project_id: id }).strict(),
  z.object({ operation: z.literal("restore"), archive: z.unknown(), folder: workFolder.optional(), phrase: z.string().max(500).optional() }).strict(),
  z.object({ operation: z.literal('pause'), project_id: id, paused: z.boolean() }).strict(),
])

/** Local console only. Plaintext recovery secrets never enter MCP, prompts or peer traffic. */
export function sharingRoutes(app: FastifyInstance, service: MemoryService, authorize: (request: FastifyRequest) => Promise<unknown>) {
  app.post('/api/memory/sharing/call', { preHandler: async request => { await authorize(request) }, bodyLimit: 180_000_000 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const input = parse(adminInput, request.body), { operations, network, db } = await service.get(), sharing = operations.sharing
    switch (input.operation) {
      case 'status': return { identity: publicIdentity(await sharing.identity()), network: await network.status(),
        projects: await db.query(`SELECT s.id,e.title,s.enabled,s.conflict,
          COALESCE(json_array_length(e.data,'$.folders'),0)=0 AS "folderless:bool"
          FROM shared_projects s JOIN entities e ON e.id=s.id`),
        peers: await db.query('SELECT id,name,last_seen_at FROM shared_peers ORDER BY last_seen_at DESC LIMIT 100') }
      case 'rename': return sharing.rename(input.name)
      case 'network': return network.configure(input.settings)
      case 'create': { const result = await sharing.create(input.project_id); await network.tick(); return result }
      case "join": { const result = await sharing.acceptInvitation(input.invitation, input.folder, input.phrase); await network.tick(); return result }
      case 'member': return { invitation: encodeInvitation(await sharing.store.db.transaction(() => sharing.changeMember(input.project_id, input.identity, input.role, input.invite, input.revoke))) }
      case 'recover': return sharing.store.db.transaction(() => sharing.recover(input.project_id, input.phrase))
      case 'recovery_phrase': return db.transaction(() => sharing.recoveryPhrase(input.project_id), 'read')
      case 'export': return exportProject(sharing, input.project_id)
      case "restore": {
        const archive = parse(z.object({ project: id }).passthrough(), input.archive)
        const folder = await sharing.prepareLocalFolder(archive.project, input.folder)
        const result = await restoreProject(sharing, input.archive, input.phrase)
        if (folder) await sharing.associateLocalFolder(result.project_id, folder)
        await network.tick()
        return result
      }
      case 'pause': {
        check(operations.setSharedPaused, "La sincronización compartida no está disponible en este servicio", 503)
        return operations.setSharedPaused(input.project_id, input.paused)
      }
    }
  })
}
