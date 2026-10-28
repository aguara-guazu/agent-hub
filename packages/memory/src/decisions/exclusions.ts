import type { Sql } from '../database.js'
import type { Exclusion, ExclusionSink, Integration } from './contract.js'

/** Cabecera propia de los mensajes de control del hub: un mensaje con ella nunca se ingiere, aunque falte su tombstone. */
export const CONTROL_HEADER = 'x-agent-hub-control'

/**
 * Tombstones no secretos de los mensajes de control, en `decision_exclusions` de la base de la memoria (entra en el respaldo).
 * El almacén de decisiones los escribe ANTES de enviar y el gate de los conectores los consulta ANTES de leer adjuntos, guardar o indexar.
 */
export class MemoryExclusionSink implements ExclusionSink {
  constructor(private readonly db: Sql) {}

  async add(entries: Exclusion[]): Promise<void> {
    for (const entry of entries) {
      await this.db.query('INSERT INTO decision_exclusions(integration, account, kind, native_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [entry.integration, entry.account.toLowerCase(), entry.kind, entry.native_id])
    }
  }
}

/**
 * ¿Alguna de estas referencias pertenece a un mensaje de control? Falla cerrado: si la consulta no puede responder, lanza y la ingesta
 * se detiene en lugar de importar sin clasificar. `account` es obligatoria en Gmail (los ids son del buzón) y se omite en Slack
 * (los ids de conversación son únicos en el espacio de trabajo).
 */
export async function isExcludedAny(db: Sql, integration: Integration, account: string | null, refs: ReadonlyArray<Pick<Exclusion, 'kind' | 'native_id'>>): Promise<boolean> {
  if (!refs.length) return false
  const keys = refs.map(ref => `${ref.kind}:${ref.native_id}`)
  const rows = await db.query(`SELECT 1 AS hit FROM decision_exclusions WHERE integration = $1 AND ($2 IS NULL OR account = $2)
    AND (kind || ':' || native_id) IN (SELECT value FROM json_each($3)) LIMIT 1`, [integration, account === null ? null : account.toLowerCase(), JSON.stringify(keys)])
  return rows.length > 0
}

/** Identificadores RFC 5322 (`<...>`) citados en In-Reply-To y References. */
export function referencedMessageIds(...headers: Array<string | undefined>): string[] {
  return [...new Set(headers.flatMap(value => value?.match(/<[^<>\s]{1,998}>/g) ?? []))]
}
