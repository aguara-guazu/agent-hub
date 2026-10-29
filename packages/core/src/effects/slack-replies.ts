import { resultText, type CallResult } from '@agenthub/gateway'
import { verifySlackReply, type DecisionService, type DecisionStore, type SlackEvidence } from '@agenthub/memory'
import { EffectToolDenied, type EffectToolResolver } from './tools.js'

const READ_THREAD = 'slack_read_thread'

export interface SlackPollResult {
  inspected: number
  consumed: number
  /** Motivos por mensaje; nunca incluye contenido. */
  rejected: Record<string, number>
}

/**
 * Mensajes de un hilo según `slack_read_thread`. Solo se acepta una lista estructurada (`messages`); si la respuesta no la trae no hay evidencia
 * y, por tanto, ninguna aprobación. El formato exacto no está verificado contra un MCP real.
 */
export function parseSlackThread(result: CallResult, channel: string): SlackEvidence[] {
  if (result.is_error) return []
  let data: any = result.structured_content
  if (!data) { try { data = JSON.parse(resultText(result)) } catch { return [] } }
  const messages: unknown = Array.isArray(data) ? data : data?.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((raw: any) => {
    if (!raw || typeof raw.ts !== 'string' || typeof raw.text !== 'string') return []
    return [{ channel: typeof raw.channel === 'string' ? raw.channel : channel, ts: raw.ts, ...(typeof raw.thread_ts === 'string' ? { thread_ts: raw.thread_ts } : {}),
      ...(typeof raw.user === 'string' ? { user: raw.user } : {}), ...(typeof raw.team === 'string' ? { team: raw.team } : {}), ...(raw.bot_id ? { bot_id: String(raw.bot_id) } : {}),
      ...(raw.app_id ? { app_id: String(raw.app_id) } : {}), ...(typeof raw.subtype === 'string' ? { subtype: raw.subtype } : {}), ...(raw.hidden === true ? { hidden: true } : {}),
      ...(raw.edited ? { edited: raw.edited } : {}), text: raw.text }]
  })
}

/**
 * Lee el hilo de entrega de cada solicitud con binding de Slack activo, con la identidad `hub_effects`, y entrega las respuestas verificadas al servicio de
 * decisiones. El verificador exige DM fijado, mismo usuario y equipo, respuesta en el hilo de la entrega y mensaje sin bot, edición ni subtipo.
 */
export async function pollSlackReplies(deps: { store: DecisionStore; service: DecisionService; tools: EffectToolResolver }): Promise<SlackPollResult> {
  const { store, service } = deps
  const result: SlackPollResult = { inspected: 0, consumed: 0, rejected: {} }
  const reject = (reason: string) => { result.rejected[reason] = (result.rejected[reason] ?? 0) + 1 }
  const bindings = store.openBindings('slack')
  if (!bindings.length) return result
  const candidates = deps.tools.candidates([READ_THREAD])
  if (candidates.length !== 1) { reject(candidates.length ? 'ambiguous_server' : 'tool_off'); return result }
  const tools = deps.tools.forServer(candidates[0]!)
  for (const open of bindings) {
    const view = store.bindingsOf(open.request_id).find(binding => binding.id === open.binding_id)
    if (!view?.conversation || !view.delivery_ref) { reject('binding_incomplete'); continue }
    const binding = { channel: view.conversation, team: view.team, userId: view.remote_user, deliveryTs: view.delivery_ref, hubTs: view.native_ids }
    let thread: SlackEvidence[]
    try { thread = parseSlackThread(await tools.call(READ_THREAD, { channel_id: view.conversation, message_ts: view.delivery_ref }), view.conversation) } catch (error) {
      reject(error instanceof EffectToolDenied ? 'tool_off' : 'fetch_failed'); continue
    }
    for (const evidence of thread) {
      result.inspected++
      const verdict = verifySlackReply(evidence, binding)
      if (!verdict.ok) { reject(verdict.reason); continue }
      const outcome = await service.processReply({ integration: 'slack', account: open.account, native_message_id: evidence.ts, binding_id: open.binding_id, parsed: verdict.parsed })
      if (outcome.gated) { reject('authority_unavailable'); continue }
      if (outcome.value.outcome === 'approved' || outcome.value.outcome === 'rejected' || outcome.value.outcome === 'revision_requested') result.consumed++
    }
  }
  return result
}
