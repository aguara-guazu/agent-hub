/** Datos y reglas de la vista Servidores MCP.
 *
 *  Invariante: por los formularios nunca pasa una credencial. `secret_refs` lleva el NOMBRE con el que
 *  el daemon resuelve el secreto al conectar, y todo valor con forma de token se rechaza antes de llegar
 *  al backend, también en `env` y en los encabezados. Las funciones devuelven códigos, no textos: la vista
 *  los traduce y nunca repite el valor sospechoso en pantalla.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { LOCAL_KEY } from "./local"
import { invalidateAfterCatalogChange } from "./queries"
import type { MatrixCell, MatrixRow, McpServer, ResourceType, RuleState, ServerAuth, Transport } from "./types"

/* ---------------------------------------------------------------- credenciales pegadas por error */

/** Prefijos públicos de credenciales conocidas. Primera red, no la última. */
const TOKEN_PREFIXES: readonly string[] = [
  "sk-", "sk_live_", "sk_test_", "pk_live_", "rk_live_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
  "xoxb-", "xoxp-", "xoxa-", "xoxs-", "xapp-", "AKIA", "ASIA", "ya29.", "AIza", "hf_", "glpat-", "npm_",
  "dop_v1_", "shpat_", "SG.", "sq0atp-", "lin_api_", "ATATT", "ahd_",
]

const VOWELS = new Set("aeiouAEIOU")

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function vowelRatio(value: string): number {
  const letters = [...value].filter(char => /[A-Za-z]/.test(char))
  if (letters.length === 0) return 0
  return letters.filter(char => VOWELS.has(char)).length / letters.length
}

export type SecretReason = "pem" | "jwt" | "prefix" | "hex" | "random" | "entropy"

/** Motivo por el que un valor parece una credencial, o null si parece un nombre.
 *  Calibrada para dejar pasar `GITHUB_TOKEN`, `keychain:agenthub/gateway` u `op://vault/item`; ante la duda
 *  frena, porque el falso positivo cuesta renombrar y el falso negativo deja un secreto en la base. */
export function looksLikeSecret(value: string): SecretReason | null {
  const text = value.trim()
  if (text === "") return null
  if (text.includes("-----BEGIN")) return "pem"
  if (/^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./.test(text)) return "jwt"
  for (const prefix of TOKEN_PREFIXES) if (text.startsWith(prefix) && text.length >= prefix.length + 8) return "prefix"
  if (/^[A-Fa-f0-9]{32,}$/.test(text)) return "hex"
  const runs = text.match(/[A-Za-z0-9]+/g) ?? []
  for (const run of runs) {
    if (run.length < 24) continue
    const classes = Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[0-9]/.test(run))
    if (classes >= 3 && shannonEntropy(run) >= 3.6 && vowelRatio(run) < 0.26) return "random"
  }
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  if (text.length >= 40 && longestRun >= 12 && !/\s/.test(text) && shannonEntropy(text) >= 4.0) return "entropy"
  return null
}

/** Esquemas que el daemon resuelve. Espeja `SECRET_SCHEMES` de `packages/core/src/serialize.ts`. */
export const SECRET_SCHEMES = ["env", "file", "keychain"] as const

/** `format`: no tiene la forma `<backend>://<ruta>`; `scheme`: backend que el daemon no resuelve. */
export function invalidSecretRef(value: string): "format" | "scheme" | null {
  const text = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\/.+$/.test(text)) return "format"
  const scheme = text.slice(0, text.indexOf("://"))
  return (SECRET_SCHEMES as readonly string[]).includes(scheme) ? null : "scheme"
}

/* ---------------------------------------------------------------- texto multilínea ↔ estructuras */

export type PairSeparator = "=" | ":"

/** Una línea por par; se ignoran vacías y las que empiezan con `#`. `bad` lleva el número de línea (1-based). */
export function parsePairs(text: string, separator: PairSeparator): { pairs: Record<string, string>; bad: number[] } {
  const pairs: Record<string, string> = {}
  const bad: number[] = []
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const at = line.indexOf(separator)
    const key = at > 0 ? line.slice(0, at).trim() : ""
    if (key === "") { bad.push(index + 1); return }
    pairs[key] = line.slice(at + 1).trim()
  })
  return { pairs, bad }
}

export function formatPairs(pairs: Record<string, string>, separator: PairSeparator): string {
  return Object.entries(pairs).map(([key, value]) => (separator === "=" ? `${key}=${value}` : `${key}: ${value}`)).join("\n")
}

