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
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let sessionRenewal: Promise<string> | null = null

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 401) {
    if (retry && window.agentHub) {
      sessionRenewal ??= window.agentHub.getSession().finally(() => { sessionRenewal = null })
      setToken(await sessionRenewal)
      return request<T>(method, path, body, false)
    }
    setToken(null)
    if (!path.startsWith('/auth/')) window.location.hash = '#/login'
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string') message = data.detail
      else if (Array.isArray(data?.detail)) message = data.detail.map((d: { msg?: string }) => d.msg).join('; ')
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
