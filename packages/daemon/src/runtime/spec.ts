/**
 * Datos de conexión de un MCP server, tal como vienen en el snapshot.
 *
 * Es la copia inmutable que consume el plan de runtime. `fingerprint()` permite
 * detectar que el control plane cambió el comando, la URL o a qué secreto apunta un
 * server, y hay que rehacer la conexión.
 *
 * NOTA DE ALCANCE: el cliente MCP vivo (SessionConnection) y el pool pertenecen a
 * `@agenthub/gateway`. Acá vive solo la spec y su huella, que son puros y los
 * necesita la selección de runtime y el broker de secretos.
 */

import { canonicalJson, sha256, type SnapshotServer, type Transport } from '@agenthub/shared'

export interface UpstreamSpec {
  slug: string
  transport: Transport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  /** Referencias por nombre, nunca valores. */
  secret_refs: Record<string, string>
  requires_host_access: boolean
  container_image: string
  allow_hosts: string[]
  allow_ports: number[]
  read_mounts: string[]
  write_mounts: string[]
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item))
}

function strMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[String(key)] = String(item)
  return out
}

/** Construye la spec desde una entrada de `snapshot.servers`. */
export function specFromSnapshot(payload: SnapshotServer): UpstreamSpec {
  return {
    slug: String(payload.slug),
    transport: payload.transport,
    command: String(payload.command ?? ''),
    args: strArray(payload.args),
    env: strMap(payload.env),
    cwd: String(payload.cwd ?? ''),
    url: String(payload.url ?? ''),
    headers: strMap(payload.headers),
    secret_refs: strMap(payload.secret_refs),
    requires_host_access: Boolean(payload.requires_host_access ?? false),
    container_image: String(payload.container_image ?? ''),
    allow_hosts: strArray(payload.allow_hosts),
    allow_ports: (Array.isArray(payload.allow_ports) ? payload.allow_ports : []).map((x) => Number(x)),
    read_mounts: strArray(payload.read_mounts),
    write_mounts: strArray(payload.write_mounts),
  }
}

/**
 * Hash estable de todo lo que afecta a la conexión. Incluye los VALORES de `env` y
 * `headers`: si rota un secreto, la conexión vieja quedó obsoleta. De `secret_refs`
 * entran las REFERENCIAS, no los valores.
 */
export function fingerprint(spec: UpstreamSpec): string {
  const sortedMap = (m: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)))
  const payload = {
    slug: spec.slug,
    transport: spec.transport,
    command: spec.command,
    args: spec.args,
    env: sortedMap(spec.env),
    cwd: spec.cwd,
    url: spec.url,
    headers: sortedMap(spec.headers),
    secret_refs: sortedMap(spec.secret_refs),
    requires_host_access: spec.requires_host_access,
    container_image: spec.container_image,
    allow_hosts: [...spec.allow_hosts].sort(),
    allow_ports: [...spec.allow_ports].sort((a, b) => a - b),
    read_mounts: [...spec.read_mounts].sort(),
    write_mounts: [...spec.write_mounts].sort(),
  }
  return sha256(canonicalJson(payload))
}
