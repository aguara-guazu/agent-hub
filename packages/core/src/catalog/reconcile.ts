/**
 * Reconciliación de las herramientas descubiertas en un sondeo. Espeja
 * `backend/agenthub/modules/catalog/__init__.py`.
 *
 * Protege del rug pull: un server aprobado que después cambia la definición de una tool
 * no se vuelve a exponer solo, queda en cuarentena hasta que su dueño la revise. Un
 * fallo de conexión no borra nada: guarda `last_probe_error` y deja las tools como
 * estaban, porque un server caído no es un server sin herramientas.
 */
import { QUARANTINE_DEFINITION_CHANGED, definitionHash, toolsHash } from '../hashing.js'
import { buildExposedName } from '../naming.js'
import type { ProbeResult } from './probe.js'
import type { Store } from '../store.js'
import type { McpServerRow } from '../types.js'

/** La herramienta desapareció del server. No se borra la fila: borrarla tiraría las
 *  reglas de exposición que la apuntan. */
export const QUARANTINE_TOOL_MISSING = 'el server dejo de ofrecer esta herramienta'

export interface SyncOutcome {
  added: string[]
  updated: string[]
  missing: string[]
  quarantined: string[]
}

export function applyProbeResult(store: Store, server: McpServerRow, result: ProbeResult): SyncOutcome {
  const outcome: SyncOutcome = { added: [], updated: [], missing: [], quarantined: [] }

  if (!result.ok) {
    store.updateServer(server.id, { last_probe_error: result.error })
    return outcome
  }

  const existing = new Map(store.toolsOfServer(server.id).map((tool) => [tool.name, tool]))
  const taken = store.takenExposedNames(server.user_id, server.id)
  for (const tool of existing.values()) if (tool.exposed_name) taken.add(tool.exposed_name)

  const seen = new Set<string>()
  for (const discovered of result.tools) {
    seen.add(discovered.name)
    const newHash = definitionHash(discovered.name, discovered.description, discovered.input_schema)
    const tool = existing.get(discovered.name)

    if (!tool) {
      const exposed = buildExposedName(server.slug, discovered.name, taken)
      taken.add(exposed)
      store.insertTool({
        server_id: server.id,
        name: discovered.name,
        exposed_name: exposed,
        title: discovered.title,
        description: discovered.description,
        input_schema: discovered.input_schema,
        definition_hash: newHash,
      })
      outcome.added.push(discovered.name)
      continue
    }

    const patch: Record<string, unknown> = {}
    let quarantined = tool.quarantined
    let quarantineReason = tool.quarantine_reason

    if (tool.definition_hash && tool.definition_hash !== newHash) {
      quarantined = true
      quarantineReason = QUARANTINE_DEFINITION_CHANGED
      outcome.quarantined.push(discovered.name)
    } else if (tool.quarantined && tool.quarantine_reason === QUARANTINE_TOOL_MISSING) {
      // Volvió con la misma definición ya aprobada: la ausencia se terminó.
      quarantined = false
      quarantineReason = ''
    }

    const changed =
      tool.title !== discovered.title ||
      tool.description !== discovered.description ||
      JSON.stringify(tool.input_schema ?? {}) !== JSON.stringify(discovered.input_schema) ||
      tool.definition_hash !== newHash
    if (changed) outcome.updated.push(discovered.name)

    patch.title = discovered.title
    patch.description = discovered.description
    patch.input_schema = discovered.input_schema
    patch.definition_hash = newHash
    patch.quarantined = quarantined
    patch.quarantine_reason = quarantineReason
    if (!tool.exposed_name) {
      const exposed = buildExposedName(server.slug, tool.name, taken)
      taken.add(exposed)
      patch.exposed_name = exposed
    }
    store.updateTool(tool.id, patch)
  }

  for (const [name, tool] of existing) {
    if (seen.has(name)) continue
    outcome.missing.push(name)
    if (!tool.quarantined) {
      store.updateTool(tool.id, { quarantined: true, quarantine_reason: QUARANTINE_TOOL_MISSING })
    }
  }

  const definitionHashes = result.tools.map((tool) => definitionHash(tool.name, tool.description, tool.input_schema))
  // Conectó: el error del sondeo anterior ya no describe el estado del server.
  store.updateServer(server.id, { definition_hash: toolsHash(definitionHashes), last_probe_error: '' })
  return outcome
}
