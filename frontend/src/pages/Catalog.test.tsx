/** Pruebas del catalogo de MCP servers.
 *
 *  Dos cosas se prueban aca con mas insistencia que el resto:
 *
 *  - El formulario cambia de campos segun el transporte. Un server stdio sin
 *    comando o uno http sin URL no se puede sondear, y el error tiene que salir
 *    antes de llegar al backend.
 *  - Por el formulario no pasa una credencial. `secret_refs` lleva el NOMBRE del
 *    secreto; si alguien pega el valor, se rechaza y no se manda nada.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Catalog from './Catalog'
import type { ClientAccount, McpServer, McpTool, User } from '../lib/types'
import {
  buttonByText,
  click,
  installFetch,
  jsonResponse,
  need,
  qa,
  renderWithProviders,
  setValue,
  setupDom,
  teardownDom,
  titleOf,
} from '../test-utils'
import type { ApiCall } from '../test-utils'

/* -------------------------------------------------------------------------- */
/* Datos fabricados                                                             */
/* -------------------------------------------------------------------------- */

const admin: User = {
  id: 'u-1',
  email: 'luciano.serra@craftech.io',
  full_name: 'Luciano',
  org_role: 'admin',
  is_active: true,
  squads: [],
  organization: 'Craftech',
}

const ACCOUNTS: ClientAccount[] = [{ id: 'acc-acme', slug: 'acme', name: 'ACME Corp' }]

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    id: 't-1',
    name: 'create_issue',
    exposed_name: 'github__create_issue',
    title: 'Crear issue',
    description: 'Abre un issue en un repositorio',
    quarantined: false,
    quarantine_reason: '',
    ...overrides,
  }
}

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv-x',
    slug: 'x',
    display_name: 'X',
    description: '',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    secret_refs: {},
    auth: 'none',
    oauth_status: 'none',
    oauth_client_configured: false,
    requires_host_access: false,
    container_image: '',
    allow_hosts: [],
    allow_ports: [],
    read_mounts: [],
    write_mounts: [],
    definition_hash: 'sha256:0000000000',
    last_probe_error: '',
    tools: [],
    ...overrides,
  }
}

const QUARANTINED_TOOL = tool({
  id: 't-2',
  name: 'delete_repo',
  exposed_name: 'github__delete_repo',
  title: 'Borrar repositorio',
  description: 'Borra un repositorio entero',
  quarantined: true,
  quarantine_reason: 'la definicion cambio desde la ultima vez',
})

function catalog(): McpServer[] {
  return [
    server({
      id: 'srv-github',
      slug: 'github',
      display_name: 'GitHub',
      description: 'Mis repositorios',
      tools: [tool(), QUARANTINED_TOOL],
      definition_hash: 'sha256:abcdef0123456789',
    }),
    server({
      id: 'srv-jira',
      slug: 'jira',
      display_name: 'Jira',
      transport: 'http',
      command: '',
      url: 'https://mcp.jira.example/mcp',
      last_probe_error: 'no se pudo conectar: 502 Bad Gateway',
    }),
    server({ id: 'srv-acme', slug: 'acme-internal', display_name: 'ACME interno' }),
    server({ id: 'srv-legacy', slug: 'legacy', display_name: 'Legacy' }),
  ]
}

/* -------------------------------------------------------------------------- */
/* Utilidades de la suite                                                       */
/* -------------------------------------------------------------------------- */

/** La fila de la tabla que muestra ese slug. */
function rowOf(root: ParentNode, slug: string): HTMLElement {
  const rows = qa(root, 'tbody tr')
  const found = rows.find((row) =>
    qa(row, 'code').some((code) => (code.textContent ?? '').trim() === slug),
  )
  if (found === undefined) throw new Error(`no hay fila para el server «${slug}»`)
  return found
}

interface Scenario {
  servers?: McpServer[]
  handle?: (call: ApiCall) => Response | Promise<Response> | undefined
}

async function mountCatalog(scenario: Scenario = {}) {
  const servers = scenario.servers ?? catalog()
  const fetchMock = installFetch({
    user: admin,
    handle: (call) => {
      const own = scenario.handle?.(call)
      if (own !== undefined) return own
      if (call.path === '/catalog/servers' && call.method === 'GET') return jsonResponse(servers)
      if (call.path === '/identity/client-accounts') return jsonResponse(ACCOUNTS)
      return undefined
    },
  })
  const view = await renderWithProviders(<Catalog />, { route: '/catalog' })
  return { ...view, fetchMock }
}

/** El formulario vive en un portal sobre document.body, no dentro del container. */
function modal(): HTMLElement {
  return need(document.body, '.modal')
}

/* -------------------------------------------------------------------------- */
/* Lista                                                                        */
/* -------------------------------------------------------------------------- */

