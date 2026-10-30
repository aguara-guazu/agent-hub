import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "./api"

/**
 * Pedidos de lectura entre proyectos que un líder elevó a la persona. Formas alineadas con
 * `packages/memory/src/chat-read-access.ts` (personReadRequests, confirmReadRequest). Solo rutas de la persona;
 * ninguna existe como herramienta de agente. Los errores los muestra quien llama.
 */

export type ReadRequestState = "pending_leader" | "pending_person" | "granted" | "rejected" | "cancelled"

export interface ReadRequest {
  id: string
  state: ReadRequestState
  reason: string
  created_at: string
  elevated_at: string | null
  elevation_note: string | null
  requester_session_id: string
  requester_nickname: string | null
  requester_label: string
  requester_project_id: string | null
  requester_project_title: string | null
  target_project_id: string
  target_project_title: string
  elevated_by: string | null
  elevated_by_label: string | null
}

export interface ReadGrant { id: string; project_id: string; session_id: string; expires_at: string }

/** Fila de `GET /memory/chat/read-grants` (`personReadGrants`): `active=true` solo los no revocados; `false`, todos. */
export interface ReadGrantRow extends ReadGrant {
  request_id: string
  granted_by_user: string
  granted_at: string
  revoked_at: string | null
  revoke_reason: string | null
  session_label: string
  project_title: string
  reason: string
  confirmation_phrase: string | null
}

/** Tipos de `chat_authority_events` (`AuthorityEventKind` de memory/chat-access.ts). */
export const AUTHORITY_KINDS = [
  "leadership_takeover", "leadership_kick", "leadership_reclaim", "leadership_rejected", "leadership_designated",
  "read_interest", "read_request", "read_elevated", "read_granted", "read_rejected", "read_revoked", "read_cancelled",
] as const
export type AuthorityKind = typeof AUTHORITY_KINDS[number]

export function isAuthorityKind(value: string): value is AuthorityKind {
  return (AUTHORITY_KINDS as readonly string[]).includes(value)
}

/** Fila de `GET /memory/chat/authority-events`; registro de solo agregado, de más nuevo a más viejo. */
export interface AuthorityEventRow {
  seq: number
  id: string
  kind: string
  channel_id: string | null
  project_id: string | null
  actor_session_id: string | null
  actor_user_id: string | null
  target_session_id: string | null
  reason: string
  /** Columna JSON: puede llegar como texto. */
  evidence: Record<string, unknown> | string | null
  created_at: string
  actor_label: string | null
  target_label: string | null
  channel_name: string | null
  project_title: string | null
}

interface Page<T> { items: T[]; total: number; limit: number; offset: number }

/** Códigos cerrados de `POST /memory/chat/read-requests/:id/confirm`. */
export type ReadGrantErrorCode = "phrase_structure" | "phrase_target" | "phrase_requester" | "request_not_pending" | "requester_inactive"
const CODES = new Set<string>(["phrase_structure", "phrase_target", "phrase_requester", "request_not_pending", "requester_inactive"])

export function readGrantErrorCode(error: unknown): ReadGrantErrorCode | null {
  return error instanceof ApiError && error.code && CODES.has(error.code) ? error.code as ReadGrantErrorCode : null
}

/** Una decisión cambia pedidos, permisos y el registro de autoridad a la vez. */
function invalidateAccess(cache: ReturnType<typeof useQueryClient>) {
  return Promise.all(["read-requests", "read-grants", "authority-events"].map(part => cache.invalidateQueries({ queryKey: ["memory", "chat", part] })))
}

const pendingKey = ["memory", "chat", "read-requests", "pending_person"] as const

export function usePendingReadRequests() {
  return useQuery({
    queryKey: pendingKey,
    queryFn: () => api.get<Page<ReadRequest>>("/memory/chat/read-requests?state=pending_person&limit=50"),
    refetchInterval: 15_000,
  })
}

export function useConfirmReadRequest() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ id, phrase }: { id: string; phrase: string }) =>
      api.post<{ request_id: string; state: "granted"; grant: ReadGrant }>(`/memory/chat/read-requests/${encodeURIComponent(id)}/confirm`, { phrase }),
    onSettled: () => invalidateAccess(cache),
  })
}

export function useRejectReadRequest() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post<{ request_id: string; state: "rejected" }>(`/memory/chat/read-requests/${encodeURIComponent(id)}/reject`, {}),
    onSettled: () => invalidateAccess(cache),
  })
}

const AUDIT_LIMIT = 100

export function useReadGrants(enabled = true) {
  return useQuery({
    queryKey: ["memory", "chat", "read-grants", "all"],
    queryFn: () => api.get<Page<ReadGrantRow>>(`/memory/chat/read-grants?active=false&limit=${AUDIT_LIMIT}`),
    refetchInterval: 15_000,
    enabled,
  })
}

/** Irreversible: el agente pierde la lectura en el acto y tiene que volver a pedirla. */
export function useRevokeReadGrant() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.post<{ grant_id: string; revoked: true }>(`/memory/chat/read-grants/${encodeURIComponent(id)}/revoke`, {}),
    onSettled: () => Promise.all([
      cache.invalidateQueries({ queryKey: ["memory", "chat", "read-grants"] }),
      cache.invalidateQueries({ queryKey: ["memory", "chat", "authority-events"] }),
    ]),
  })
}

export function useAuthorityEvents(filter: { kind?: AuthorityKind | undefined; project_id?: string | undefined }, enabled = true) {
  const params = new URLSearchParams({ limit: String(AUDIT_LIMIT) })
  if (filter.kind) params.set("kind", filter.kind)
  if (filter.project_id) params.set("project_id", filter.project_id)
  return useQuery({
    queryKey: ["memory", "chat", "authority-events", filter.kind ?? "", filter.project_id ?? ""],
    queryFn: () => api.get<Page<AuthorityEventRow>>(`/memory/chat/authority-events?${params.toString()}`),
    refetchInterval: 15_000,
    enabled,
  })
}
