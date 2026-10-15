import { setTimeout as sleep } from 'node:timers/promises'

/** Bound the entire handshake, including response bodies and retries. */
export async function waitForDesktopSession(baseUrl: string, bootstrap: string, failed: () => boolean,
  timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'core no disponible'
  while (Date.now() < deadline) {
    if (failed()) throw new Error(`el core se cerró al arrancar y no se pudo reiniciar (${lastError})`)
    const signal = AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now())))
    try {
      const health = await fetch(`${baseUrl}/health`, { signal })
      if (!health.ok) throw new Error(`salud del core: HTTP ${health.status}`)
      const identity = await health.json() as { service?: string }
      if (identity.service !== 'agenthub-control-plane') throw new Error(`Otro servicio responde en ${baseUrl}`)
      const response = await fetch(`${baseUrl}/api/auth/desktop-session`, {
        method: 'POST', headers: { Authorization: `Bearer ${bootstrap}` }, signal,
      })
      if (!response.ok) throw new Error(`sesión local: HTTP ${response.status}. Otro proceso puede estar usando ${baseUrl}`)
      const payload = await response.json() as { access_token?: string }
      if (typeof payload.access_token === 'string' && payload.access_token) return payload.access_token
      throw new Error('el core no devolvió una sesión local válida')
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error
        ? (error.cause as NodeJS.ErrnoException).code ?? error.cause.message : ''
      lastError = error instanceof Error ? `${error.message}${cause ? ` (${cause})` : ''}` : String(error)
    }
    await sleep(Math.max(0, Math.min(100, deadline - Date.now())))
  }
  throw new Error(`Se agotó el tiempo de arranque: ${lastError}`)
}
