import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

/**
 * Lectura de los permisos entre proyectos y del registro de autoridad. Formas alineadas con
 * `packages/memory/src/chat-read-access.ts` (personReadGrants). El líder decide y revoca por MCP después de consultar
 * a la persona en su CLI; la UI no decide. Los errores los muestra quien llama.
 */

export interface ReadGrant { id: string; project_id: string; session_id: string; expires_at: string }

/** Fila de `GET /memory/chat/read-grants` (`personReadGrants`): `active=true` solo los no revocados; `false`, todos. */
export interface ReadGrantRow extends ReadGrant {
  request_id: string
  granted_by_user: string | null
  granted_by_session: string | null
  granted_by_label: string | null
  granted_at: string
  revoked_at: string | null
  revoke_reason: string | null
  session_label: string
  project_title: string
  reason: string
  confirmation_phrase: string | null
  person_instruction: string | null
}

/** Tipos de `chat_authority_events` (`AuthorityEventKind` de memory/chat-access.ts y `CHAT_WRAP_UP_EVENT_KINDS` de shared/collaboration.ts). */
export const AUTHORITY_KINDS = [
  "leadership_takeover", "leadership_kick", "leadership_reclaim", "leadership_rejected", "leadership_designated", "leadership_assigned",
  "session_kicked", "read_interest", "read_request", "read_elevated", "read_granted", "read_rejected", "read_revoked", "read_cancelled",
  "agents_cleaned", "channel_archive_proposed", "channel_archive_proposal_cancelled", "channel_archived", "channel_unarchived",
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

const AUDIT_LIMIT = 100

export function useReadGrants(enabled = true) {
  return useQuery({
    queryKey: ["memory", "chat", "read-grants", "all"],
    queryFn: () => api.get<Page<ReadGrantRow>>(`/memory/chat/read-grants?active=false&limit=${AUDIT_LIMIT}`),
    refetchInterval: 15_000,
    enabled,
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