/** Un argumento por línea: los espacios son parte del argumento. */
export function parseLines(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line !== "")
}

/* ---------------------------------------------------------------- borrador y validación */

/** Cuerpo de POST/PATCH /catalog/servers. En edición el slug no viaja: es inmutable. */
export interface ServerPayload {
  slug?: string
  display_name: string
  description: string
  transport: Transport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  secret_refs: Record<string, string>
  auth: ServerAuth
  requires_host_access: boolean
  container_image: string
  allow_hosts: string[]
  allow_ports: number[]
  read_mounts: string[]
  write_mounts: string[]
}

/** Estado editable del panel; los campos sin control propio (aislamiento) se copian del servidor tal cual. */
export interface ServerDraft {
  slug: string
  displayName: string
  description: string
  transport: Transport
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  secretRefs: string
  auth: ServerAuth
}

export function draftOf(server: McpServer | null): ServerDraft {
  return {
    slug: server?.slug ?? "",
    displayName: server?.display_name ?? "",
    description: server?.description ?? "",
    transport: server?.transport ?? "http",
    command: server?.command ?? "",
    args: (server?.args ?? []).join("\n"),
    env: formatPairs(server?.env ?? {}, "="),
    cwd: server?.cwd ?? "",
    url: server?.url ?? "",
    headers: formatPairs(server?.headers ?? {}, ":"),
    secretRefs: formatPairs(server?.secret_refs ?? {}, "="),
    auth: server?.auth ?? "none",
  }
}

export function sameDraft(a: ServerDraft, b: ServerDraft): boolean {
  return (Object.keys(a) as (keyof ServerDraft)[]).every(key => a[key] === b[key])
}

export type DraftField = "slug" | "displayName" | "command" | "url" | "env" | "headers" | "secretRefs"

/** Problema de validación: `code` es la clave de `servers:validation.*`, `name` la clave afectada (nunca el valor). */
export interface DraftIssue { field: DraftField; code: string; name?: string; line?: number }

const SLUG_RE = /^[a-z][a-z0-9_-]{1,47}$/

/** Slug sugerido a partir del nombre visible; el backend vuelve a validarlo. */
export function slugFrom(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 48)
}

/** Valida y arma el cuerpo. Sin `base`, es un alta (incluye slug y defaults de aislamiento). */
export function buildPayload(draft: ServerDraft, base: McpServer | null): { payload: ServerPayload | null; issues: DraftIssue[] } {
  const issues: DraftIssue[] = []
  const stdio = draft.transport === "stdio"
  if (!base && !SLUG_RE.test(draft.slug.trim())) issues.push({ field: "slug", code: "slug" })
  if (draft.displayName.trim() === "") issues.push({ field: "displayName", code: "required" })
  if (stdio && draft.command.trim() === "") issues.push({ field: "command", code: "required" })
  if (!stdio && !/^https?:\/\/\S+$/.test(draft.url.trim())) issues.push({ field: "url", code: "url" })

  const env = parsePairs(draft.env, "=")
  const headers = parsePairs(draft.headers, ":")
  const refs = parsePairs(draft.secretRefs, "=")
  if (stdio) env.bad.forEach(line => issues.push({ field: "env", code: "pairEquals", line }))
  else headers.bad.forEach(line => issues.push({ field: "headers", code: "pairColon", line }))
  refs.bad.forEach(line => issues.push({ field: "secretRefs", code: "pairEquals", line }))

  for (const [name, value] of Object.entries(refs.pairs)) {
    const secret = looksLikeSecret(value)
    if (secret) { issues.push({ field: "secretRefs", code: "refIsSecret", name }); continue }
    const bad = invalidSecretRef(value)
    if (bad) issues.push({ field: "secretRefs", code: bad === "format" ? "refFormat" : "refScheme", name })
  }
  const plain = stdio ? env.pairs : headers.pairs
  for (const [name, value] of Object.entries(plain)) {
    if (looksLikeSecret(value)) issues.push({ field: stdio ? "env" : "headers", code: "valueIsSecret", name })
  }
  if (issues.length > 0) return { payload: null, issues }

  const payload: ServerPayload = {
    display_name: draft.displayName.trim(),
    description: draft.description.trim(),
    transport: draft.transport,
    command: stdio ? draft.command.trim() : "",
    args: stdio ? parseLines(draft.args) : [],
    env: stdio ? env.pairs : {},
    cwd: stdio ? draft.cwd.trim() : "",
    url: stdio ? "" : draft.url.trim(),
    headers: stdio ? {} : headers.pairs,
    secret_refs: refs.pairs,
    auth: stdio ? "none" : draft.auth,
    requires_host_access: stdio ? (base?.requires_host_access ?? true) : false,
    container_image: stdio ? (base?.container_image ?? "") : "",
    allow_hosts: base?.allow_hosts ?? [],
    allow_ports: base?.allow_ports ?? [],
    read_mounts: stdio ? (base?.read_mounts ?? []) : [],
    write_mounts: stdio ? (base?.write_mounts ?? []) : [],
  }
  if (!base) payload.slug = draft.slug.trim()
  return { payload, issues: [] }
}

