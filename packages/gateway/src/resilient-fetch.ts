/**
 * `fetch` para el upstream de memoria en loopback que sobrevive al reinicio del core.
 *
 * Sólo reintenta lo que NO llegó a entregarse al core:
 *   - el connect falló antes de establecerse el socket (ECONNREFUSED, ENOENT, etc.), o
 *   - el core respondió 503 con `x-agenthub-draining: 1` sin ejecutar nada.
 * Un reset después de escribir la petición es ambiguo (puede haberse ejecutado) y se
 * propaga como error: no se duplican efectos. Cada petición usa su propia conexión
 * (`agent: false`) para no heredar sockets keep-alive que el core viejo ya cerró.
 */

import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export const DRAIN_HEADER = "x-agenthub-draining"
/** Presupuesto de reintentos para handshake y consultas. */
export const RESILIENT_FETCH_MAX_WAIT_MS = 120_000
/** Una llamada de herramienta vence a los 60 s en el cliente MCP: el reintento debe terminar antes. */
export const RESILIENT_FETCH_CALL_MAX_WAIT_MS = 45_000
const INITIAL_BACKOFF_MS = 100
const MAX_BACKOFF_MS = 1_000
const BACKOFF_FACTOR = 1.6
const NOT_DELIVERED = new Set(["ECONNREFUSED", "ENOENT", "EADDRNOTAVAIL", "EHOSTUNREACH", "ENETUNREACH"])
const EMPTY_BODY_STATUS = new Set([101, 204, 205, 304])

export interface ResilientFetchOptions {
  maxWaitMs?: number
  callMaxWaitMs?: number
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  clock?: () => number
}

interface Attempt {
  /** `true` si el socket llegó a conectarse: desde ahí un fallo es ambiguo. */
  connected: boolean
  response?: IncomingMessage
  error?: NodeJS.ErrnoException
}

function toHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => { out[key] = value })
  return out
}

function toBody(init: RequestInit | undefined): Buffer | undefined {
  const body = init?.body
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  throw new TypeError("resilient-fetch: cuerpo no reenviable")
}

/** El método JSON-RPC de la petición, para elegir el presupuesto de reintento. */
function rpcMethod(body: Buffer | undefined): string | undefined {
  if (!body || body.length > 1_000_000) return undefined
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const method = (first as { method?: unknown } | undefined)?.method
    return typeof method === "string" ? method : undefined
  } catch {
    return undefined
  }
}

function attemptOnce(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal | undefined): Promise<Attempt> {
  return new Promise((resolve) => {
    const state: Attempt = { connected: false }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest
    const req = send(url, { method, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) }, agent: false, ...(signal ? { signal } : {}) })
    req.once("socket", (socket) => {
      if (!socket.connecting) state.connected = true
      else socket.once("connect", () => { state.connected = true })
    })
    req.once("response", (response) => resolve({ ...state, response }))
    req.once("error", (error: NodeJS.ErrnoException) => resolve({ ...state, error }))
    req.end(body)
  })
}

function toResponse(incoming: IncomingMessage): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else if (value !== undefined) headers.set(key, value)
  }
  const status = incoming.statusCode ?? 502
  if (EMPTY_BODY_STATUS.has(status)) {
    incoming.resume()
    return new Response(null, { status, statusText: incoming.statusMessage ?? "", headers })
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, statusText: incoming.statusMessage ?? "", headers })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
}

export function createResilientLoopbackFetch(options: ResilientFetchOptions = {}): FetchLike {
  const maxWait = options.maxWaitMs ?? RESILIENT_FETCH_MAX_WAIT_MS
  const callMaxWait = options.callMaxWaitMs ?? RESILIENT_FETCH_CALL_MAX_WAIT_MS
  const wait = options.sleepFn ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, signal ? { signal } : undefined))
  const clock = options.clock ?? Date.now
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const signal = init?.signal ?? undefined
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = toHeaders(init)
    const body = toBody(init)
    const budget = rpcMethod(body) === "tools/call" ? callMaxWait : maxWait
    const deadline = clock() + budget
    let backoff = INITIAL_BACKOFF_MS
    for (;;) {
      if (signal?.aborted) throw abortError(signal)
      const attempt = await attemptOnce(url, method, headers, body, signal)
      if (attempt.response) {
        const draining = attempt.response.statusCode === 503 && attempt.response.headers[DRAIN_HEADER] === "1"
        if (!draining) return toResponse(attempt.response)
        attempt.response.resume()
      } else {
        const error = attempt.error!
        if (signal?.aborted) throw abortError(signal)
        if (attempt.connected || !NOT_DELIVERED.has(String(error.code))) throw error
      }
      const remaining = deadline - clock()
      if (remaining <= 0) {
        throw new Error(`el core local no respondió en ${Math.round(budget / 1000)} s`)
      }
      try {
        await wait(Math.min(backoff, remaining), signal)
      } catch {
        if (signal?.aborted) throw abortError(signal)
      }
      backoff = Math.min(Math.round(backoff * BACKOFF_FACTOR), MAX_BACKOFF_MS)
    }
  }
}
