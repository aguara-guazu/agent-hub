/**
 * Hashes canónicos del catálogo. Espeja `backend/agenthub/modules/catalog/hashing.py`.
 *
 * Un hash identifica una definición, no una fila: dos sondeos del mismo MCP server
 * producen el mismo valor aunque el orden de las claves del esquema cambie. Por eso
 * todo se serializa con claves ordenadas (JSON canónico).
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '@agenthub/shared'

/**
 * Motivo único de cuarentena por cambio de definición: la defensa contra el rug pull,
 * un server aprobado que después muta la descripción de una tool sin revisión.
 */
export const QUARANTINE_DEFINITION_CHANGED = 'la definicion cambio desde la ultima aprobacion'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * Hash de la definición visible de una herramienta. Entran los tres campos que el
 * modelo lee para decidir si la llama y con qué argumentos. `title` queda afuera: es
 * decoración de UI.
 */
export function definitionHash(
  name: string,
  description: string,
  inputSchema: Record<string, unknown> | null | undefined,
): string {
  return sha256(
    canonicalJson({
      name,
      description: description || '',
      input_schema: inputSchema ?? {},
    }),
  )
}

/** Hash del conjunto de herramientas de un server, insensible al orden. */
export function toolsHash(toolHashes: Iterable<string>): string {
  const unique = [...new Set(toolHashes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(canonicalJson(unique))
}

/** Hash del contenido de una skill; cambia cuando cambia lo que el agente lee. */
export function skillContentHash(displayName: string, description: string, body: string): string {
  return sha256(canonicalJson({ display_name: displayName, description, body }))
}
