import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import type { Page } from "../../../lib/memory"
import type { Channel, Message, Thread } from "./chatTypes"
import type { InterhubAgentRole, InterhubMessageOrigin } from "./interhubData"

/**
 * Campos de lectura que colab-back suma a chat_channels / chat_threads / chat_read (packages/shared/src/collaboration.ts).
 * La colaboración es solo para ver: no hay escrituras de la persona. Todos son opcionales para tolerar un backend anterior.
 */
export type MessageKind = "proposal" | "objection" | "fact" | "agreement" | "question"
export const MESSAGE_KINDS: readonly MessageKind[] = ["proposal", "objection", "fact", "agreement", "question"]

/** `inactive`: 48 h sin uso y sin agentes conectados; `proposed`: 24 h después de que el líder propuso archivarlo. */
export type ArchiveCause = "inactive" | "proposed"

export interface BoardChannel extends Channel {
  description?: string | null
  hub_count?: number
  /** Solo los escribe el barrido del Hub; un canal archivado sale de la lista por defecto de chat_channels. */
  archived_at?: string | null
  archive_cause?: string | null
}

export function archiveCause(value: string | null | undefined): ArchiveCause | null {
  return value === "inactive" || value === "proposed" ? value : null
}

export interface BoardThread extends Thread { created_at?: string; agent_count?: number; hub_count?: number }

export interface BoardMessage extends Message {
  kind?: MessageKind | null
  author_source?: "agent" | "hub"
  cli_kind?: string
  // Solo los canales compartidos entre hubs traen origen y rol.
  origin_hub?: InterhubMessageOrigin | null
  author_role?: InterhubAgentRole | null
}
export type ThreadRead = Page<BoardMessage> & { thread: BoardThread }

export type ThreadState = "open" | "resolved"

export function messageKind(value: string | null | undefined): MessageKind | null {
  return MESSAGE_KINDS.find(kind => kind === value) ?? null
}

/** Selección de la pestaña en la URL (`?channel=`, `?thread=`, `?tstate=`): sobrevive a recargas y sirve de enlace desde Inicio. */
export function useBoardParams() {
  const [params, setParams] = useSearchParams()
  const patch = useCallback((values: Record<string, string | null>) => setParams(current => merge(current, values), { replace: true }), [setParams])
  const href = (values: Record<string, string | null>) => `?${merge(params, values).toString()}`
  return {
    channel: params.get("channel") ?? "",
    thread: params.get("thread") ?? "",
    state: (params.get("tstate") === "resolved" ? "resolved" : "open") as ThreadState,
    patch,
    href,
  }
}

function merge(current: URLSearchParams, values: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === "") next.delete(key)
    else next.set(key, value)
  }
  return next
}
