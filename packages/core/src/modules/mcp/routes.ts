import { type FastifyInstance } from 'fastify'
import { type Settings } from '../../config.js'
import { applyProbeResult, QUARANTINE_TOOL_MISSING } from '../../catalog/reconcile.js'
import { DEFAULT_TIMEOUT_MS as PROBE_TIMEOUT_MS, probeServer } from '../../catalog/probe.js'
import { validateCatalogSlug, validateSecretRefs } from '../../serialize.js'
import { serializeServer } from '../../serialize_catalog.js'
import type { McpServerRow, McpToolRow, User } from '../../types.js'
import { auth as oauthAuthorize } from '@modelcontextprotocol/sdk/client/auth.js'
import { FileOAuthProvider, OAUTH_AUTH_REQUIRED_MESSAGE, OAuthStore } from '@agenthub/gateway'
import {
  HttpError,
  isObject,
  requireObject,
  rejectUnknown,
  requireString,
  optionalString,
  withinRestoreWindow,
  type CatalogContext,
} from '../http.js'

/**
 * Idioma de las páginas HTML del retorno de OAuth. El navegador vuelve a `redirect_uri`, que el proveedor compara
 * exacta con la registrada: no admite un parámetro de idioma. Se toma el `Accept-Language` de `oauth/start` (el
 * escritorio lo fija al idioma activo de la app), después el del navegador que vuelve, y por último `es`.
 */
type OAuthLanguage = "es" | "en"

const OAUTH_TEXTS: Record<OAuthLanguage, Record<
  "close" | "unknownTitle" | "unknownDetail" | "goneTitle" | "goneDetail" | "staleTitle" | "staleDetail" | "deniedTitle" | "missingCodeTitle" | "missingCodeDetail"
  | "exchangeFailedTitle" | "authorizedTitle" | "toolsOne" | "toolsOther" | "probeFailed", string>> = {
  es: {
    close: "Podés cerrar esta pestaña y volver a Agent Hub.",
    unknownTitle: "Solicitud desconocida o vencida",
    unknownDetail: "Volvé a Agent Hub y usá «Autorizar cuenta» otra vez.",
    goneTitle: "El servidor ya no existe",
    goneDetail: "Se eliminó del catálogo mientras autorizabas.",
    staleTitle: "El servidor cambió durante la autorización",
    staleDetail: "Ya no usa OAuth o cambió su URL. Volvé a Agent Hub y usá «Autorizar cuenta» otra vez.",
    deniedTitle: "La autorización no se completó",
    missingCodeTitle: "Falta el código de autorización",
    missingCodeDetail: "El servidor volvió sin el parámetro code.",
    exchangeFailedTitle: "No se pudo completar la autorización",
    authorizedTitle: "Cuenta autorizada",
    toolsOne: "{name}: {count} herramienta disponible.",
    toolsOther: "{name}: {count} herramientas disponibles.",
    probeFailed: "{name} quedó autorizado, pero la verificación falló: {error}",
  },
  en: {
    close: "You can close this tab and go back to Agent Hub.",
    unknownTitle: "Unknown or expired request",
    unknownDetail: "Go back to Agent Hub and use “Authorize account” again.",
    goneTitle: "The server no longer exists",
    goneDetail: "It was removed from the catalog while you were authorizing.",
    staleTitle: "The server changed during authorization",
    staleDetail: "It no longer uses OAuth or its URL changed. Go back to Agent Hub and use “Authorize account” again.",
    deniedTitle: "Authorization was not completed",
    missingCodeTitle: "Authorization code missing",
    missingCodeDetail: "The server returned without the code parameter.",
    exchangeFailedTitle: "Could not complete the authorization",
    authorizedTitle: "Account authorized",
    toolsOne: "{name}: {count} tool available.",
    toolsOther: "{name}: {count} tools available.",
    probeFailed: "{name} is authorized, but the check failed: {error}",
  },
}

