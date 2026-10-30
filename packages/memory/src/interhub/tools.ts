import { z } from "zod"
import type { InterhubRoster, VerifiedInterhubChatEnvelope } from "@agenthub/shared"
import { check, id, parse } from "../contracts.js"
import type { AgentContext } from "../agents.js"
import type { LocalChat } from "../local-chat.js"

const session = { session_key: z.string().min(32).max(200).optional() }
// Length bounds only: the shape of a code is never described to a caller, so a wrong code fails like a revoked one.
const code = z.string().trim().min(1).max(200)

/** Session row of the calling agent, as resolved by the Hub from its session_key. Never built from tool input. */
export type InterhubCaller = Record<string, any> & { id: string; channel_id: string }

export type InterhubCodeAction = "regenerate" | "revoke"

/**
 * What the tools and routes need from the P2P replica (p2p-core) and the chat model (interhub-chat).
 * Every method re-checks authority with Hub data; the tool layer only validates input and resolves the caller.
 */
export interface InterhubServices {
  /**
   * The caller becomes the leader of its hub in the new channel. An explicit project must exist in this hub; without one
   * the channel takes the single project of the caller's local workspace channels, or none.
   */
  createChannel(caller: InterhubCaller, input: { name: string; projectId?: string | null | undefined }): Promise<{ channel_id: string; code: string; project_id: string | null }>
  /**
   * Authority: the caller must be the current leader of its own local channel. A wrong, revoked or unknown code fails alike.
   * The local copy takes `projectId` (validated here) or, without it, the same default as createChannel.
   */
  joinChannel(caller: InterhubCaller, code: string, projectId?: string | null): Promise<{ channel_id: string; hub_id: string; project_id: string | null }>
  /**
   * Authority: only the current leader of this hub in the channel. add associates an open, nicknamed local session of this
   * hub from the leader's or the channel's project, or a joined member of an active team the leader coordinates; it then
   * reads, writes and is mentioned there as a member of this hub. remove ends that and cancels its pending mentions there.
   */
  localAgent(caller: InterhubCaller, channelId: string, sessionId: string, action: "add" | "remove"): Promise<{ channel_id: string; session_id: string; associated: boolean }>
  /** Authority: only the current leader of the hub that created the channel. */
  rotateCode(caller: InterhubCaller, channelId: string, action: InterhubCodeAction): Promise<{ code?: string; revoked?: boolean }>
  /** Null when the channel does not exist or is not an inter-hub channel. */
  roster(channelId: string): Promise<InterhubRoster | null>
  /** Escalations addressed to this hub that no leader has resolved yet. */
  pendingEscalations(channelId: string): Promise<InterhubPendingEscalation[]>
  /**
   * Plain code. The service must prove the local hub is the creator hub and the code is not revoked
   * (an absent vault entry is not the barrier); null otherwise.
   */
  creatorCode(channelId: string): Promise<string | null>
  /** Authority: the caller must be the current leader of its hub in the channel. */
  escalate(caller: InterhubCaller, channelId: string, threadId: string, messageId: string): Promise<{ delegated_to_hub_id: string; escalation_id?: string } | { no_other_hub: true }>
  /** Authority: only the leader of a member hub. Marks the escalation answered for every hub. */
  resolveEscalation(caller: InterhubCaller, channelId: string, threadId: string, escalationId: string): Promise<{ resolved: true }>
  /** Hub runtime only: next round of every unresolved escalation of a local question whose current round timed out. */
  sweepEscalations(now?: number): Promise<{ rounds: number; failed: number }>
  /** P2P only, after signature, membership and peer verification: materializes a chat envelope. */
  receive(envelope: VerifiedInterhubChatEnvelope): Promise<{ duplicate: boolean }>
}

export interface InterhubPendingEscalation {
  id: string
  thread_id: string
  question_message_id: string
  escalated_at: string
}

