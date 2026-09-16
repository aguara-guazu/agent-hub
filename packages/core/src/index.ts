/**
 * Punto de entrada del control plane local. Exporta el constructor de la app Fastify,
 * el acceso a datos y las piezas de política/auditoría reutilizables por el daemon, el
 * gateway y las pruebas.
 */
export { buildApp, HttpError, type CoreApp, type BuildAppOptions } from './app.js'
export { loadSettings, type Settings, DEFAULT_STATE_DIR } from './config.js'
export { Database } from './db/database.js'
export { runMigrations, backupDatabase, MIGRATIONS, type MigrationOutcome } from './db/migrations.js'
export { Store, cmp } from './store.js'
export * from './types.js'
export {
  computeSnapshot,
  explain,
  loadContext,
  loadShared,
  resolveResource,
  type Decision,
  type ResolutionContext,
  type SharedResolution,
} from './policy/resolver.js'
export { buildMatrix, computePropagation, hotReload, type MatrixResponse } from './matrix.js'
export { record as auditRecord, verify as auditVerify, computeHash, GENESIS_HASH } from './audit/ledger.js'
export { probeServer, type ProbeResult, type DiscoveredTool } from './catalog/probe.js'
export { applyProbeResult, QUARANTINE_TOOL_MISSING, type SyncOutcome } from './catalog/reconcile.js'
export { ProbeRetryScheduler, DEFAULT_PROBE_RETRY_MS, isConfigured, isEnabledForOwner, needsRetry, type ProbeRetryDeps } from './catalog/retry.js'
export { applyStarterCatalog, STARTER_SERVERS, STARTER_CATALOG_VERSION, type StarterServer, type StarterOutcome } from './catalog/starter.js'
export { applyFactorySkill, type FactorySkill, type FactorySkillOutcome } from './catalog/factory-skills.js'
export { hubSkill, renderHubSkill, HUB_SKILL_SLUG, HUB_SKILL_DISPLAY_NAME, HUB_SKILL_DESCRIPTION } from './catalog/hub-skill.js'
export {
  QUARANTINE_DEFINITION_CHANGED,
  definitionHash,
  skillContentHash,
  toolsHash,
} from './hashing.js'
export {
  buildExposedName,
  finalNameFor,
  isValidExposedName,
  nameFitsEverywhere,
  slugifySegment,
  CLIENT_PREFIXES,
  SERVER_ALIAS,
} from './naming.js'
export {
  createAccessToken,
  decodeAccessToken,
  generateDaemonToken,
  hashDaemonToken,
  hashPassword,
  verifyPassword,
  DAEMON_TOKEN_PREFIX,
  NO_LOCAL_PASSWORD,
} from './security.js'
export { ensureLocalOwner, localEmail, systemUser, LOCAL_ORG_SLUG } from './local.js'
export {
  InvalidationBus,
  Subscription,
  agentScopeKeys,
  affectedAgentIds,
  publishPolicyChange,
  key as scopeKey,
  type Scope,
} from './events.js'
export { seed } from './seed.js'
