/**
 * MCP server de prueba que falla a pedido: timeouts y aislamiento de fallos.
 *
 * Comprueba que un upstream roto o lento no se lleva puesto al resto del gateway: el
 * resto de los servers sigue respondiendo mientras este falla o se cuelga.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { TestServer, ToolError } from './base.js'

export const SERVER_NAME = 'flaky'
export const SERVER_VERSION = '1.0.0'
export const MAX_SLEEP_SECONDS = 300

export function createFlakyServer(): TestServer {
  const server = new TestServer(
    SERVER_NAME,
    SERVER_VERSION,
    'Fallas simuladas para probar timeouts y aislamiento. Ninguna herramienta hace trabajo util.',
  )

  server.tool({
    name: 'always_fails',
    description: 'Falla siempre. Devuelve un error de herramienta con el motivo indicado.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: (args) => {
      throw new ToolError(`always_fails: ${String(args['reason'] ?? 'falla simulada')}`)
    },
  })

  server.tool({
    name: 'slow',
    description: 'Duerme la cantidad de segundos indicada y despues responde.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } },
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (args) => {
      const seconds = Number(args['seconds'] ?? 1)
      if (seconds < 0) throw new ToolError('El tiempo de espera no puede ser negativo.')
      if (seconds > MAX_SLEEP_SECONDS) throw new ToolError(`El tiempo de espera maximo es de ${MAX_SLEEP_SECONDS} segundos.`)
      await delay(seconds * 1000)
      return `dormi ${seconds} segundos`
    },
  })

  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createFlakyServer().runStdio()
}
