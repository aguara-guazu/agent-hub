import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useToast } from "../components/ui/Toast"
import { useT } from "../i18n/useT"
import { errorKey } from "../i18n/errors"
import { api } from "./api"
import { memoryCall, type MemoryEntity, type Page } from "./memory"

export type { MemoryEntity, Page }

/** Tipos de entidad que la API devuelve en `kind`. */
export const ENTITY_KINDS = ["meeting", "document", "note", "message", "issue", "event", "person", "company", "project", "collection", "fact"] as const
export type EntityKind = typeof ENTITY_KINDS[number]

export function isEntityKind(value: string | null | undefined): value is EntityKind {
  return Boolean(value) && (ENTITY_KINDS as readonly string[]).includes(value!)
}

/** Fragmento citado tal como lo devuelven `search`, `transcript`, `get_entity.evidence` y `get_evidence`. */
export interface Fragment {
  id: string
  entity_id: string
  version_id: string
  ordinal: number
  text: string
  title?: string
  kind?: string
  provider?: string | null
  speaker_id?: string | null
  speaker_name?: string | null
  speaker_email?: string | null
  start_time?: string | null
  offset_ms?: number | null
  occurred_at?: string | null
  project_ids?: string[]
  metadata: Record<string, any>
  current?: boolean
  url?: string | null
}

export interface SearchPage extends Page<Fragment> { semantic_status?: "ready" | "unavailable" | "not_requested"; exhaustive?: boolean }

export interface EntityLink { id: string; type: string; from_id: string; to_id: string; entity: MemoryEntity }
export interface EntitySource { id: string; provider: string; status: string; url?: string | null; external_id: string; current_version_id: string; version_count: number }
export interface EntityChange { id: number | string; action: string; actor: string; created_at: string }
export interface EntityDetail { entity: MemoryEntity; links: EntityLink[]; sources: EntitySource[]; evidence: Fragment[]; changes: EntityChange[] }
export interface SourceVersion { id: string; created_at: string; metadata?: { attachment?: StoredFile } & Record<string, any> }
export interface StoredFile { filename: string; mime_type: string; size: number }
export interface Speaker { id: string; title: string; email: string | null; email_status: string | null; fragments: number }
export interface TranscriptPage extends Page<Fragment> { speakers: Speaker[] }

export const memoryKey = (operation: string, input: unknown = {}) => ["memory", operation, input] as const

/** Lectura de la memoria. Sondea cada 5 s porque los agentes escriben mientras la vista está abierta. */
export function useMemoryQuery<T>(operation: string, input: unknown = {}, enabled = true) {
  return useQuery({
    queryKey: memoryKey(operation, input),
    queryFn: () => memoryCall<T>(operation, input),
    enabled,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
}

/** Lista con carga progresiva por `offset`. Sin sondeo: refrescar todas las páginas cada 5 s sería caro. */
export function useMemoryPages<T>(operation: string, input: Record<string, unknown>, limit: number, enabled = true, initialOffset = 0) {
  return useInfiniteQuery({
    queryKey: ["memory", operation, "pages", input, limit, initialOffset],
    queryFn: ({ pageParam }) => memoryCall<Page<T> & Record<string, any>>(operation, { ...input, limit, offset: pageParam }),
    initialPageParam: initialOffset,
    getNextPageParam: last => (last.offset + last.items.length < last.total && last.items.length > 0 ? last.offset + last.items.length : undefined),
    getPreviousPageParam: first => (first.offset > 0 ? Math.max(0, first.offset - limit) : undefined),
    enabled,
    refetchOnWindowFocus: true,
  })
}

/** Escritura en la memoria: invalida las lecturas y avisa los errores con el texto traducido. */
export function useMemoryAction<T = any>(operation: string, onSuccess?: (data: T, input: any) => void) {
  const cache = useQueryClient(), toast = useToast(), { t } = useT("errors")
  return useMutation({
    mutationFn: (input: unknown) => memoryCall<T>(operation, input),
    onSuccess: (data, input) => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      void cache.invalidateQueries({ queryKey: ["memory-status"] })
      onSuccess?.(data, input)
    },
    onError: error => toast.error(t(errorKey(error)), error instanceof Error ? error.message : undefined),
  })
}

export interface MemoryStatus { ready: boolean; state?: string; detail?: string; migration?: { total?: number; copied?: number; error?: string; next_attempt_at?: string } }

export function useMemoryReady() {
  return useQuery({
    queryKey: ["memory-status"],
    queryFn: () => api.get<MemoryStatus>("/memory/status"),
    refetchInterval: query => (query.state.data?.state === "migrating" ? 2000 : 10000),
  })
}

export function useRetryMigration() {
  const cache = useQueryClient()
  return useMutation({ mutationFn: () => api.post("/memory/migration/retry"), onSuccess: () => void cache.invalidateQueries({ queryKey: ["memory-status"] }) })
}

export function entityHref(entity: { id: string; kind?: string }): string {
  return entity.kind === "project" ? `/projects/${entity.id}` : `/memory/entities/${entity.id}`
}

export function fragmentHref(fragment: Pick<Fragment, "entity_id" | "version_id" | "id">): string {
  return `/memory/entities/${fragment.entity_id}?tab=content&version=${fragment.version_id}&fragment=${fragment.id}`
}

/** Minuto dentro de la fuente («23:41») o `null` si el fragmento no tiene posición temporal. */
export function fragmentOffset(fragment: Pick<Fragment, "offset_ms">): string | null {
  if (fragment.offset_ms === null || fragment.offset_ms === undefined) return null
  const seconds = Math.floor(fragment.offset_ms / 1000)
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60, rest = seconds % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, "0"), ss = String(rest).padStart(2, "0")
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Partes de `text` que coinciden con algún término de `query` (≥ 3 letras), para resaltarlas con `<mark>`. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = query.trim().split(/\s+/).filter(term => term.length >= 3).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (!terms.length) return [{ text, match: false }]
  // Con un grupo de captura, `split` alterna texto y coincidencia: los índices impares son coincidencias.
  return text.split(new RegExp(`(${terms.join("|")})`, "iu")).map((part, index) => ({ text: part, match: index % 2 === 1 })).filter(part => part.text)
}

/** Recorta un texto largo alrededor de la primera coincidencia para que la cita la muestre. */
export function excerpt(text: string, query: string, size = 260): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= size) return clean
  const term = query.trim().split(/\s+/).find(word => word.length >= 3)
  const at = term ? clean.toLowerCase().indexOf(term.toLowerCase()) : -1
  if (at < size / 2) return `${clean.slice(0, size)}…`
  const start = Math.max(0, at - Math.floor(size / 3))
  return `…${clean.slice(start, start + size)}…`
}
