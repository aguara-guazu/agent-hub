import type { MemoryStore } from '../store.js'
import type { Vault } from '../config.js'
import type { GoogleAuth } from '../google-auth.js'
import type { ProviderHttp } from './http.js'
export interface Connector {
  id: string; provider: 'google' | 'notion' | 'slack' | 'jira'; name: string;
  config: Record<string, any>; project_ids: string[]; cursor: Record<string, any>;
  enabled: boolean; interval_minutes: number
}
export interface ConnectorContext {
  store: MemoryStore; vault: Vault; google: GoogleAuth; http: ProviderHttp;
  progress(value: Record<string, unknown>): Promise<void>
  checkpoint(cursor: Record<string, unknown>): Promise<void>
  signal: AbortSignal
}
