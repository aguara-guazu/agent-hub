import type { AttentionLine, AttentionReaders, DecisionItemKind, DecisionService, DecisionStore } from '@agenthub/memory'

/** Hasta dónde mira atrás el arrastre: lo que una solicitud vencida dejó sin despachar más allá de esta ventana ya no se ofrece. */
const CARRYOVER_WINDOW_MS = 4 * 24 * 3_600_000
const CARRYOVER_LIMIT = 20

/** Línea con el tipo de acción fuera del efecto: el efecto de un push es exactamente el que parsea su adaptador. */
export type CarryoverLine = AttentionLine & { kind: DecisionItemKind }

export interface DecisionAttentionOptions {
  resolve(): Promise<{ store: DecisionStore; service: DecisionService; db: { query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]> } }>
}

const plural = (n: number) => `${n} ${n === 1 ? 'ítem' : 'ítems'}`
const when = (iso: string) => new Date(iso).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * Lectores del brief y del cierre sobre el almacén de decisiones. Solo salen títulos, conteos, fechas y los efectos que la persona ya vio; ninguna línea lleva
 * el código de la solicitud, su digest ni texto de un canal. Se releen en cada run: no guardan nada entre llamadas.
 */
export function createDecisionAttention(options: DecisionAttentionOptions): Required<Pick<AttentionReaders, 'pending_responses' | 'carryover_items'>> {
  return {
    /** Solicitudes abiertas con ítems por decidir y con autoridad vigente (una que ya no se puede responder no es un pedido pendiente). */
    async pending_responses() {
      const { store, service } = await options.resolve()
      const lines: AttentionLine[] = []
      for (const request of store.awaitingReply()) {
        if (!(await service.live(request.request_id))) continue
        lines.push({ ref: request.run_id, summary: `Decisión pendiente: ${plural(request.pending)} por aprobar (vence ${when(request.expires_at)})`, at: request.created_at,
          ...(request.project_ids.length === 1 ? { project_id: request.project_ids[0]! } : {}) })
      }
      return lines
    },
    /**
     * Lo que el cierre propuso y no salió: ítems vencidos sin intención y aprobados cuya intención venció antes de despachar. Solo de solicitudes de un cierre, de modo que
     * lo arrastrado una vez al brief no vuelve a arrastrarse. El efecto es la copia guardada, sin reinterpretar.
     */
    async carryover_items() {
      const { store, db } = await options.resolve()
      const candidates = store.carryoverItems(new Date(store.clock().getTime() - CARRYOVER_WINDOW_MS).toISOString(), CARRYOVER_LIMIT)
      if (!candidates.length) return []
      const runs = [...new Set(candidates.map(item => item.run_id))]
      const closes = new Set((await db.query<{ run_id: string }>('SELECT run_id FROM schedule_artifacts WHERE kind = \'close\' AND run_id IN (SELECT value FROM json_each($1))', [JSON.stringify(runs)])).map(row => row.run_id))
      return candidates.filter(item => closes.has(item.run_id)).map((item): CarryoverLine => ({ ref: item.run_id, summary: item.summary, at: item.expires_at, project_id: item.project_id, effect: item.effect, kind: item.kind }))
    },
  }
}
