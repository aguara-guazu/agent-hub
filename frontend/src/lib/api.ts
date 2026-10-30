/** Cliente HTTP unico del control plane.
 *  Todo componente accede a la API por aca; nadie llama a fetch directamente. */

const TOKEN_KEY = 'agenthub.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* modo privado: la sesion dura lo que dura la pestana */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Código cerrado que algunas rutas agregan al cuerpo de error (`{ code: 'digest_mismatch' }`). */
    readonly code?: string,
    /** Campo rechazado (ruta con puntos del cuerpo enviado, p. ej. `document.roster.coordinator.model`) y motivo estable, cuando la ruta los informa. */
    readonly field?: string,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let sessionRenewal: Promise<string> | null = null

async function request<T>(method: string, path: string, body?: unknown, retry = true, asBlob = false, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  // Un Blob viaja tal cual con su tipo; el resto de los cuerpos es JSON.
  const binary = body instanceof Blob
  if (binary) headers["Content-Type"] = body.type || "application/octet-stream"
  else if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    ...(signal ? { signal } : {}),
    body: binary ? body : body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 401) {
    if (retry && window.agentHub) {
      sessionRenewal ??= window.agentHub.getSession().finally(() => { sessionRenewal = null })
      setToken(await sessionRenewal)
      return request<T>(method, path, body, false, asBlob, signal)
    }
    setToken(null)
    if (!path.startsWith('/auth/')) window.location.hash = '#/login'
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    let code: string | undefined
    let field: string | undefined
    let reason: string | undefined
    try {
      const data = await res.json()
      if (typeof data?.code === 'string') code = data.code
      if (typeof data?.field === "string") field = data.field
      if (typeof data?.reason === "string") reason = data.reason
      if (typeof data?.detail === 'string') message = data.detail
      else if (Array.isArray(data?.detail)) message = data.detail.map((d: { msg?: string }) => d.msg).join('; ')
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new ApiError(res.status, message, code, field, reason)
  }

  if (res.status === 204) return undefined as T
  if (asBlob) return await res.blob() as T
  return (await res.json()) as T
}

export const api = {
  download: (path: string) => request<Blob>('GET', path, undefined, true, true),
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, true, false, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, true, false, signal),
  /** Cuerpo binario; sin `type` en el Blob sale como application/octet-stream. */
  upload: <T>(path: string, file: Blob) => request<T>("POST", path, file),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
