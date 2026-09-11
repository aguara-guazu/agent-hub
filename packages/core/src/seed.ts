/**
 * Datos de arranque para desarrollo local. Espeja `backend/agenthub/seed.py`.
 *
 * Crea una organización con dos squads y tres personas, y le da a cada una SUS propios
 * MCP servers y skills. `dev@craftech.io` y `data@craftech.io` comparten el slug `notes`
 * apuntando a lo mismo, lo cual es válido: la unicidad es `(user_id, slug)`.
 */
import { createHash } from 'node:crypto'
import { buildExposedName } from './naming.js'
import { hashPassword, NO_LOCAL_PASSWORD } from './security.js'
import { Store } from './store.js'
import type { Organization, User } from './types.js'

export const DEMO_PASSWORD = 'agenthub'

const REPO_ROOT = process.env.AGENTHUB_SEED_REPO_ROOT || process.cwd()
const TESTDATA_DIST = process.env.AGENTHUB_SEED_TESTDATA_DIST || `${REPO_ROOT}/testdata/dist/mcp_servers`

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

const TOOL_DEFS: Record<string, [string, string][]> = {
  notes: [
    ['add_note', 'Agrega una nota al bloc compartido'],
    ['list_notes', 'Lista las notas guardadas'],
  ],
  ops: [
    ['check_status', 'Devuelve el estado de un servicio'],
    ['restart_service', 'Reinicia un servicio. Destructiva.'],
  ],
}

function addTools(store: Store, serverId: string, slug: string, defs: [string, string][], taken: Set<string>): void {
  for (const [name, description] of defs) {
    const exposed = buildExposedName(slug, name, taken)
    taken.add(exposed)
    store.insertTool({
      server_id: serverId,
      name,
      exposed_name: exposed,
      title: '',
      description,
      input_schema: { type: 'object', properties: {} },
      definition_hash: '',
    })
  }
}

export function seed(store: Store, passwordHash = NO_LOCAL_PASSWORD): Organization {
  const existing = store.organizationBySlug('craftech')
  if (existing) return existing

  const org = store.insertOrganization('craftech', 'Craftech')
  const acme = store.insertClientAccount(org.id, 'acme', 'Acme Corp')
  const platform = store.insertSquad({ organization_id: org.id, slug: 'platform', name: 'Platform', client_account_id: null })
  const data = store.insertSquad({ organization_id: org.id, slug: 'data', name: 'Data e IA', client_account_id: acme.id })

  const admin = store.insertUser({
    organization_id: org.id,
    email: 'admin@craftech.io',
    full_name: 'Admin de la org',
    password_hash: passwordHash,
    org_role: 'owner',
  })
  const lucia = store.insertUser({
    organization_id: org.id,
    email: 'dev@craftech.io',
    full_name: 'Dev de Platform',
    password_hash: passwordHash,
    org_role: 'member',
  })
  const dana = store.insertUser({
    organization_id: org.id,
    email: 'data@craftech.io',
    full_name: 'Dev de Data',
    password_hash: passwordHash,
    org_role: 'member',
  })

  store.upsertMembership({ squad_id: platform.id, user_id: admin.id, role: 'lead', valid_from: null, valid_to: null })
  store.upsertMembership({ squad_id: platform.id, user_id: lucia.id, role: 'member', valid_from: null, valid_to: null })
  store.upsertMembership({ squad_id: data.id, user_id: dana.id, role: 'lead', valid_from: null, valid_to: null })

  const catalog: [User, [string, string, string][]][] = [
    [admin, [['notes', 'Notas', 'notesServer.js'], ['ops', 'Operaciones', 'opsServer.js']]],
    [lucia, [['notes', 'Notas', 'notesServer.js'], ['ops', 'Operaciones', 'opsServer.js']]],
    [dana, [['notes', 'Notas', 'notesServer.js']]],
  ]

  for (const [user, servers] of catalog) {
    const taken = new Set<string>()
    for (const [slug, name, mod] of servers) {
      const server = store.insertServer({
        user_id: user.id,
        slug,
        display_name: name,
        description:
          slug === 'notes'
            ? 'Server stdio local de prueba.'
            : 'Herramientas de operacion, incluida una destructiva para probar toggles.',
        transport: 'stdio',
        command: process.execPath,
        args: [`${TESTDATA_DIST}/${mod}`],
        env: {},
        cwd: REPO_ROOT,
        url: '',
        headers: {},
        secret_refs: {},
        requires_host_access: false,
        container_image: '',
        allow_hosts: [],
        allow_ports: [],
        read_mounts: [],
        write_mounts: [],
      })
      addTools(store, server.id, slug, TOOL_DEFS[slug]!, taken)
    }
  }

  store.insertSkill({
    user_id: lucia.id,
    slug: 'runbook-rds',
    display_name: 'Runbook de incidentes RDS',
    description: 'Como responder un incidente de Amazon RDS paso a paso.',
    body: '# Runbook de incidentes RDS\n\n1. Confirmar la alarma.\n2. Revisar conexiones.\n',
    content_hash: hash('runbook-rds'),
  })
  store.insertSkill({
    user_id: admin.id,
    slug: 'estilo-craftech',
    display_name: 'Estilo de escritura Craftech',
    description: 'Como escribir propuestas y documentacion en Craftech.',
    body: '# Estilo\n\nEspanol neutro. Citar fuentes. Senalar los problemas.\n',
    content_hash: hash('estilo-craftech'),
  })

  return org
}

/** Siembra la base del archivo dado. Punto de entrada del script `npm run seed`. */
export async function main(): Promise<void> {
  const { buildApp } = await import('./app.js')
  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const app = buildApp({ ensureOwner: false })
  try {
    const org = app.store.db.transaction(() => seed(app.store, passwordHash))
    process.stdout.write(`Organizacion sembrada: ${org.slug} (${org.id})\n`)
    process.stdout.write(`Usuarios: admin@craftech.io / dev@craftech.io / data@craftech.io  —  clave: ${DEMO_PASSWORD}\n`)
  } finally {
    await app.fastify.close()
    app.db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