export const interhubDefinitions = {
  chat_interhub_create: ["Create an inter-hub channel: one channel shared by agents of several Agent Hubs, each hub with its own leader. Only after the person asks for it. You become your hub's leader in it. project_id places it in that project of this hub (the person sees it in that project's Collaboration tab); omitted, the Hub uses the single project of your local channels, or none (then no project tab shows it). Returns channel_id, project_id and the join code ONCE: give the code to the person only in your terminal, never in a channel, thread, file or ticket. The code never expires and has no use limit; whoever holds it gets full trust, so regenerate or revoke it with memory_chat_interhub_code if it leaks.",
    z.object({ ...session, name: z.string().trim().min(1).max(200), project_id: id.optional() }).strict()],
  chat_interhub_join: ["Join an inter-hub channel with its code, only when the person gives you the code in your terminal and asks you to join. You must lead your own channel; you become your hub's leader in the inter-hub channel and receive orders from any person of any connected hub. project_id places the channel in that project of this hub; omitted, the Hub uses the single project of your local channels, or none (then no project tab shows it). The creator hub must be open: the Hub finds it over P2P, redials by itself when a connection does not answer and proves the code without sending it, so the call can take up to 90 seconds. A wrong, revoked or unknown code and a creator hub that did not answer in time fail with the same error.",
    z.object({ ...session, code, project_id: id.optional() }).strict()],
  chat_interhub_code: ["Regenerate or revoke the join code of an inter-hub channel. Only the leader of the hub that created the channel. regenerate invalidates the previous code and returns the new one (never expires, no use limit); revoke invalidates it without a replacement, so nobody new can join. Hubs already joined keep their membership. Give a new code to the person only in your terminal.",
    z.object({ ...session, channel_id: id, action: z.enum(["regenerate", "revoke"]) }).strict()],
  chat_interhub_add_local_agent: ["Leaders only (your hub's leader in that inter-hub channel). Add a local agent session of THIS hub to the channel: one of your project, or a member of a Hub team you coordinate (its session id, e.g. from memory_team_status or memory_chat_agents). It can then read and write threads there, be mentioned, and appears in memory_chat_interhub_hubs as an agent of your hub; every hub sees its messages with your hub as origin. You stay your hub's only leader. Agents of other hubs are never added here: their own leader adds them.",
    z.object({ ...session, channel_id: id, session_id: z.string().min(8).max(200) }).strict()],
  chat_interhub_remove_local_agent: ["Leaders only. Remove a local agent you added to an inter-hub channel: it stops reading, writing and being mentioned there, its pending mentions from that channel are cancelled and the other hubs see it offline. History stays.",
    z.object({ ...session, channel_id: id, session_id: z.string().min(8).max(200) }).strict()],
  chat_interhub_hubs: ["List the hubs of an inter-hub channel you belong to, each with its leader and agents (leader first), connection and agent counts. Never includes the code.",
    z.object({ ...session, channel_id: id }).strict()],
  chat_interhub_escalate: ["Leaders only. When you ask your person something in your terminal, record it in the thread with memory_chat_send(kind='question'). If 5 minutes pass without an answer, call this with that message as question_message_id: the Hub asks the leader of ANOTHER hub (round robin in a stable order) to put the question to its own person and notifies that leader privately (it also sees it in pending_escalations of memory_chat_interhub_hubs). Every 5 minutes without resolution the Hub moves on to the next hub by itself, until a leader calls memory_chat_interhub_resolve_escalation; a resolved escalation never restarts. The persons never write in the channel: answers come back through the leaders.",
    z.object({ ...session, channel_id: id, thread_id: id, question_message_id: id }).strict()],
  chat_interhub_resolve_escalation: ["Leaders only. You received an escalation (private Hub notice, or pending_escalations of memory_chat_interhub_hubs), asked your own person in your terminal and have their answer; or your own person finally answered the question you escalated: mark it resolved so no more hubs are asked and every hub stops. Post the answer in the thread with memory_chat_send (reply_to the question) before or right after. Only the leader of a hub that belongs to the channel can resolve; resolving twice is harmless.",
    z.object({ ...session, channel_id: id, thread_id: id, escalation_id: id }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export const interhubOperations = Object.keys(interhubDefinitions)
export const interhubReadOperations = ["chat_interhub_hubs"]
const writes = new Set(["chat_interhub_create", "chat_interhub_join", "chat_interhub_code", "chat_interhub_add_local_agent", "chat_interhub_remove_local_agent", "chat_interhub_escalate", "chat_interhub_resolve_escalation"])
// Own keys only: inherited names such as "constructor" must never reach the dispatcher.
export const isInterhubOperation = (operation: string) => Object.hasOwn(interhubDefinitions, operation)

export class InterhubTools {
  constructor(private chat: LocalChat, private services: () => InterhubServices | undefined) {}
  private require() {
    const services = this.services()
    check(services, "Los canales entre hubs no están disponibles en este servicio.", 503)
    return services
  }
  async call(operation: string, raw: unknown, agent?: AgentContext) {
    const definition = Object.hasOwn(interhubDefinitions, operation) ? interhubDefinitions[operation as keyof typeof interhubDefinitions] : undefined
    check(definition, "Operación de canal entre hubs inexistente", 404)
    // The person never calls these: they act as the agent's session and the UI only reads through the routes.
    check(agent, "Los canales entre hubs se manejan desde la terminal de un agente; la persona los ve en la UI.", 403)
    const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
    const services = this.require()
    const caller = await this.chat.requireNickname(agent, input.session_key) as InterhubCaller
    check(!caller.closed_at, "La sesión de colaboración está cerrada", 403)
    const result = await this.run(services, operation, input, caller)
    if (writes.has(operation)) this.chat.events.emit("change")
    return result
  }
  private async run(services: InterhubServices, operation: string, input: any, caller: InterhubCaller) {
    switch (operation) {
      case "chat_interhub_create": return services.createChannel(caller, { name: input.name, projectId: input.project_id ?? null })
      case "chat_interhub_join": return services.joinChannel(caller, input.code, input.project_id ?? null)
      case "chat_interhub_code": return services.rotateCode(caller, input.channel_id, input.action)
      case "chat_interhub_add_local_agent": return services.localAgent(caller, input.channel_id, input.session_id, "add")
      case "chat_interhub_remove_local_agent": return services.localAgent(caller, input.channel_id, input.session_id, "remove")
      case "chat_interhub_hubs": {
        const roster = await services.roster(input.channel_id)
        check(roster && roster.hubs.some(hub => hub.is_local && hub.agents.some(agent => agent.id === caller.id)), "No sos parte de ese canal entre hubs.", 403)
        return { ...roster, pending_escalations: await services.pendingEscalations(input.channel_id) }
      }
      case "chat_interhub_escalate": return services.escalate(caller, input.channel_id, input.thread_id, input.question_message_id)
      case "chat_interhub_resolve_escalation": return services.resolveEscalation(caller, input.channel_id, input.thread_id, input.escalation_id)
    }
    throw new Error("unreachable")
  }
}