/* ---------------------------------------------------------------- importación de JSON de clientes */

/** `raw` es la entrada original, para devolver al cuadro las que fallaron. */
export interface ImportEntry { name: string; raw: unknown; body: ServerPayload; disabled: boolean }

export type ImportProblem = { code: "json" | "shape" | "empty" } | { code: "entry"; name: string }

/** Lee `{ mcpServers | mcp_servers: { nombre: entrada } }` tal como lo escriben los clientes. La entrada `hub` se omite. */
export function parseImport(text: string): { entries: ImportEntry[]; problem: ImportProblem | null } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { entries: [], problem: { code: "json" } } }
  const root = parsed as Record<string, unknown> | null
  const source = root && typeof root === "object" ? (root.mcpServers ?? root.mcp_servers) : undefined
  if (!source || typeof source !== "object" || Array.isArray(source)) return { entries: [], problem: { code: "shape" } }
  const raw = Object.entries(source as Record<string, Record<string, unknown> | null>).filter(([name]) => name !== "hub")
  if (raw.length === 0) return { entries: [], problem: { code: "empty" } }
  const entries: ImportEntry[] = []
  for (const [name, entry] of raw) {
    if (!entry || typeof entry !== "object" || (!entry.command && !entry.url && !entry.httpUrl)) return { entries: [], problem: { code: "entry", name } }
    const url = String(entry.url ?? entry.httpUrl ?? "")
    entries.push({
      name,
      raw: entry,
      disabled: entry.disabled === true || entry.enabled === false,
      body: {
        slug: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48),
        display_name: name,
        description: "",
        transport: url ? "http" : "stdio",
        command: String(entry.command ?? ""),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: (entry.env as Record<string, string> | undefined) ?? {},
        cwd: String(entry.cwd ?? ""),
        url,
        headers: (entry.headers ?? entry.http_headers ?? {}) as Record<string, string>,
        secret_refs: {},
        auth: url && (entry.auth === "oauth" || entry.oauth === true) ? "oauth" : "none",
        requires_host_access: true,
        container_image: "",
        allow_hosts: [],
        allow_ports: [],
        read_mounts: [],
        write_mounts: [],
      },
    })
  }
  return { entries, problem: null }
}

/* ---------------------------------------------------------------- estado */

export type ServerStatus = "connected" | "requiresAuth" | "toolsChanged" | "error" | "off" | "untested" | "restartPending" | "pendingSync"

/** Cliente sin pausar que el resolver tiene en cuenta (`client_disabled` es una pausa del cliente, no del servidor). */
function activeCells(row: MatrixRow | undefined): MatrixCell[] {
  return row ? Object.values(row.cells).filter(cell => cell.source !== "client_disabled") : []
}

export function rowEnabled(row: MatrixRow | undefined, clientId?: string): boolean {
  if (!row) return true
  if (clientId) return Boolean(row.cells[clientId]?.exposed)
  const cells = activeCells(row)
  return cells.length > 0 ? cells.some(cell => cell.exposed) : row.user_rule !== "off"
}

export function quarantinedCount(server: McpServer): number {
  return server.tools.filter(tool => tool.quarantined).length
}

export function needsAuth(server: McpServer): boolean {
  return server.auth === "oauth" && server.oauth_status === "required"
}

/** Estado de la fila. Con `clientId`, el estado de propagación de ese cliente reemplaza a «Conectado». */
export function serverStatus(server: McpServer, row: MatrixRow | undefined, clientId?: string): ServerStatus {
  if (needsAuth(server)) return "requiresAuth"
  if (quarantinedCount(server) > 0) return "toolsChanged"
  if (!rowEnabled(row, clientId)) return "off"
  if (server.last_probe_error) return "error"
  if (server.tools.length === 0) return "untested"
  const propagation = clientId ? row?.cells[clientId]?.propagation : undefined
  if (propagation === "pending_restart" || propagation === "applied_stale_list") return "restartPending"
  if (propagation === "pending_sync") return "pendingSync"
  return "connected"
}

