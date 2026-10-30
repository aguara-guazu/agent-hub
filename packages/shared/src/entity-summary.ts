/**
 * `list_entities` con `include: ["summary"]` (operación de `POST /api/memory/call` y herramienta MCP
 * `memory_list_entities`): cada ítem suma `summary` con agregados calculados en lote para la página,
 * en un número fijo de consultas por página. Sin `include`, la respuesta no cambia.
 */

export type EntityListInclude = "summary"

/** Personas de un proyecto que viajan en el resumen; el total va en `people_count`. */
export const ENTITY_SUMMARY_PEOPLE = 5

export interface EntityRef {
  id: string
  kind: string
  title: string
}

export interface ProjectSummary {
  /** Empresa de `data.company_id`; `null` si no tiene o ya no existe. */
  company: { id: string; title: string } | null
  /**
   * Contenido enlazado al proyecto (enlace `project`, sin archivados), por tipo. `content_total` es
   * el mismo número que `total` de `list_entities { project_id }`.
   */
  content_by_kind: Record<string, number>
  content_total: number
  /**
   * Personas distintas enlazadas al proyecto o que participan (enlace `participant`) en contenido
   * del proyecto. Las primeras ENTITY_SUMMARY_PEOPLE, por cantidad de contenido compartido y título.
   */
  people: Array<{ id: string; title: string }>
  people_count: number
}

export interface FactSummary {
  /** Origen del hecho (enlace `derived_from`, o `data.source_entity_id`); `null` si se borró o no tiene. */
  source: EntityRef | null
}

/** `summary` de un ítem: solo trae la rama de su tipo; los demás tipos llevan `{}`. */
export interface EntitySummary {
  project?: ProjectSummary
  fact?: FactSummary
}
