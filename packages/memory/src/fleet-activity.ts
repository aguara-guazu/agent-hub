import { randomUUID } from 'node:crypto'
import type { FleetState } from './fleet-process.js'

export interface FleetActivityItem { seq: number; at: string; kind: 'user' | 'assistant' | 'tool' | 'system'; text: string }
export interface FleetActivity {
  supported: boolean
  reason?: string
  generation?: string
  state?: FleetState
  items: FleetActivityItem[]
  next_cursor: number
  truncated?: boolean
}
export const unavailableActivity = (): FleetActivity => ({ supported: false, reason: 'native_transport_unavailable', items: [], next_cursor: 0 })

/** Human HTTP observer only. Never include this object in status, persistence or agent tools. */
export class FleetActivityBuffer {
  readonly generation = randomUUID()
  private items: FleetActivityItem[] = []
  private seq = 0
  private bytes = 0
  private secrets = new Set<string>()
  private secretBytes = 0
  private redactionFull = false
  private tails = new Map<string, string>()
  private tailBytes = 0
  private streams = new Map<string, { length: number; final: boolean }>()
  constructor(prompt: string) { this.rememberSecrets(prompt) }
  private rememberSecrets(text: string) {
    for (const match of text.matchAll(/(?:invitation|session_key|AGENTHUB_CHAT_SESSION_KEY)["']?\s*[:=]\s*["']?([A-Za-z0-9_./+\-=]{16,500})/gi)) this.secret(match[1]!)
  }
  secret(value: string) {
    if (!value || this.secrets.has(value)) return
    const bytes = Buffer.byteLength(value)
    // Fail closed rather than expose answers after exhausting bounded redaction memory.
    if (this.secrets.size >= 128 || this.secretBytes + bytes > 16_384) { this.redactionFull = true; return }
    this.secrets.add(value); this.secretBytes += bytes
  }
  add(kind: FleetActivityItem['kind'], value: unknown) {
    if (typeof value !== 'string' || !value) return
    this.rememberSecrets(value)
    if (this.redactionFull) return
    let text = value
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]')
    // Bound before retention; a packet may contain megabytes of tool output.
    if (Buffer.byteLength(text) > 32_768) text = Buffer.from(text).subarray(0, 32_768).toString('utf8') + '\n[truncated]'
    const item = { seq: ++this.seq, at: new Date().toISOString(), kind, text }
    this.items.push(item); this.bytes += Buffer.byteLength(JSON.stringify(item))
    while (this.items.length > 500 || this.bytes > 262_144) this.bytes -= Buffer.byteLength(JSON.stringify(this.items.shift()!))
  }
  stream(key: string, kind: FleetActivityItem['kind'], value: unknown, final = false) {
    if (typeof value !== 'string' || !value) return
    key = key.slice(0, 1024)
    const previous = this.streams.get(key)
    if (previous?.final) return
    const suffix = final ? value.slice(previous?.length ?? 0) : value
    const tail = this.tails.get(key) ?? ''
    this.tailBytes -= Buffer.byteLength(tail)
    this.tails.delete(key)
    let safe = tail + suffix
    if (!final) {
      let keep = 0
      for (const secret of this.secrets) {
        for (let length = Math.min(secret.length - 1, safe.length); length > keep; length--) {
          if (safe.endsWith(secret.slice(0, length))) { keep = length; break }
        }
      }
      if (keep) {
        const pending = safe.slice(-keep)
        this.tailBytes += Buffer.byteLength(pending)
        if (this.tailBytes > 16_384) this.redactionFull = true
        else this.tails.set(key, pending)
        safe = safe.slice(0, -keep)
      }
    }
    this.add(kind, safe)
    // Only byte-free offsets survive; full native output is held solely by the ring.
    this.streams.set(key, { length: final ? value.length : (previous?.length ?? 0) + value.length, final })
    while (this.streams.size > 500) {
      const oldest = this.streams.keys().next().value!
      this.streams.delete(oldest)
      this.tailBytes -= Buffer.byteLength(this.tails.get(oldest) ?? '')
      this.tails.delete(oldest)
    }
  }
  read(state: FleetState, after = 0): FleetActivity {
    return { supported: true, generation: this.generation, state, items: this.items.filter(item => item.seq > after).map(item => ({ ...item })),
      next_cursor: this.seq, truncated: (this.items[0]?.seq ?? 1) > after + 1 }
  }
}
