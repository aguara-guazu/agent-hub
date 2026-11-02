import type { VersionInfo } from "./ipc.js"
import { compareVersions, type ReleaseInfo } from "./updater.js"

/** Vigencia de una consulta correcta. */
export const VERSION_CACHE_TTL_MS = 60 * 60 * 1000
/** Vigencia de una consulta fallida: evita repetir el pedido a GitHub (límite sin autenticar) en cada visita a la vista. */
export const VERSION_FAILURE_TTL_MS = 60 * 1000

export interface VersionInfoDeps {
  currentVersion: string
  /** Última release publicada, `null` si el repositorio no tiene ninguna; rechaza ante un error de red o de GitHub. */
  fetchRelease: () => Promise<ReleaseInfo | null>
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
}

/**
 * Lector de sólo lectura de la versión en ejecución y de la última release publicada. No descarga ni instala nada y no
 * toca el estado del `AutoUpdater`. El resultado se conserva en memoria y las consultas simultáneas comparten un pedido.
 */
export function createVersionInfoReader(deps: VersionInfoDeps): () => Promise<VersionInfo> {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? VERSION_CACHE_TTL_MS
  const failureTtl = deps.failureTtlMs ?? VERSION_FAILURE_TTL_MS
  let cached: { info: VersionInfo; expiresAt: number } | null = null
  let pending: Promise<VersionInfo> | null = null

  const unknown = (): VersionInfo => ({ current: deps.currentVersion, latest: null, page: null, state: "unknown", checkedAt: new Date(now()).toISOString() })

  async function load(): Promise<{ info: VersionInfo; ttl: number }> {
    try {
      const release = await deps.fetchRelease()
      if (!release) return { info: unknown(), ttl: failureTtl }
      const state = compareVersions(release.version, deps.currentVersion) > 0 ? "outdated" : "up-to-date"
      return { info: { current: deps.currentVersion, latest: release.version, page: release.page, state, checkedAt: new Date(now()).toISOString() }, ttl }
    } catch {
      return { info: unknown(), ttl: failureTtl }
    }
  }

  return () => {
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.info)
    pending ??= load().then(result => {
      cached = { info: result.info, expiresAt: now() + result.ttl }
      return result.info
    }).finally(() => { pending = null })
    return pending
  }
}
