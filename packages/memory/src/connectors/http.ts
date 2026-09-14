import { MemoryError } from '../contracts.js'
export class ProviderError extends MemoryError {
  constructor(readonly httpStatus: number, readonly retryAfter = 0) {
    super(httpStatus === 401 || httpStatus === 403 ? 409 : 502,
      httpStatus === 401 || httpStatus === 403 ? 'La fuente requiere reconectar la cuenta o revisar permisos' : `La fuente respondió HTTP ${httpStatus}`)
  }
}
export class ProviderHttp {
  constructor(private fetcher: typeof fetch = fetch, private signal?: AbortSignal) {}
  async json(url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      redirect: 'error',
    })
    if (!response.ok) throw new ProviderError(response.status, Number(response.headers.get('retry-after') ?? 0))
    return response.json()
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