/** Primer idioma soportado de un `Accept-Language` (en orden de aparición; los `q` que manda Chromium ya vienen decrecientes). */
function oauthLanguage(header: string | string[] | undefined): OAuthLanguage | null {
  const value = Array.isArray(header) ? header.join(",") : header ?? ""
  for (const part of value.split(",")) {
    const base = part.trim().split(";")[0]!.toLowerCase().split("-")[0]
    if (base === "es" || base === "en") return base
  }
  return null
}

/** Interpolación de `{nombre}` con reemplazo por función: los valores (nombres de servidor, errores) no interpretan `$`. */
function fillText(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match)
}

export function registerMcpRoutes(fastify: FastifyInstance, { store, currentUser, notifyAfterCommit, oauthStore, settings }: CatalogContext & { oauthStore: OAuthStore; settings: Settings }) {
  const probeOptions = { oauthStore, redirectUrl: settings.oauthRedirectUrl }
  function serverOr404(user: User, serverId: string) {
    const server = store.server(serverId)
    if (!server || server.user_id !== user.id) throw new HttpError(404, 'el MCP server no existe')
    return server
  }

  /** Vista pública de un server: incluye si la cuenta OAuth está autorizada, nunca el token. */
  function serverView(server: McpServerRow, tools?: McpToolRow[]) {
    const oauth = server.auth === 'oauth'
      ? { authorized: oauthStore.hasTokens(server.id), clientConfigured: oauthStore.hasClient(server.id) }
      : { authorized: false, clientConfigured: false }
    return serializeServer(server, tools ?? store.toolsOfServer(server.id), oauth)
  }

  // ============================================================ catalog
  fastify.get('/api/catalog/servers', async (request) => {
    const user = await currentUser(request)
    const servers = store.serversOfUser(user.id)
    const tools = store.toolsOfServers(servers.map((s) => s.id))
    return servers.map((s) => serverView(s, tools.get(s.id) ?? []))
  })

  const SERVER_FIELDS = [
    'slug', 'display_name', 'description', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers',
    'secret_refs', 'requires_host_access', 'container_image', 'allow_hosts', 'allow_ports', 'read_mounts', 'write_mounts',
    'auth',
  ]

  function readServerPayload(body: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {}
    if (!partial) {
      out.slug = validateCatalogSlug(requireString(body, 'slug'))
      out.display_name = requireString(body, 'display_name')
      const transport = requireString(body, 'transport')
      if (transport !== 'stdio' && transport !== 'http') throw new HttpError(422, 'transport invalido')
      out.transport = transport
    } else {
      if ('display_name' in body && (typeof body.display_name !== 'string' || body.display_name.length === 0)) {
        throw new HttpError(422, 'display_name no puede ser vacio')
      }
      if ('transport' in body && body.transport !== 'stdio' && body.transport !== 'http') {
        throw new HttpError(422, 'transport invalido')
      }
    }
    if ('auth' in body) {
      if (body.auth !== 'none' && body.auth !== 'oauth') throw new HttpError(422, 'auth invalido: none u oauth')
      out.auth = body.auth
    }
    for (const field of ['description', 'command', 'cwd', 'url', 'container_image']) {
      if (field in body) out[field] = optionalString(body, field)
    }
    for (const field of ['args', 'allow_hosts', 'read_mounts', 'write_mounts', 'allow_ports']) {
      if (field in body) {
        if (!Array.isArray(body[field])) throw new HttpError(422, `el campo ${field} debe ser una lista`)
        out[field] = body[field]
      }
    }
    for (const field of ['env', 'headers']) {
      if (field in body) {
        if (!isObject(body[field])) throw new HttpError(422, `el campo ${field} debe ser un objeto`)
        out[field] = body[field]
      }
    }
    if ('secret_refs' in body) {
      if (!isObject(body.secret_refs)) throw new HttpError(422, 'secret_refs debe ser un objeto')
      out.secret_refs = validateSecretRefs(body.secret_refs as Record<string, string>)
    }
    if ('requires_host_access' in body) {
      if (typeof body.requires_host_access !== 'boolean') throw new HttpError(422, 'requires_host_access debe ser booleano')
      out.requires_host_access = body.requires_host_access
    }
    return out
  }

  fastify.post('/api/catalog/servers', async (request, reply) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    rejectUnknown(body, SERVER_FIELDS)
    const payload = readServerPayload(body, false)
    const transport = payload.transport as string
    const command = (payload.command as string) ?? ''
    const url = (payload.url as string) ?? ''
    if (transport === 'stdio' && !String(command).trim()) throw new HttpError(422, 'un server stdio necesita un comando')
    if (transport === 'http' && !String(url).trim()) throw new HttpError(422, 'un server http necesita una URL')
    if (payload.auth === 'oauth' && transport !== 'http') throw new HttpError(422, 'OAuth solo aplica a servers http')
    if (store.serverBySlug(user.id, payload.slug as string)) {
      throw new HttpError(409, `ya tenes un MCP server con el slug ${payload.slug}`)
    }
    const server = store.insertServer({
      user_id: user.id,
      slug: payload.slug as string,
      display_name: payload.display_name as string,
      description: (payload.description as string) ?? '',
      transport: transport as 'stdio' | 'http',
      command: String(command),
      args: (payload.args as string[]) ?? [],
      env: (payload.env as Record<string, string>) ?? {},
      cwd: (payload.cwd as string) ?? '',
      url: String(url),
      headers: (payload.headers as Record<string, string>) ?? {},
      secret_refs: (payload.secret_refs as Record<string, string>) ?? {},
      requires_host_access: (payload.requires_host_access as boolean) ?? false,
      container_image: (payload.container_image as string) ?? '',
      allow_hosts: (payload.allow_hosts as string[]) ?? [],
      allow_ports: (payload.allow_ports as number[]) ?? [],
      read_mounts: (payload.read_mounts as string[]) ?? [],
      write_mounts: (payload.write_mounts as string[]) ?? [],
      auth: (payload.auth as McpServerRow['auth'] | undefined) ?? 'none',
    })
    notifyAfterCommit('user', user.id)
    return reply.code(201).send(serverView(server, []))
  })

  fastify.patch('/api/catalog/servers/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    const body = requireObject(request.body)
    rejectUnknown(body, SERVER_FIELDS.filter((f) => f !== 'slug'))
    const payload = readServerPayload(body, true)
    const nextAuth = (payload.auth as McpServerRow['auth'] | undefined) ?? server.auth
    const nextTransport = (payload.transport as McpServerRow['transport'] | undefined) ?? server.transport
    if (nextAuth === 'oauth' && nextTransport !== 'http') throw new HttpError(422, 'OAuth solo aplica a servers http')
    // Dejar de usar OAuth borra la cuenta autorizada: no quedan tokens sin dueño.
    // Cambiar la URL de un server OAuth también la borra: los tokens y el cliente son del host anterior.
    const urlChanged = typeof payload.url === 'string' && normalizeOAuthUrl(payload.url) !== normalizeOAuthUrl(server.url)
    if (server.auth === 'oauth' && (nextAuth !== 'oauth' || urlChanged)) oauthStore.delete(server.id)
    store.updateServer(server.id, payload)
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })

  // Borrado suave: sale de catálogo, snapshots y daemon igual que antes; `restore` lo devuelve dentro de DELETE_RETENTION_MS.
  fastify.delete('/api/catalog/servers/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    store.softDeleteServer(server.id)
    notifyAfterCommit('user', user.id)
    return reply.code(204).send()
  })

  fastify.post("/api/catalog/servers/:id/restore", async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const deleted = store.deletedServer(id)
    // The window is checked here, not only by the purge: a purge timer that has not run yet must not extend it.
    if (!deleted || deleted.user_id !== user.id || !withinRestoreWindow(deleted.deleted_at)) {
      const live = store.server(id)
      if (live && live.user_id === user.id) throw new HttpError(409, "el MCP server no está eliminado")
      throw new HttpError(404, "el MCP server no existe o ya venció el plazo para restaurarlo")
    }
    if (store.serverBySlug(user.id, deleted.slug)) throw new HttpError(409, `ya tenes otro MCP server con el slug ${deleted.slug}`)
    store.restoreServer(deleted.id)
    notifyAfterCommit("user", user.id)
    return serverView(store.server(deleted.id)!)
  })

  fastify.post('/api/catalog/servers/:id/probe', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    const result = await probeServer(server, PROBE_TIMEOUT_MS, probeOptions)
    applyProbeResult(store, server, result)
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })

  // ------------------------------------------------------------ oauth
  // Flujos en curso: `state` -> server. Viven en memoria y vencen solos. El navegador
  // vuelve a `/api/oauth/callback` sin sesión de la consola: el `state` es la prueba.
  const pendingOAuth = new Map<string, { serverId: string; serverUrl: string; expiresAt: number; language: OAuthLanguage | null }>()
  const OAUTH_PENDING_TTL_MS = 10 * 60_000
  function prunePendingOAuth(): void {
    const now = Date.now()
    for (const [state, entry] of pendingOAuth) if (entry.expiresAt < now) pendingOAuth.delete(state)
  }
  function oauthProvider(server: McpServerRow): FileOAuthProvider {
    return new FileOAuthProvider({
      store: oauthStore,
      serverId: server.id,
      serverUrl: server.url,
      redirectUrl: settings.oauthRedirectUrl,
      interactive: true,
    })
  }
  function normalizeOAuthUrl(url: string): string {
    return url.trim().replace(/\/+$/, '')
  }
  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
  function escapeHtml(text: string): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return text.replace(/[&<>"']/g, (c) => map[c] ?? c)
  }
  function oauthPage(language: OAuthLanguage, title: string, detail: string): string {
    return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Agent Hub</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1412;color:#e8ede9;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem}h1{font-size:1.4rem}p{color:#a7b0aa;line-height:1.5}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>${escapeHtml(OAUTH_TEXTS[language].close)}</p></main></body></html>`
  }
  async function probeAndApply(server: McpServerRow) {
    const result = await probeServer(server, PROBE_TIMEOUT_MS, probeOptions)
    applyProbeResult(store, server, result)
    notifyAfterCommit('user', server.user_id)
    return result
  }

  fastify.post('/api/catalog/servers/:id/oauth/start', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    if (server.transport !== 'http' || server.auth !== 'oauth') throw new HttpError(422, 'este server no usa OAuth')
    if (!server.url.trim()) throw new HttpError(422, 'el server no tiene URL')
    const provider = oauthProvider(server)
    let outcome: 'AUTHORIZED' | 'REDIRECT'
    try {
      outcome = await oauthAuthorize(provider, { serverUrl: server.url })
    } catch (error) {
      throw new HttpError(502, `no se pudo iniciar la autorización: ${describeError(error)}`)
    }
    if (outcome === 'AUTHORIZED') {
      // Había un refresh token vigente: no hace falta pasar por el navegador.
      await probeAndApply(server)
      return { status: 'authorized', server: serverView(store.server(server.id)!) }
    }
    const url = provider.authorizationUrl
    const state = provider.pendingState()
    if (!url || !state) throw new HttpError(502, 'el servidor de autorización no devolvió una URL utilizable')
    prunePendingOAuth()
    pendingOAuth.set(state, { serverId: server.id, serverUrl: server.url, expiresAt: Date.now() + OAUTH_PENDING_TTL_MS, language: oauthLanguage(request.headers['accept-language']) })
    return { status: 'redirect', authorization_url: url.toString() }
  })

  fastify.get('/api/oauth/callback', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>
    const state = query.state ?? ''
    prunePendingOAuth()
    const pending = state ? pendingOAuth.get(state) : undefined
    const language = pending?.language ?? oauthLanguage(request.headers['accept-language']) ?? 'es'
    const text = OAUTH_TEXTS[language]
    reply.type('text/html; charset=utf-8')
    if (!pending) return reply.code(400).send(oauthPage(language, text.unknownTitle, text.unknownDetail))
    pendingOAuth.delete(state)
    const server = store.server(pending.serverId)
    if (!server) return reply.code(404).send(oauthPage(language, text.goneTitle, text.goneDetail))
    if (server.auth !== 'oauth' || normalizeOAuthUrl(server.url) !== normalizeOAuthUrl(pending.serverUrl)) {
      return reply.code(409).send(oauthPage(language, text.staleTitle, text.staleDetail))
    }
    if (query.error) {
      const detail = query.error_description || query.error
      store.updateServer(server.id, { last_probe_error: `autorización rechazada: ${detail}` })
      notifyAfterCommit('user', server.user_id)
      return reply.code(400).send(oauthPage(language, text.deniedTitle, detail))
    }
    if (!query.code) return reply.code(400).send(oauthPage(language, text.missingCodeTitle, text.missingCodeDetail))
    try {
      const outcome = await oauthAuthorize(oauthProvider(server), { serverUrl: server.url, authorizationCode: query.code })
      if (outcome !== 'AUTHORIZED') throw new Error('el servidor no entregó tokens')
    } catch (error) {
      const detail = describeError(error)
      store.updateServer(server.id, { last_probe_error: `no se pudo canjear la autorización: ${detail}` })
      notifyAfterCommit('user', server.user_id)
      return reply.code(502).send(oauthPage(language, text.exchangeFailedTitle, detail))
    }
    const result = await probeAndApply(server)
    return reply.send(oauthPage(language, text.authorizedTitle, result.ok
      ? fillText(result.tools.length === 1 ? text.toolsOne : text.toolsOther, { name: server.display_name, count: result.tools.length })
      : fillText(text.probeFailed, { name: server.display_name, error: String(result.error) })))
  })

  fastify.get('/api/oauth/settings', async (request) => {
    await currentUser(request)
    // La URL de retorno que hay que registrar en el proveedor cuando el cliente se crea a mano.
    return { redirect_url: settings.oauthRedirectUrl }
  })

  fastify.post('/api/catalog/servers/:id/oauth/client', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    if (server.auth !== 'oauth') throw new HttpError(422, 'este server no usa OAuth')
    const body = requireObject(request.body)
    rejectUnknown(body, ['client_id', 'client_secret'])
    const clientId = requireString(body, 'client_id').trim()
    if (!clientId) throw new HttpError(422, 'client_id no puede ser vacio')
    const clientSecret = optionalString(body, 'client_secret').trim()
    // Va al archivo 0600 del server, nunca a la base ni a la respuesta.
    oauthStore.saveClientCredentials(server.id, server.url, { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) })
    store.updateServer(server.id, { last_probe_error: OAUTH_AUTH_REQUIRED_MESSAGE })
    notifyAfterCommit('user', user.id)
    return serverView(store.server(server.id)!)
  })

  fastify.post('/api/catalog/servers/:id/oauth/logout', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    oauthStore.delete(server.id)
    if (server.auth === 'oauth') store.updateServer(server.id, { last_probe_error: OAUTH_AUTH_REQUIRED_MESSAGE })
    notifyAfterCommit('user', user.id)
    return serverView(store.server(server.id)!)
  })

  fastify.post('/api/catalog/servers/:id/approve', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    for (const tool of store.toolsOfServer(server.id)) {
      if (tool.quarantine_reason === QUARANTINE_TOOL_MISSING) continue
      store.updateTool(tool.id, { quarantined: false, quarantine_reason: '' })
    }
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })
}