export const STATUS_TONE: Record<ServerStatus, "ok" | "warn" | "danger" | "info" | "off"> = {
  connected: "ok",
  requiresAuth: "warn",
  toolsChanged: "warn",
  restartPending: "warn",
  error: "danger",
  pendingSync: "info",
  off: "off",
  untested: "off",
}

export function needsAttention(status: ServerStatus): boolean {
  return status === "requiresAuth" || status === "toolsChanged" || status === "error"
}

/* ---------------------------------------------------------------- escrituras */

export function useServersCache() {
  const cache = useQueryClient()
  return async () => {
    await Promise.all([invalidateAfterCatalogChange(cache), cache.invalidateQueries({ queryKey: LOCAL_KEY })])
  }
}

/** Una regla de exposición. `client` vacío escribe para todos los clientes y limpia las reglas propias de cada uno. */
export interface RuleWrite { type: ResourceType; id: string; state: RuleState; client?: string; resetClients?: boolean }

export function putRule({ type, id, state, client, resetClients }: RuleWrite): Promise<void> {
  return api.put<void>("/policy/rules", {
    scope: client ? "client" : "user",
    scope_id: client ?? "",
    resource_type: type,
    resource_id: id,
    state,
    reset_clients: resetClients ?? !client,
  })
}

/** Reglas que dejan el recurso como está ahora: la de la persona y la propia de cada cliente.
 *  `reset_clients` borra las de cliente, así que deshacer un cambio global tiene que reescribirlas. */
export function snapshotRules(row: MatrixRow | undefined, type: ResourceType, id: string): RuleWrite[] {
  if (!row) return [{ type, id, state: "inherit", resetClients: false }]
  const writes: RuleWrite[] = [{ type, id, state: row.user_rule ?? "inherit", resetClients: false }]
  for (const [client, cell] of Object.entries(row.cells)) {
    if (cell.own_rule) writes.push({ type, id, client, state: cell.own_rule, resetClients: false })
  }
  return writes
}

export function useRuleWrite() {
  const refresh = useServersCache()
  return useMutation({
    mutationFn: async (writes: RuleWrite[]) => { for (const write of writes) await putRule(write) },
    onSettled: refresh,
  })
}

export function createServer(payload: ServerPayload): Promise<McpServer> {
  return api.post<McpServer>("/catalog/servers", payload)
}

export function updateServer(id: string, payload: ServerPayload): Promise<McpServer> {
  const { slug: _slug, ...rest } = payload
  return api.patch<McpServer>(`/catalog/servers/${id}`, rest)
}

/** El endpoint responde 200 aunque la conexión falle: el motivo viene en `last_probe_error`. */
export function probeServer(id: string): Promise<McpServer> {
  return api.post<McpServer>(`/catalog/servers/${id}/probe`)
}

export function acceptToolChanges(id: string): Promise<McpServer> {
  return api.post<McpServer>(`/catalog/servers/${id}/approve`)
}

export function startOAuth(id: string): Promise<{ status: string; authorization_url?: string }> {
  return api.post(`/catalog/servers/${id}/oauth/start`)
}

export function logoutOAuth(id: string): Promise<McpServer> {
  return api.post<McpServer>(`/catalog/servers/${id}/oauth/logout`)
}

/** Va a un archivo 0600 del daemon; el secreto nunca vuelve en la respuesta. */
export function saveOAuthClient(id: string, clientId: string, clientSecret: string): Promise<McpServer> {
  return api.post<McpServer>(`/catalog/servers/${id}/oauth/client`, { client_id: clientId.trim(), ...(clientSecret ? { client_secret: clientSecret } : {}) })
}

export function deleteServer(id: string): Promise<void> {
  return api.delete<void>(`/catalog/servers/${id}`)
}

/** Deshace un borrado suave dentro de CATALOG_RESTORE_WINDOW_MS; 404 si ya se purgó, 409 si el slug está tomado. */
export function restoreServer(id: string): Promise<McpServer> {
  return api.post<McpServer>(`/catalog/servers/${id}/restore`)
}

export function oauthRedirectUrl(): Promise<{ redirect_url: string }> {
  return api.get<{ redirect_url: string }>("/oauth/settings")
}
