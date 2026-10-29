import { api, getToken } from "../../lib/api"

interface Pending { id: string; onFail: (error: unknown) => void }

/** Borrados diferidos de skills: viven fuera de React para sobrevivir al desmontaje de la vista. */
const pending = new Map<string, Pending>()

export function scheduleDelete(id: string, onFail: (error: unknown) => void): void {
  pending.set(id, { id, onFail })
}

/** Deshacer: el DELETE no llega a enviarse. */
export function cancelDelete(id: string): boolean {
  return pending.delete(id)
}

/** Envía el DELETE si sigue pendiente; idempotente para que el toast, el desmontaje y pagehide no lo repitan. */
export async function commitDelete(id: string): Promise<void> {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  try {
    await api.delete(`/catalog/skills/${id}`)
  } catch (error) {
    entry.onFail(error)
  }
}

export function commitAll(): Promise<void[]> {
  return Promise.all([...pending.keys()].map(id => commitDelete(id)))
}

/** La página se cierra o se recarga: `keepalive` deja terminar la petición aunque el documento se descargue. */
function flushOnPageHide(): void {
  const token = getToken()
  for (const id of pending.keys()) {
    void fetch(`/api/catalog/skills/${id}`, { method: "DELETE", keepalive: true, headers: token ? { Authorization: `Bearer ${token}` } : {} })
  }
  pending.clear()
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOnPageHide)
  window.addEventListener("beforeunload", flushOnPageHide)
}
