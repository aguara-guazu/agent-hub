import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHttpEchoServer, type HttpEchoHandle } from '@agenthub/testdata/servers'
import {
  ConnectionPool,
  HostProcessRuntime,
  RemoteHttpRuntime,
  TRANSPORT_HTTP,
  TRANSPORT_STDIO,
  UpstreamSpec,
} from './runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const NOTES_ENTRY = resolve(here, '../../../testdata/dist/mcp_servers/notesServer.js')

function notesSpec(): UpstreamSpec {
  return UpstreamSpec.fromSnapshot({
    slug: 'notes',
    transport: 'stdio',
    command: process.execPath,
    args: [NOTES_ENTRY],
  })
}

describe('UpstreamSpec', () => {
  it('fingerprint cambia con el comando y no filtra secretos', () => {
    const a = new UpstreamSpec({ slug: 'x', transport: 'stdio', command: 'node', args: ['a.js'] })
    const b = new UpstreamSpec({ slug: 'x', transport: 'stdio', command: 'node', args: ['b.js'] })
    expect(a.fingerprint()).not.toBe(b.fingerprint())
    const withRef = new UpstreamSpec({ slug: 'x', transport: 'stdio', command: 'node', secret_refs: { T: 'env://X' } })
    expect(withRef.fingerprint()).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('ConnectionPool — eleccion de runtime', () => {
  it('sin motor de contenedores, stdio corre en el host y queda registrado', () => {
    const pool = new ConnectionPool(undefined, { detectContainers: false })
    const choice = pool.selectRuntime(new UpstreamSpec({ slug: 'ops', transport: 'stdio', command: 'node' }))
    expect(choice.runtime).toBe('host_process')
    expect(choice.isolated).toBe(false)
    expect(choice.reason).toMatch(/contenedores/)
  })

  it('http elige el runtime remoto', () => {
    const pool = new ConnectionPool(undefined, { detectContainers: false })
    const choice = pool.selectRuntime(new UpstreamSpec({ slug: 'r', transport: 'http', url: 'http://x/mcp' }))
    expect(choice.runtime).toBe('remote_http')
  })
})

describe('ConnectionPool — stdio real (notes)', () => {
  let pool: ConnectionPool
  afterEach(async () => {
    await pool?.close()
  })

  it('reintenta inmediatamente si se corrige la configuración que falló', async () => {
    pool = new ConnectionPool(undefined, {failureCooldownMs:60_000})
    const invalid = new UpstreamSpec({slug:'notes',transport:'stdio',command:'/nonexistent/agenthub-test-command'})
    await expect(pool.get('a',invalid)).rejects.toThrow()
    const result = await pool.callTool('a',notesSpec(),'list_notes',{})
    expect(result.is_error).toBe(false)
  })

  it('reusa una sola conexion entre llamadas (estado en memoria del upstream)', async () => {
    expect(existsSync(NOTES_ENTRY), `falta el dist de notes en ${NOTES_ENTRY}`).toBe(true)
    pool = new ConnectionPool({ [TRANSPORT_STDIO]: new HostProcessRuntime(), [TRANSPORT_HTTP]: new RemoteHttpRuntime() })
    const spec = notesSpec()
    await pool.callTool('a', spec, 'add_note', { title: 'uno' })
    await pool.callTool('a', spec, 'add_note', { title: 'dos' })
    const listed = await pool.callTool('a', spec, 'list_notes', {})
    // Si el pool reusa la conexion, el estado (dos notas) sobrevive entre llamadas.
    const notes = JSON.parse(String(listed.content[0]?.['text'] ?? '[]')) as unknown[]
    expect(notes.length).toBe(2)
    expect(pool.connectedSlugs('a')).toEqual(['notes'])
  }, 30_000)

  it('dos agentes no comparten proceso (invariante 1)', async () => {
    pool = new ConnectionPool({ [TRANSPORT_STDIO]: new HostProcessRuntime(), [TRANSPORT_HTTP]: new RemoteHttpRuntime() })
    const spec = notesSpec()
    await pool.callTool('a', spec, 'add_note', { title: 'de a' })
    const bList = await pool.callTool('b', spec, 'list_notes', {})
    // El agente b arranca con su propio proceso vacio.
    const bNotes = JSON.parse(String(bList.content[0]?.['text'] ?? '[]')) as unknown[]
    expect(bNotes.length).toBe(0)
  }, 30_000)
})

describe('ConnectionPool — http real (httpecho)', () => {
  let handle: HttpEchoHandle
  let pool: ConnectionPool
  afterEach(async () => {
    await pool?.close()
    await handle?.close()
  })

  it('lista y llama una herramienta por Streamable HTTP', async () => {
    handle = await startHttpEchoServer({ port: 0 })
    pool = new ConnectionPool({ [TRANSPORT_STDIO]: new HostProcessRuntime(), [TRANSPORT_HTTP]: new RemoteHttpRuntime() })
    const spec = UpstreamSpec.fromSnapshot({ slug: 'httpecho', transport: 'http', url: handle.url })
    const listing = await pool.listTools('a', [spec])
    expect(listing.errors).toEqual({})
    expect((listing.tools['httpecho'] ?? []).map((t) => t.name).sort()).toEqual(['echo', 'ping', 'whoami'])
    const result = await pool.callTool('a', spec, 'echo', { message: 'hola' })
    expect(result.content[0]?.['text']).toBe('hola')
  }, 30_000)
})
