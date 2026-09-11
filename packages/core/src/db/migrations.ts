/**
 * Migraciones TypeScript sobre `node:sqlite`.
 *
 * Reglas del documento de arquitectura, que este módulo implementa:
 *
 * 1. Reconocen bases de versiones anteriores: si ya tienen el esquema no recrean
 *    tablas ni datos, sólo registran la versión actual.
 * 2. Hacen copia de seguridad de `agenthub.db` ANTES de modificar el esquema, para que
 *    un cambio nunca destruya la única copia local de los datos de alguien.
 * 3. Registran su propia versión en `schema_migrations`.
 *
 * Los ids son UUID4 en texto, los timestamps ISO-8601 UTC y los documentos JSON
 * canónico. La tabla `alembic_version` sólo se reconoce como marcador histórico.
 */
import { copyFileSync, existsSync } from 'node:fs'
import type { Database } from './database.js'
import { nowIso } from '@agenthub/shared'

/** Cada paso del esquema. `id` es la clave que queda en `schema_migrations`. */
export interface Migration {
  id: string
  /** SQL literal, o una función cuando hace falta mirar el esquema antes (SQLite no
   *  tiene `ADD COLUMN IF NOT EXISTS`). */
  statements: Array<string | ((db: Database) => void)>
}

/** `ALTER TABLE ... ADD COLUMN` idempotente. */
export function addColumnIfMissing(table: string, column: string, definition: string): (db: Database) => void {
  return (db) => {
    const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * Esquema completo, equivalente a `migrations/versions/0001` + las migraciones
 * posteriores (`aislamiento en contenedor`, `el catalogo es de la persona`) ya
 * plegadas. Es idempotente: cada `CREATE` lleva `IF NOT EXISTS`.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001_esquema_inicial',
    statements: [
      `CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS client_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, slug)
      )`,
      `CREATE TABLE IF NOT EXISTS squads (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        client_account_id TEXT REFERENCES client_accounts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, slug)
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        full_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        org_role TEXT NOT NULL DEFAULT 'member',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, email)
      )`,
      `CREATE TABLE IF NOT EXISTS squad_memberships (
        id TEXT PRIMARY KEY,
        squad_id TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (squad_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS ix_membership_user ON squad_memberships (user_id)`,
      `CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hostname TEXT NOT NULL,
        os TEXT NOT NULL DEFAULT '',
        daemon_version TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        last_snapshot_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, hostname)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
        cli_kind TEXT NOT NULL,
        cli_version TEXT NOT NULL DEFAULT '',
        config_path TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_connected_at TEXT,
        last_listed_hash TEXT,
        drift_detected INTEGER NOT NULL DEFAULT 0,
        drift_detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (machine_id, cli_kind)
      )`,
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        machine_id TEXT REFERENCES machines(id) ON DELETE CASCADE,
        agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ix_token_hash ON api_tokens (token_hash)`,
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        cwd TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        headers TEXT NOT NULL DEFAULT '{}',
        secret_refs TEXT NOT NULL DEFAULT '{}',
        requires_host_access INTEGER NOT NULL DEFAULT 0,
        container_image TEXT NOT NULL DEFAULT '',
        allow_hosts TEXT NOT NULL DEFAULT '[]',
        allow_ports TEXT NOT NULL DEFAULT '[]',
        read_mounts TEXT NOT NULL DEFAULT '[]',
        write_mounts TEXT NOT NULL DEFAULT '[]',
        definition_hash TEXT NOT NULL DEFAULT '',
        last_probe_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, slug)
      )`,
      `CREATE INDEX IF NOT EXISTS ix_mcp_server_user ON mcp_servers (user_id)`,
      `CREATE TABLE IF NOT EXISTS mcp_tools (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        exposed_name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        input_schema TEXT NOT NULL DEFAULT '{}',
        definition_hash TEXT NOT NULL DEFAULT '',
        quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (server_id, name)
      )`,
      `CREATE INDEX IF NOT EXISTS ix_tool_exposed ON mcp_tools (exposed_name)`,
      `CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, slug)
      )`,
      `CREATE INDEX IF NOT EXISTS ix_skill_user ON skills (user_id)`,
      `CREATE TABLE IF NOT EXISTS exposure_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'inherit',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, agent_instance_id, resource_type, resource_id)
      )`,
      `CREATE INDEX IF NOT EXISTS ix_rule_user ON exposure_rules (user_id)`,
      `CREATE INDEX IF NOT EXISTS ix_rule_agent ON exposure_rules (agent_instance_id)`,
      `CREATE TABLE IF NOT EXISTS exposure_snapshots (
        id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
        snapshot_hash TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ix_snapshot_agent ON exposure_snapshots (agent_instance_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '{}',
        prev_hash TEXT NOT NULL DEFAULT '',
        event_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ix_audit_org_time ON audit_events (organization_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS tool_call_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agent_instance_id TEXT REFERENCES agent_instances(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        server_slug TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        exposed_name TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT 'allow',
        denial_reason TEXT NOT NULL DEFAULT '',
        args_digest TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ix_call_agent_time ON tool_call_logs (agent_instance_id, created_at)`,
    ],
  },
  {
    id: '0002_local_client_sync',
    statements: [`CREATE TABLE IF NOT EXISTS local_client_sync (
      agent_id TEXT PRIMARY KEY REFERENCES agent_instances(id) ON DELETE CASCADE,
      snapshot_hash TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL
    )`],
  },
  {
    // Cómo se autentica el hub ante un server http: `none` u `oauth`. Los tokens no
    // van acá: viven en archivos 0600 del directorio de estado.
    id: '0003_mcp_server_auth',
    statements: [addColumnIfMissing('mcp_servers', 'auth', "TEXT NOT NULL DEFAULT 'none'")],
  },
  {
    // Ajustes internos de la app (p. ej. qué versión del catálogo inicial ya se aplicó).
    id: '0004_app_settings',
    statements: [`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`],
  },
]

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`

/** Reconoce un esquema completo de una versión anterior. */
function hasLegacySchema(db: Database): boolean {
  return db.tableExists('alembic_version') || db.tableExists('organizations')
}

function appliedIds(db: Database): Set<string> {
  const rows = db.all<{ id: string }>('SELECT id FROM schema_migrations')
  return new Set(rows.map((row) => row.id))
}

/**
 * Copia de seguridad de la base antes de tocar el esquema. Devuelve la ruta escrita, o
 * `null` si no había base todavía (una base nueva no tiene datos que preservar).
 */
export function backupDatabase(path: string): string | null {
  if (!existsSync(path)) return null
  const stamp = nowIso().replace(/[:.]/g, '-')
  const backupPath = `${path}.${stamp}.bak`
  copyFileSync(path, backupPath)
  return backupPath
}

export interface MigrationOutcome {
  applied: string[]
  recognizedExisting: boolean
  backupPath: string | null
}

/**
 * Deja la base lista. Idempotente.
 *
 * - Si `schema_migrations` ya registra todas las migraciones, no toca nada.
 * - Si la base viene de una versión anterior con las tablas creadas pero sin registro
 *   actual, reconoce el esquema y sólo escribe `schema_migrations`.
 * - Antes de aplicar cualquier paso sobre una base que YA existe en disco, hace backup.
 */
export function runMigrations(db: Database, path: string): MigrationOutcome {
  db.exec(SCHEMA_MIGRATIONS_DDL)
  const already = appliedIds(db)
  const pending = MIGRATIONS.filter((migration) => !already.has(migration.id))
  const recognizedExisting = hasLegacySchema(db)

  if (pending.length === 0) {
    return { applied: [], recognizedExisting, backupPath: null }
  }

  // Backup sólo cuando hay datos en disco y algo por aplicar: una base nueva creada en
  // esta misma corrida no necesita respaldo.
  if (recognizedExisting) db.exec('PRAGMA wal_checkpoint(FULL)')
  const backupPath = recognizedExisting ? backupDatabase(path) : null

  const applied: string[] = []
  db.transaction(() => {
    for (const migration of pending) {
      for (const statement of migration.statements) {
        if (typeof statement === 'string') db.exec(statement)
        else statement(db)
      }
      db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', migration.id, nowIso())
      applied.push(migration.id)
    }
  })

  return { applied, recognizedExisting, backupPath }
}