describe('<Catalog> lista', () => {
  beforeEach(() => {
    setupDom()
  })

  afterEach(() => {
    teardownDom()
  })

  it('muestra cada server con su transporte y el resultado del ultimo sondeo', async () => {
    const { container } = await mountCatalog()

    expect(qa(container, 'tbody tr')).toHaveLength(4)
    expect(container.textContent).toContain('4 de 4')

    // Ya no hay estado de admision ni columna de instalado: el server es tuyo.
    expect(container.textContent).not.toContain('Aprobado')
    expect(container.textContent).not.toContain('Instalado')

    const jira = rowOf(container, 'jira')
    expect(jira.textContent).toContain('http')
    const probeError = qa(jira, '.badge').find((badge) => (badge.textContent ?? '').includes('con error'))
    expect(titleOf(probeError)).toBe('no se pudo conectar: 502 Bad Gateway')
  })

  it('cualquier persona, sin ser admin, puede crear y editar los suyos', async () => {
    const { container } = await mountCatalog()
    expect(buttonByText(container, 'Nuevo MCP server')).toBeDefined()
    expect(buttonByText(rowOf(container, 'github'), 'Editar')).toBeDefined()
    expect(buttonByText(rowOf(container, 'github'), 'Eliminar')).toBeDefined()
  })

  it('avisa cuantas herramientas hay en cuarentena y por que no se exponen', async () => {
    const { container } = await mountCatalog()
    const callout = need(container, '.callout-warning')
    expect(callout.textContent).toContain('Hay 1 herramienta(s) en cuarentena')
    expect(callout.textContent).toContain('No se exponen a ningún cliente')
  })

  it('una herramienta en cuarentena se ve marcada con su motivo', async () => {
    const { container } = await mountCatalog()

    const toggle = need<HTMLButtonElement>(rowOf(container, 'github'), 'button.link-button')
    expect(toggle.textContent).toContain('1 en cuarentena')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await click(toggle)

    const detail = need(container, 'tr.detail-row')
    const quarantined = need(detail, 'li.tool.quarantined')
    expect(quarantined.textContent).toContain('github__delete_repo')
    expect(quarantined.textContent).toContain('cuarentena')
    expect(quarantined.textContent).toContain('la definicion cambio desde la ultima vez')

    // La herramienta sana sigue estando y no queda marcada.
    const tools = qa(detail, 'li.tool')
    expect(tools).toHaveLength(2)
    expect(tools.filter((item) => item.classList.contains('quarantined'))).toHaveLength(1)
  })

  it('el buscador filtra por slug', async () => {
    const { container } = await mountCatalog()

    await setValue(need(container, '#catalog-search'), 'jira')

    expect(qa(container, 'tbody tr')).toHaveLength(1)
    expect(container.textContent).toContain('1 de 4')
  })

  it('el boton de aceptar cambios aparece solo si hay algo en cuarentena', async () => {
    const { container, fetchMock } = await mountCatalog({
      handle: (call) =>
        call.path === '/catalog/servers/srv-github/approve' && call.method === 'POST'
          ? jsonResponse(server({ id: 'srv-github', slug: 'github', display_name: 'GitHub' }))
          : undefined,
    })

    const textos = (root: ParentNode) => qa(root, 'button').map((b) => b.textContent ?? '')
    expect(textos(rowOf(container, 'jira'))).not.toContain('Aceptar cambios')
    expect(textos(rowOf(container, 'github'))).toContain('Aceptar cambios')

    await click(buttonByText(rowOf(container, 'github'), 'Aceptar cambios'))
    expect(fetchMock.callsTo('/catalog/servers/srv-github/approve', 'POST')).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Formulario                                                                   */
/* -------------------------------------------------------------------------- */

describe('<ServerForm> desde el catalogo', () => {
  beforeEach(() => {
    setupDom()
  })

  afterEach(() => {
    teardownDom()
  })

  async function openForm() {
    const view = await mountCatalog()
    await click(buttonByText(view.container, 'Nuevo MCP server'))
    return view
  }

  it('pide comando para stdio y URL para http, nunca los dos', async () => {
    await openForm()

    // stdio es el valor por defecto: proceso local.
    expect(modal().querySelector('#server-command')).not.toBeNull()
    expect(modal().querySelector('#server-args')).not.toBeNull()
    expect(modal().querySelector('#server-url')).toBeNull()

    await setValue(need(modal(), '#server-transport'), 'http')

    expect(modal().querySelector('#server-url')).not.toBeNull()
    expect(modal().querySelector('#server-headers')).not.toBeNull()
    expect(modal().querySelector('#server-command')).toBeNull()
    expect(modal().querySelector('#server-env')).toBeNull()
  })

  it('un server http sin URL no se guarda', async () => {
    const { fetchMock } = await openForm()

    await setValue(need(modal(), '#server-slug'), 'remoto')
    await setValue(need(modal(), '#server-name'), 'Remoto')
    await setValue(need(modal(), '#server-transport'), 'http')
    await click(buttonByText(modal(), 'Crear server'))

    expect(need(modal(), '.form-errors').textContent).toContain('Un server http necesita una URL.')
    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
  })

  it('un server stdio sin comando no se guarda', async () => {
    const { fetchMock } = await openForm()

    await setValue(need(modal(), '#server-slug'), 'local')
    await setValue(need(modal(), '#server-name'), 'Local')
    await click(buttonByText(modal(), 'Crear server'))

    expect(need(modal(), '.form-errors').textContent).toContain('Un server stdio necesita un comando.')
    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
  })

  it('rechaza un valor con pinta de secreto en secret_refs y no manda nada', async () => {
    const { fetchMock } = await openForm()

    await setValue(need(modal(), '#server-slug'), 'github-nuevo')
    await setValue(need(modal(), '#server-name'), 'GitHub nuevo')
    await setValue(need(modal(), '#server-command'), 'npx')
    await setValue(
      need(modal(), '#server-secret-refs'),
      'GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    )
    await click(buttonByText(modal(), 'Crear server'))

    const errors = need(modal(), '.form-errors')
    expect(errors.getAttribute('role')).toBe('alert')
    expect(errors.textContent).toContain('secret_refs «GITHUB_TOKEN»')
    expect(errors.textContent).toContain('prefijo de credencial conocido')
    expect(errors.textContent).toContain('Aquí va el NOMBRE del secreto en el gestor, nunca su valor.')
    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
  })

  it('tambien rechaza una credencial pegada en las variables de entorno', async () => {
    const { fetchMock } = await openForm()

    await setValue(need(modal(), '#server-slug'), 'github-nuevo')
    await setValue(need(modal(), '#server-name'), 'GitHub nuevo')
    await setValue(need(modal(), '#server-command'), 'npx')
    await setValue(need(modal(), '#server-env'), 'GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a')
    await click(buttonByText(modal(), 'Crear server'))

    expect(need(modal(), '.form-errors').textContent).toContain('env «GITHUB_TOKEN»')
    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
  })

  it('acepta una referencia por nombre y manda el alta con el cuerpo del contrato', async () => {
    const created = server({ id: 'srv-nuevo', slug: 'github-nuevo', display_name: 'GitHub nuevo' })
    const { container, fetchMock } = await mountCatalog({
      handle: (call) =>
        call.path === '/catalog/servers' && call.method === 'POST' ? jsonResponse(created) : undefined,
    })
    await click(buttonByText(container, 'Nuevo MCP server'))

    await setValue(need(modal(), '#server-slug'), 'github-nuevo')
    await setValue(need(modal(), '#server-name'), 'GitHub nuevo')
    await setValue(need(modal(), '#server-command'), 'npx')
    await setValue(need(modal(), '#server-args'), '-y\n@modelcontextprotocol/server-github')
    await setValue(need(modal(), '#server-secret-refs'), 'GITHUB_TOKEN=keychain://agenthub/github')
    await click(buttonByText(modal(), 'Crear server'))

    expect(fetchMock.lastCall('/catalog/servers', 'POST')?.body).toEqual({
      slug: 'github-nuevo',
      display_name: 'GitHub nuevo',
      description: '',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
      cwd: '',
      url: '',
      headers: {},
      secret_refs: { GITHUB_TOKEN: 'keychain://agenthub/github' },
      auth: 'none',
      requires_host_access: true,
      container_image: '',
      allow_hosts: [],
      allow_ports: [],
      read_mounts: [],
      write_mounts: [],
    })
    // Se guardo: el formulario se cierra y el aviso pide sondear.
    expect(document.querySelector('.modal')).toBeNull()
    expect(container.textContent).toContain('github-nuevo guardado')
    expect(container.textContent).toContain('Sondea el server')
  })

  it('rechaza una referencia mal formada antes de mandarla', async () => {
    // `keychain:agenthub/x` (una sola barra) es el error tipico. Sin esta validacion
    // el daemon lo rechaza recien al conectar, o sea en la primera llamada de un
    // agente y no cuando la persona guarda el server.
    const view = await openForm()
    const { fetchMock } = view
    await setValue(need(modal(), '#server-slug'), 'malo')
    await setValue(need(modal(), '#server-name'), 'Malo')
    await setValue(need(modal(), '#server-command'), 'npx')
    await setValue(need(modal(), '#server-secret-refs'), 'T=keychain:agenthub/x')
    await click(need(modal(), 'button[type=submit]'))

    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
    expect(need(modal(), '.form-errors').textContent).toContain('no es una referencia')
    view.unmount()
  })

  it('rechaza un esquema que el daemon no resuelve', async () => {
    const view = await openForm()
    const { fetchMock } = view
    await setValue(need(modal(), '#server-slug'), 'vault')
    await setValue(need(modal(), '#server-name'), 'Vault')
    await setValue(need(modal(), '#server-command'), 'npx')
    await setValue(need(modal(), '#server-secret-refs'), 'T=vault://equipo/github')
    await click(need(modal(), 'button[type=submit]'))

    expect(fetchMock.callsTo('/catalog/servers', 'POST')).toHaveLength(0)
    const texto = need(modal(), '.form-errors').textContent ?? ''
    expect(texto).toContain('vault')
    expect(texto).toContain('env, file, keychain')
    view.unmount()
  })

})
