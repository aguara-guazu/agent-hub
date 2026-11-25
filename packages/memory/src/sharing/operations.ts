import { SharedPublications } from '../sharing/publications.js'
import { z } from 'zod'
import { MemoryError, check, id, instant } from '../contracts.js'
import { workFolder } from "../store.js"
import { type AgentContext } from '../agents.js'

const page = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }
export const sharingReadOperations = [
  'shared_version', 'shared_status', 'read_messages',
] as const satisfies readonly (keyof typeof sharingDefinitions)[]

export const sharingDefinitions = {
  shared_status: ['Shared project members, permissions, identity, versions. Work on it per skill hub-collaboration.', z.object({ project_id: id }).strict()],
  shared_join: ["Join a shared project only when the person asks. The invitation is the one-line ahinv1. code or the legacy agenthub-invitation-v1 JSON. Requires an existing local folder and never accepts a recovery phrase.", z.object({ invitation: z.unknown(), folder: workFolder }).strict()],
  shared_pause: ["Pause or resume synchronization of a shared project on this hub, only when the person asks. Resuming reconsiders unassigned inter-hub channels.", z.object({ project_id: id, paused: z.boolean() }).strict()],
  shared_version: ['Full shared version with author, agent and origin peer; read before resolving a conflict. No attachment bytes.', z.object({ project_id: id, event_id: z.string().length(64) }).strict()],
  publish_source: ['Publish a source early (normally automatic) or share a task/collection. Keeps provenance, dedupes; shares only project fragments.', z.object({ project_id: id, entity_id: id, key: z.string().max(1000).optional() }).strict()],
  resolve_shared: ['Resolve concurrent shared-source versions: pick an event after checking its evidence. All past versions kept.', z.object({ project_id: id, key: z.string().max(1000), event_id: z.string().length(64) }).strict()],
  send_message: ['Expiring message/reply in the agents-only forum. Needs agent identity and authorization to communicate. Public without to_member; private with to_member (optional to_agent).', z.object({ project_id: id, text: z.string().trim().min(1).max(8000), expires_at: instant, to_member: z.string().length(64).optional(), to_agent: z.string().max(200).optional(), reply_to: z.string().length(64).optional() }).strict()],
  read_messages: ['Active project messages for this agent or team. Marks read; never accepts or runs requests. Paginate for all; with unread_only:true keep offset:0 while draining.', z.object({ project_id: id, unread_only: z.boolean().default(false), ...page }).strict()],
  ack_message: ['Mark a project message read or handled (request resolved, not just read).', z.object({ project_id: id, message_id: z.string().length(64), state: z.enum(['read','handled']) }).strict()],
  claim_work: ['Claim project work for 5 minutes under a stable key. Advisory: partitions can cause concurrent attempts.', z.object({ project_id: id, key: z.string().min(1).max(200) }).strict()],

} satisfies Record<string, [string, z.ZodType]>

export async function callSharing(sharing: SharedPublications,
  setPaused: ((projectId: string, paused: boolean) => Promise<unknown>) | undefined,
  operation: string, input: any, author: string, agent?: AgentContext) {
  if (['send_message', 'ack_message'].includes(operation)) check(agent?.agent_id, 'Sólo los agentes pueden participar en el foro del proyecto', 403)
  switch (operation) {
    case 'shared_status': {
      const project = await sharing.get(input.project_id), who = await sharing.identity()
      return { project_id: input.project_id, identity: { id: who.id, name: who.name }, members: project.policy.members, conflict: project.conflict,
        enabled: project.enabled, publications: await sharing.publications(input.project_id), pending_sources: await sharing.sourceSyncStatus(input.project_id), skill: 'hub-collaboration' }
    }
    case "shared_join": {
      check(agent, "Aceptar una invitación compartida por MCP requiere la identidad del agente", 403)
      return sharing.acceptInvitation(input.invitation, input.folder, undefined, author)
    }
    case "shared_pause": {
      check(setPaused, "La sincronización compartida no está disponible en este servicio", 503)
      return setPaused(input.project_id, input.paused)
    }
    case 'shared_version': return sharing.version(input.project_id, input.event_id)
    case 'publish_source': return sharing.publish(input.project_id, input.entity_id, input.key, agent)
    case 'resolve_shared': return sharing.resolve(input.project_id, input.key, input.event_id, agent)
    case 'send_message': return sharing.message(input.project_id, input.text, input.expires_at, input.to_member, input.to_agent, input.reply_to, agent)
    case 'read_messages': {
      const result = await sharing.messages(input.project_id, agent, input.offset, input.limit, input.unread_only)
      if (agent) for (const message of result.items) if (message.state === 'unread') await sharing.receipt(input.project_id, message.id, 'read', agent)
      return result
    }
    case 'ack_message': return sharing.receipt(input.project_id, input.message_id, input.state, agent)
    case 'claim_work': return sharing.claim(input.project_id, input.key, agent)
    default: throw new MemoryError(404, 'Operación de proyecto compartido inexistente')
  }
}
