import { api, getToken } from "../../lib/api"

/**
 * `run_now` arranca una entrega en el acto y sin vuelta atrás: la llamada se difiere
 * hasta que vence el aviso con Deshacer. Viven fuera de React para sobrevivir al desmontaje; al desmontar la vista se envían
 * y en pagehide/beforeunload salen con `keepalive`.
 */
interface Pending { path: string; body: unknown; onDone?: (result: unknown) => void; onFail: (error: unknown) => void }

const pending = new Map<string, Pending>()

export function schedule(key: string, path: string, body: unknown, onFail: (error: unknown) => void, onDone?: (result: unknown) => void): void {
  pending.set(key, { path, body, onFail, ...(onDone ? { onDone } : {}) })
}

/** Deshacer: la llamada no llega a enviarse. */
export function cancel(key: string): boolean {
  return pending.delete(key)
}

export function isPending(key: string): boolean {
  return pending.has(key)
}

/** Idempotente: el aviso, el desmontaje y pagehide pueden llamarlo más de una vez. */
export async function commit(key: string): Promise<void> {
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  try {
    const result = await api.post(entry.path, entry.body)
    entry.onDone?.(result)
  } catch (error) {
    entry.onFail(error)
  }
}

export function commitAll(): Promise<void[]> {
  return Promise.all([...pending.keys()].map(key => commit(key)))
}

function flushOnPageHide(): void {
  const token = getToken()
  for (const entry of pending.values()) {
    void fetch(`/api${entry.path}`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(entry.body),
    })
  }
  pending.clear()
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOnPageHide)
  window.addEventListener("beforeunload", flushOnPageHide)
}
