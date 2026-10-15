import { setTimeout as sleep } from 'node:timers/promises'
import { MemoryError } from '../contracts.js'

/** Google answers per-user and per-project rate limits with 403 plus one of these reasons, not only with 429. */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED', 'rate_limited'])
const MAX_RATE_LIMIT_RETRIES = 4
const DISABLED_API_REASONS = new Set(['SERVICE_DISABLED', 'accessNotConfigured'])
const CONSOLE_URL = /^https:\/\/console\.(developers|cloud)\.google\.com\/[\w./?=&%-]{1,400}$/

interface ErrorDetail { reason: string; service?: string; activationUrl?: string }

export class ProviderError extends MemoryError {
  readonly rateLimited: boolean
  readonly reason: string
  constructor(readonly httpStatus: number, readonly retryAfter = 0, detail: ErrorDetail = { reason: '' }) {
    const { reason } = detail, limited = httpStatus === 429 || RATE_LIMIT_REASONS.has(reason), suffix = reason ? ` (${reason})` : ''
    super(limited ? 503 : httpStatus === 401 || httpStatus === 403 ? 409 : 502,
      limited ? `La fuente limitó la cantidad de pedidos${suffix}; se reintenta más tarde`
        : DISABLED_API_REASONS.has(reason) ? `Falta habilitar ${detail.service ?? 'una API'} en el proyecto de Google Cloud${detail.activationUrl ? `: ${detail.activationUrl}` : ''}`
          : httpStatus === 401 || httpStatus === 403 ? `La fuente requiere reconectar la cuenta o revisar permisos${suffix}` : `La fuente respondió HTTP ${httpStatus}${suffix}`, limited)
    this.rateLimited = limited
    this.reason = reason
  }
}

/**
 * Reads the machine-readable cause from Google (`error.errors[].reason`, `error.details[].reason`, `error.status`) or
 * Notion (`code`). A disabled Google API also carries the service name and its console activation URL in ErrorInfo metadata.
 */
async function errorDetail(response: Response): Promise<ErrorDetail> {
  let body: any
  try { body = JSON.parse(await response.text()) } catch { return { reason: '' } }
  const error = body?.error, info = error?.details?.find((d: any) => d?.metadata?.service)?.metadata
  const reason = error?.errors?.find((e: any) => e?.reason)?.reason ?? error?.details?.find((d: any) => d?.reason)?.reason ?? error?.status ?? body?.code
  const service = typeof info?.service === 'string' && /^[a-z0-9.-]{1,100}\.googleapis\.com$/.test(info.service) ? info.service : undefined
  const activationUrl = typeof info?.activationUrl === 'string' && CONSOLE_URL.test(info.activationUrl) ? info.activationUrl : undefined
  return { reason: typeof reason === 'string' ? reason.replace(/[^\w.-]/g, '').slice(0, 100) : '', ...(service ? { service } : {}), ...(activationUrl ? { activationUrl } : {}) }
}

export class ProviderHttp {
  constructor(private fetcher: typeof fetch = fetch, private signal?: AbortSignal) {}
  /** Rate-limited responses are retried with exponential backoff (1, 2, 4, 8 s, or the provider's Retry-After) before failing. */
  async json(url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        redirect: 'error',
      })
      if (response.ok) return response.json()
      const error = new ProviderError(response.status, Number(response.headers.get('retry-after')) || 0, await errorDetail(response))
      if (!error.rateLimited || attempt >= MAX_RATE_LIMIT_RETRIES) throw error
      await sleep(Math.max(error.retryAfter * 1000, 1000 * 2 ** attempt) + Math.random() * 500, undefined, this.signal ? { signal: this.signal } : {})
    }
  }
}
export async function* pages(http: ProviderHttp, initial: string, headers: Record<string, string>, field: string) {
  let token = ''
  const seen = new Set<string>()
  do {
    const url = new URL(initial)
    if (token) url.searchParams.set('pageToken', token)
    const page = await http.json(url.toString(), headers)
    for (const row of page[field] ?? []) yield row as Record<string, any>
    token = page.nextPageToken ?? ''
    if (token && seen.has(token)) throw new MemoryError(502, 'La fuente repitió un cursor de paginación')
    seen.add(token)
  } while (token)
}
export function richText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(richText).join('')
  const row = value as Record<string, any>
  if (typeof row.plain_text === 'string') return row.plain_text
  if (typeof row.text === 'string') return row.text
  if (row.text?.content) return row.text.content
  const children = richText(row.content ?? [])
  return children + (['paragraph', 'heading', 'listItem', 'hardBreak'].includes(row.type) ? '\n' : '')
}
