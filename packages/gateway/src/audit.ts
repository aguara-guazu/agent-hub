/**
 * Reporte de invocaciones al control plane: la auditoria del gateway.
 *
 * Cada `tools/call` (permitido, denegado o con error del upstream) deja una linea en
 * el ledger del control plane con su decision, su motivo y un DIGEST de los argumentos
 * —nunca los argumentos. El cuerpo coincide con el `ToolCallRequest` del API.
 *
 * El reporte no puede tumbar la llamada: un fallo de red al reportar se traga (el
 * `GatewayServer` ya envuelve la llamada al reporter en un try/catch), pero ademas se
 * aplica un timeout corto para que un control plane lento no cuelgue la invocacion.
 */

import type { ToolCallRecord, ToolCallReporter } from './server.js'

export const DEFAULT_REPORT_PATH = '/sync/tool-call'
export const DEFAULT_REPORT_TIMEOUT_MS = 5_000

export interface HttpReporterOptions {
  baseUrl: string
  token: string
  path?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function toPayload(record: ToolCallRecord): Record<string, unknown> {
  return {
    agent_id: record.agent_id,
    server_slug: record.server_slug,
    tool_name: record.tool_name,
    exposed_name: record.exposed_name,
    decision: record.decision,
    denial_reason: record.denial_reason,
    args_digest: record.args_digest,
    duration_ms: record.duration_ms,
    error: record.error,
  }
}

/** Un reporter que hace POST del registro al control plane. */
export function httpReporter(options: HttpReporterOptions): ToolCallReporter {
  const base = options.baseUrl.replace(/\/+$/, '')
  const path = options.path ?? DEFAULT_REPORT_PATH
  const url = `${base}${path}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? fetch
  return async (record: ToolCallRecord): Promise<void> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(toPayload(record)),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Reporter en memoria, util para pruebas: guarda cada registro en un arreglo. */
export function collectingReporter(sink: ToolCallRecord[]): ToolCallReporter {
  return async (record: ToolCallRecord): Promise<void> => {
    sink.push(record)
  }
}
