import { z } from "zod"
import type { InterhubRoster } from "@agenthub/shared"
import { check, id, parse } from "../contracts.js"
import type { AgentContext } from "../agents.js"
import type { LocalChat } from "../local-chat.js"

const session = { session_key: z.string().min(32).max(200).optional() }
// Length bounds only: the shape of a code is never described to a caller, so a wrong code fails like a revoked one.
const code = z.string().trim().min(1).max(512)

/** Session row of the calling agent, as resolved by the Hub from its session_key. Never built from tool input. */
export type InterhubCaller = Record<string, any> & { id: string; channel_id: string }

export type InterhubCodeAction = "regenerate" | "revoke"

/**
 * What the tools and routes need from the P2P replica (p2p-core) and the chat model (interhub-chat).
 * Every method re-checks authority with Hub data; the tool layer only validates input and resolves the caller.
 */
export interface InterhubServices {
  createChannel(caller: InterhubCaller, input: { name: string; project_id?: string | undefined }): Promise<{ channel_id: string; code: string }>
  joinChannel(caller: InterhubCaller, code: string): Promise<{ channel_id: string; hub_id: string }>
  rotateCode(caller: InterhubCaller, channelId: string, action: InterhubCodeAction): Promise<{ code?: string }>
  /** Null when the channel does not exist or is not an inter-hub channel. */
  roster(channelId: string): Promise<InterhubRoster | null>
  /** Plain code, only at the creator hub and only while not revoked; null otherwise. */
  creatorCode(channelId: string): Promise<string | null>
  escalate(caller: InterhubCaller, channelId: string, threadId: string, messageId: string): Promise<{ delegated_to_hub_id: string } | { no_other_hub: true }>
}

export const interhubDefinitions = {
  chat_interhub_create: ["Create an inter-hub channel: one channel shared by agents of several Agent Hubs, each hub with its own leader. Only after the person asks for it. You become your hub's leader in it. Returns channel_id and the join code ONCE: give the code to the person only in your terminal, never in a channel, thread, file or ticket. The code never expires and has no use limit; whoever holds it gets full trust, so regenerate or revoke it with memory_chat_interhub_code if it leaks.",
    z.object({ ...session, name: z.string().trim().min(1).max(200), project_id: id.optional() }).strict()],
  chat_interhub_join: ["Join an inter-hub channel with its code, only when the person gives you the code in your terminal and asks you to join. You must lead your own channel; you become your hub's leader in the inter-hub channel and receive orders from any person of any connected hub. A wrong, revoked or unknown code fails with the same error.",
    z.object({ ...session, code }).strict()],
  chat_interhub_code: ["Regenerate or revoke the join code of an inter-hub channel. Only the leader of the hub that created the channel. regenerate invalidates the previous code and returns the new one (never expires, no use limit); revoke invalidates it without a replacement, so nobody new can join. Hubs already joined keep their membership. Give a new code to the person only in your terminal.",
    z.object({ ...session, channel_id: id, action: z.enum(["regenerate", "revoke"]) }).strict()],
  chat_interhub_hubs: ["List the hubs of an inter-hub channel you belong to, each with its leader and agents (leader first), connection and agent counts. Never includes the code.",
    z.object({ ...session, channel_id: id }).strict()],
  chat_interhub_escalate: ["Leaders only. You asked your person something in your terminal and got no answer for 5 minutes: ask the leader of ANOTHER hub in the channel to put the question to its own person. The Hub picks that hub round robin and notifies its leader; if nobody answers, escalate again and the next hub is chosen. question_message_id is your message with the question. The persons never write in the channel: answers come back through the leaders.",
    z.object({ ...session, channel_id: id, thread_id: id, question_message_id: id }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export const interhubOperations = Object.keys(interhubDefinitions)
export const interhubReadOperations = ["chat_interhub_hubs"]
const writes = new Set(["chat_interhub_create", "chat_interhub_join", "chat_interhub_code", "chat_interhub_escalate"])
export const isInterhubOperation = (operation: string) => operation in interhubDefinitions

export class InterhubTools {
  constructor(private chat: LocalChat, private services: () => InterhubServices | undefined) {}
  private require() {
    const services = this.services()
    check(services, "Los canales entre hubs no están disponibles en este servicio.", 503)
    return services
  }
  async call(operation: string, raw: unknown, agent?: AgentContext) {
    const definition = interhubDefinitions[operation as keyof typeof interhubDefinitions]
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
      case "chat_interhub_create": return services.createChannel(caller, { name: input.name, project_id: input.project_id })
      case "chat_interhub_join": return services.joinChannel(caller, input.code)
      case "chat_interhub_code": return services.rotateCode(caller, input.channel_id, input.action)
      case "chat_interhub_hubs": {
        const roster = await services.roster(input.channel_id)
        check(roster && roster.hubs.some(hub => hub.is_local && hub.agents.some(agent => agent.id === caller.id)), "No sos parte de ese canal entre hubs.", 403)
        return roster
      }
      case "chat_interhub_escalate": return services.escalate(caller, input.channel_id, input.thread_id, input.question_message_id)
    }
    throw new Error("unreachable")
  }
}
