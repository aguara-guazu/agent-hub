/**
 * MCP server de prueba con una herramienta destructiva: operaciones sobre servicios ficticios.
 *
 * Sirve para la prueba central del hub: apagar UNA herramienta y dejar el resto del
 * server prendida. `check_status` es inofensiva y tiene que seguir funcionando;
 * `restart_service` es la destructiva que se apaga desde el panel.
 *
 * EFECTO OBSERVABLE. Si `OPS_AUDIT_FILE` esta definida, cada llamada a
 * `restart_service` que llega DE VERDAD al upstream agrega una linea JSON a ese
 * archivo. Asi una prueba distingue "el gateway denego" de "la UI lo dibujo apagado
 * pero la llamada paso igual": si la herramienta esta apagada, el archivo no crece.
 * `check_status` no escribe nada, para que el archivo sea senal exclusiva de la
 * destructiva. La variable se lee en cada llamada, no al importar.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TestServer, ToolError } from './base.js'

export const SERVER_NAME = 'ops'
export const SERVER_VERSION = '1.0.0'
export const AUDIT_ENV_VAR = 'OPS_AUDIT_FILE'

const KNOWN_SERVICES = ['api', 'worker', 'db'] as const

export function createOpsServer(): TestServer {
  const restarts: Record<string, number> = Object.fromEntries(KNOWN_SERVICES.map((s) => [s, 0]))
  const server = new TestServer(
    SERVER_NAME,
    SERVER_VERSION,
    'Operaciones simuladas sobre servicios ficticios. Nada de esto toca infraestructura real.',
  )

  const appendAudit = (entry: Record<string, unknown>): void => {
    const target = process.env[AUDIT_ENV_VAR]
    if (!target) return
    mkdirSync(dirname(target), { recursive: true })
    // Claves ordenadas para que la línea sea determinista.
    const ordered = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
    appendFileSync(target, `${JSON.stringify(ordered)}\n`, 'utf-8')
  }

  server.tool({
    name: 'check_status',
    description: 'Devuelve el estado de un servicio ficticio. No modifica nada.',
    inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: (args) => {
      const service = String(args['service'] ?? '')
      if (service in restarts) {
        return { service, status: 'running', restarts: restarts[service] }
      }
      return { service, status: 'unknown', restarts: 0 }
    },
  })

  server.tool({
    name: 'restart_service',
    description: 'Reinicia un servicio ficticio. Es la herramienta destructiva del banco de pruebas.',
    inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: (args) => {
      const service = String(args['service'] ?? '')
      if (!service.trim()) throw new ToolError('Hay que indicar el nombre del servicio a reiniciar.')
      const count = (restarts[service] ?? 0) + 1
      restarts[service] = count
      appendAudit({ tool: 'restart_service', service, restarts: count })
      return `servicio ${service} reiniciado (reinicios: ${count})`
    },
  })

  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createOpsServer().runStdio()
}
