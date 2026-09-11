/**
 * Plan de aislamiento en contenedor (ToolHive), sin efectos de red.
 *
 * Traduce una `UpstreamSpec` en lo que ToolHive necesitaría para aislar ese server:
 * la imagen de la que partir, el perfil de permisos más cerrado que lo deje andar y
 * el nombre determinista del workload. La ejecución real (el cliente REST de `thv`,
 * el supervisor y el proxy) vive en `@agenthub/gateway`; acá está solo el plan, que
 * es puro y determinista, y lo que `agenthub status` muestra.
 *
 * PERFIL POR DEFECTO: el más cerrado. Sin `allow_hosts`/`allow_ports`/`read_mounts`/
 * `write_mounts` el contenedor no ve el filesystem de la persona ni sale a la red.
 *
 * DE DÓNDE SALE LA IMAGEN: `container_image` del catálogo gana siempre; si no, los
 * esquemas de ToolHive (`uvx://`, `npx://`) y las referencias OCI se aceptan; un
 * Un comando local sin imagen derivable no se containeriza y el pool lo manda al runtime del host.
 */

import { canonicalJson, sha256 } from '@agenthub/shared'

import { TRANSPORT_STDIO } from './detect.js'
import type { UpstreamSpec } from './spec.js'

export const WORKLOAD_PREFIX = 'agenthub'
export const FINGERPRINT_ENV_VAR = 'AGENTHUB_WORKLOAD_FINGERPRINT'
export const DEFAULT_GROUP = 'default'
export const DEFAULT_PROFILE_NAME = 'agenthub-restricted'
export const DEFAULT_PROXY_MODE = 'streamable-http'
export const DEFAULT_PROXY_HOST = '127.0.0.1'

/** Comando -> esquema de ToolHive que construye la imagen desde un paquete. */
const PROTOCOL_COMMANDS: Record<string, string> = {
  uvx: 'uvx',
  npx: 'npx',
  pnpx: 'npx',
  bunx: 'npx',
}

/** Banderas que hay que saltear antes del nombre del paquete (`npx -y pkg`). */
const PACKAGE_SKIP_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent'])

const NAME_ALLOWED = /[^a-z0-9-]+/g
const OCI_REFERENCE = /^[a-z0-9][a-z0-9._-]*(?:\.[a-z0-9._-]+)*(?::[0-9]+)?\/[a-z0-9._/-]+(?::[^:/]+)?$/

/** Lo que el catálogo declara sobre cómo aislar un server. */
export interface ContainerOptions {
  image: string
  cmdArguments: string[]
  allowHosts: string[]
  allowPorts: number[]
  readMounts: string[]
  writeMounts: string[]
  requiresHostAccess: boolean
}

/** `false` cuando no hay imagen de la que partir, o el server pidió el host. */
export function isolatable(options: ContainerOptions): boolean {
  return Boolean(options.image) && !options.requiresHostAccess
}

/**
 * Devuelve `[imagen, argumentos]` para un server stdio, o `['', []]` si no se puede.
 *
 * 1. `container_image` del catálogo, si existe: gana siempre.
 * 2. `uvx`/`npx` y equivalentes -> esquema de ToolHive con el primer paquete.
 * 3. Un comando con pinta de referencia OCI -> se usa tal cual.
 * 4. Cualquier otra cosa -> no containerizable.
 */
export function deriveContainerTarget(spec: UpstreamSpec): [string, string[]] {
  const declared = (spec.container_image ?? '').trim()
  if (declared) return [declared, [...spec.args]]

  const command = spec.command.trim()
  if (!command) return ['', []]
  if (command.includes('://')) return [command, [...spec.args]]

  const base = command.split('/').pop() ?? command
  const scheme = PROTOCOL_COMMANDS[base]
  if (scheme !== undefined) {
    const rest = [...spec.args]
    while (rest.length > 0 && PACKAGE_SKIP_FLAGS.has(rest[0]!)) rest.shift()
    if (rest.length === 0) return ['', []]
    return [`${scheme}://${rest[0]}`, rest.slice(1)]
  }

  // Una ruta del filesystem nunca es una imagen, aunque tenga barras.
  if (command.startsWith('.') || command.startsWith('/') || command.startsWith('~')) return ['', []]
  if (OCI_REFERENCE.test(command)) return [command, [...spec.args]]
  return ['', []]
}

