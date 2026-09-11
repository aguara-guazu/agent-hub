/**
 * Utilidades de prueba: levanta la app contra una base SQLite descartable y expone un
 * cliente `inject` que habla HTTP en memoria (sin abrir puertos).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type CoreApp } from '../src/app.js'

export interface TestHarness extends CoreApp {
  dir: string
  cleanup(): void
}

export function makeApp(overrides: Record<string, unknown> = {}): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-core-'))
  const databasePath = join(dir, 'agenthub.db')
  const app = buildApp({ settings: { databasePath, ...overrides }, ensureOwner: false })
  return {
    ...app,
    dir,
    cleanup() {
      app.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
