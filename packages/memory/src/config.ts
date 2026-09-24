import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { SecretResolver } from '@agenthub/gateway'
import { check } from './contracts.js'

export interface AIConfig {
  extraction: 'disabled' | 'deepseek' | 'ollama' | 'opencode'
  extraction_model: string
  embeddings_enabled: boolean
  embedding_model: string
  ollama_url: string
  remote_processing_enabled: boolean
  /** High-confidence identity matches and duplicate verdicts are applied without waiting for review. */
  identity_auto_merge: boolean
  /** A source without project is linked to the project the model names with high confidence; anything else becomes a suggestion. */
  project_auto_assign: boolean
}
export const defaultAI: AIConfig = {
  extraction: 'disabled', extraction_model: 'deepseek-flash', embeddings_enabled: false,
  embedding_model: 'nomic-embed-text', ollama_url: 'http://127.0.0.1:11434', remote_processing_enabled: false, identity_auto_merge: true,
  project_auto_assign: true,
}

/** OpenCode can route any model to a remote endpoint; keep source/project exclusions conservative. */
export function usesRemoteExtraction(config: AIConfig): boolean {
  return config.extraction === 'deepseek' || config.extraction === 'opencode'
}

/** Secret files are private, atomic, outside the repository and excluded from exports. */
export class Vault {
  private resolver = new SecretResolver(undefined, { ttlMs: 0 })
  constructor(readonly directory: string) {}
  private path(key: string): string {
    check(/^[a-zA-Z0-9_-]{1,100}$/.test(key), 'Nombre de credencial inválido')
    return join(this.directory, 'secrets', `${key}.json`)
  }
  has(key: string): boolean { return existsSync(this.path(key)) }
  read<T = Record<string, any>>(key: string): T | null {
    const path = this.path(key)
    if (!existsSync(path)) return null
    try { return JSON.parse(this.resolver.resolve(`file://${path}`)) as T }
    catch { throw new Error('No se pudo leer una credencial local; revisá su configuración y permisos') }
  }
  save(key: string, value: unknown): void {
    const path = this.path(key)
    mkdirSync(join(this.directory, 'secrets'), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }
  mcpCredential(): { token: string; reference: string } {
    const path = join(this.directory, 'secrets', 'memory-mcp')
    mkdirSync(join(this.directory, 'secrets'), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) writeFileSync(path, `Bearer ${randomBytes(32).toString('base64url')}`, { mode: 0o600, flag: 'wx' })
    return { token: this.resolver.resolve(`file://${path}`), reference: `file://${path}` }
  }
}
export function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function localUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('URL local inválida') }
  check(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'El servicio debe estar en esta computadora')
  return url.toString().replace(/\/$/, '')
}