/** Arma las opciones de aislamiento de una spec del snapshot. */
export function containerOptionsOf(spec: UpstreamSpec): ContainerOptions {
  const [image, args] = deriveContainerTarget(spec)
  return {
    image,
    cmdArguments: args,
    allowHosts: [...spec.allow_hosts],
    allowPorts: [...spec.allow_ports],
    readMounts: [...spec.read_mounts],
    writeMounts: [...spec.write_mounts],
    requiresHostAccess: Boolean(spec.requires_host_access),
  }
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 8)
}

/**
 * Nombre determinista del workload de un server para un alcance dado. Determinista
 * para reconciliar entre arranques; con el hash del slug cuando hubo que limpiarlo,
 * para que dos slugs distintos no colisionen. El sufijo del alcance mantiene el
 * invariante del pool: dos agentes que usan el mismo server NO comparten proceso.
 */
export function workloadName(slug: string, scope = ''): string {
  const lowered = slug.trim().toLowerCase()
  const cleaned = lowered.replace(NAME_ALLOWED, '-').replace(/^-+|-+$/g, '')
  const parts = [WORKLOAD_PREFIX]
  if (cleaned) parts.push(cleaned)
  if (cleaned !== lowered || !cleaned) parts.push(`h${shortHash(slug)}`)
  if (scope) parts.push(`s${shortHash(scope)}`)
  return parts.join('-')
}

/** Sufijo que identifica al alcance dentro del nombre del workload. */
export function scopeSuffix(scope: string): string {
  return scope ? `-s${shortHash(scope)}` : ''
}

/** Perfil de permisos de ToolHive: el más cerrado que deje andar al server. */
export function buildPermissionProfile(
  options: ContainerOptions,
  name: string = DEFAULT_PROFILE_NAME,
): Record<string, unknown> {
  const outbound: Record<string, unknown> = { insecure_allow_all: false }
  if (options.allowHosts.length > 0) outbound['allow_host'] = [...options.allowHosts]
  if (options.allowPorts.length > 0) outbound['allow_port'] = [...options.allowPorts]
  return {
    name,
    // No se expone ninguna forma de pedir modo privilegiado.
    privileged: false,
    read: [...options.readMounts],
    write: [...options.writeMounts],
    network: { outbound },
  }
}

/** Cuerpo de `POST /workloads`, con la huella de la definición ya incluida. */
export function buildWorkloadRequest(
  spec: UpstreamSpec,
  options: ContainerOptions,
  args: { name: string; group?: string; env?: Record<string, string> },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: args.name,
    image: options.image,
    transport: TRANSPORT_STDIO,
    proxy_mode: DEFAULT_PROXY_MODE,
    host: DEFAULT_PROXY_HOST,
    network_isolation: true,
    permission_profile: buildPermissionProfile(options),
    cmd_arguments: [...options.cmdArguments],
    env_vars: { ...(args.env ?? spec.env) },
    group: args.group ?? DEFAULT_GROUP,
    volumes: [],
  }
  ;(payload['env_vars'] as Record<string, string>)[FINGERPRINT_ENV_VAR] = requestFingerprint(payload)
  return payload
}

/** Huella de la definición deseada, sin la huella misma ni el nombre. */
export function requestFingerprint(payload: Record<string, unknown>): string {
  const material: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'name') material[key] = value
  }
  const envVars = { ...((material['env_vars'] as Record<string, string>) ?? {}) }
  delete envVars[FINGERPRINT_ENV_VAR]
  material['env_vars'] = envVars
  return sha256(canonicalJson(material))
}
