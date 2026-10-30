import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import type { Page } from "../../../lib/memory"
import type { Channel, Message, Thread } from "./chatTypes"

/**
 * Campos de lectura que colab-back suma a chat_channels / chat_threads / chat_read (packages/shared/src/collaboration.ts).
 * La colaboración es solo para ver: no hay escrituras de la persona. Todos son opcionales para tolerar un backend anterior.
 */
export type DebateState = "open" | "awaiting_decision" | "resolved"
export type MessageKind = "proposal" | "objection" | "fact" | "agreement" | "question"
export const MESSAGE_KINDS: readonly MessageKind[] = ["proposal", "objection", "fact", "agreement", "question"]

export interface BoardChannel extends Channel { description?: string | null; awaiting_decision?: number }

export interface BoardThread extends Thread { created_at?: string; agent_count?: number; debate_state?: DebateState }

export interface Resolution {
  id: string
  text: string
  state: "pending" | "approved" | "rerun" | "superseded"
  proposed_by_label?: string
  agreed_count: number
  participant_count: number
  created_at: string
}

export interface BoardMessage extends Message { kind?: MessageKind | null; author_source?: "agent" | "hub" | "person"; cli_kind?: string }
export type ThreadRead = Page<BoardMessage> & { thread: BoardThread; resolution?: Resolution | null }

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
