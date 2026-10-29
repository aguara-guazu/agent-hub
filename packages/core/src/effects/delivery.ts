import { randomUUID } from 'node:crypto'
import { deliverDecisionByGmail, type DecisionStore, type DeliveryAdapters, type DeliveryReceipt, type ExclusionSink, type GmailSelfSender } from '@agenthub/memory'
import type { SlackSelfDelivery } from './slack-self.js'

/** Artefacto que el runtime del scheduler persistió para un run. `decision_request_ref` es el id opaco de la solicitud de decisión, si el artefacto propone acciones. */
export interface DeliveryArtifact { title: string; body_md: string; decision_request_ref: string | null }
export interface DeliveryArtifacts { load(input: { run_id: string; artifact_id: string }): Promise<DeliveryArtifact | null> }

export interface DeliveryDeps {
  store: DecisionStore
  artifacts: DeliveryArtifacts
  exclusions: ExclusionSink
  slack: SlackSelfDelivery
  /**
   * `connectorId` es la fuente de Google con el envío habilitado; `sendPending` describe una fuente que lee Gmail sin el envío habilitado,
   * con la cuenta que reportó la última sincronización, o null si no la hay o si ya existe una fuente con envío.
   */
  gmail: { sender: GmailSelfSender; connectorId(): Promise<string | null>; sendPending(): Promise<{ account: string | null } | null> }
}

const ROUTE: Record<'gmail_self' | 'slack_self', true> = { gmail_self: true, slack_self: true }

/**
 * Entrega por canal propio: Gmail a la cuenta conectada y Slack al mensaje directo del usuario. Con solicitud de decisión usa el outbox durable
 * y agrega el código al pie; sin ella envía el resumen como mensaje de control excluido de la ingesta. El destino nunca viene del llamador.
 */
export function createDeliveryAdapters(deps: DeliveryDeps): DeliveryAdapters {
  const { store, gmail, slack } = deps

  async function gmailPlain(connectorId: string, artifact: DeliveryArtifact): Promise<DeliveryReceipt> {
    const status = await gmail.sender.status(connectorId)
    if (status.state !== 'ok') return { state: 'failed', error_code: status.state }
    const messageId = `<hub-${randomUUID()}@agent-hub.invalid>`
    try { await deps.exclusions.add([{ integration: 'gmail', account: status.account, kind: 'rfc_message_id', native_id: messageId }]) } catch { return { state: 'failed', error_code: 'exclusion_not_recorded' } }
    const outcome = await gmail.sender.send(connectorId, { message_id: messageId, subject: artifact.title, text: artifact.body_md }, status.account)
    if (outcome.state === 'failed') return { state: 'failed', error_code: outcome.reason }
    if (outcome.state === 'uncertain') return { state: 'uncertain', error_code: outcome.reason }
    try { await deps.exclusions.add([{ integration: 'gmail', account: status.account, kind: 'message', native_id: outcome.native_id },
      ...(outcome.thread_id ? [{ integration: 'gmail' as const, account: status.account, kind: 'thread' as const, native_id: outcome.thread_id }] : [])]) } catch { return { state: 'sent', error_code: 'exclusion_not_recorded' } }
    return { state: 'sent' }
  }

  return {
    async available() {
      const connectorId = await gmail.connectorId()
      const mail = connectorId ? await gmail.sender.status(connectorId) : null
      const pending = connectorId ? null : await gmail.sendPending()
      const chat = await slack.available()
      return {
        gmail_self: mail ? mail.state === 'ok' ? { available: true, destination: mail.account } : { available: false, reason: mail.state }
          : pending ? { available: false, reason: 'scope_missing', ...(pending.account ? { destination: pending.account } : {}) } : { available: false, reason: 'not_connected' },
        slack_self: chat.available ? { available: true } : { available: false, reason: chat.reason },
      }
    },

    async executeDelivery(input) {
      if (!ROUTE[input.target]) return { state: 'failed', error_code: 'target_not_allowed' }
      const artifact = await deps.artifacts.load({ run_id: input.run_id, artifact_id: input.artifact_id })
      if (!artifact) return { state: 'failed', error_code: 'artifact_missing' }
      const text = `${artifact.title}\n\n${artifact.body_md}`
      const requestId = artifact.decision_request_ref
      if (input.target === 'gmail_self') {
        const connectorId = await gmail.connectorId()
        if (!connectorId) return { state: 'failed', error_code: 'not_connected' }
        return requestId ? deliverDecisionByGmail({ store, sender: gmail.sender }, { request_id: requestId, connector_id: connectorId, subject: artifact.title, text: artifact.body_md }) : gmailPlain(connectorId, artifact)
      }
      return requestId ? slack.deliver({ request_id: requestId, text }) : slack.deliverPlain({ text })
    },
  }
}
