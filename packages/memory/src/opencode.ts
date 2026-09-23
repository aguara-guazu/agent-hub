import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, MemoryError } from './contracts.js'

export interface OpenCodeModel { id: string; name: string }
export interface OpenCodeStatus { installed: boolean; models: OpenCodeModel[]; detail?: string }
interface Connection { child: ChildProcess; url: string; password: string; directory: string; lifetime: AbortController; stopping?: Promise<void> }
interface Options {
  executable?: () => string | undefined
  launch?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  startupMs?: number
  requestMs?: number
  idleMs?: number
}

/** GUI apps do not necessarily inherit the user's shell PATH. Never invoke a shell to find/run the CLI. */
export function findOpenCode(env = process.env, home = homedir()): string | undefined {
  const directories = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.opencode/bin'),
    join(home, '.local/bin'), join(home, '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []), join(home, 'scoop/apps/opencode/current')]
  try { for (const version of readdirSync(join(home, '.nvm/versions/node'))) directories.push(join(home, '.nvm/versions/node', version, 'bin')) } catch { /* optional */ }
  for (const dir of directories) {
    const candidates = process.platform === 'win32'
      ? [join(dir, 'opencode.exe'), ...['', 'node_modules/opencode-ai/'].map(prefix => join(dir, prefix, 'node_modules', `opencode-windows-${process.arch}`, 'bin/opencode.exe'))]
      : [join(dir, 'opencode')]
    for (const path of candidates) {
      try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path } catch { /* next installation */ }
    }
  }
  return undefined
}

/** Local authenticated server; credentials/providers remain owned by OpenCode. No transcript goes in argv or Agent Hub logs. */
export class OpenCodeRuntime {
  private pending: Promise<Connection> | undefined
  private connection: Connection | undefined
  private starting: Connection | undefined
  private idle?: ReturnType<typeof setTimeout>
  private active = 0
  constructor(private directory: string, private options: Options = {}) {}

  private async start(signal?: AbortSignal): Promise<Connection> {
    const executable = (this.options.executable ?? findOpenCode)()
    check(executable, 'No se encontró OpenCode. Instalalo y conectá un proveedor para procesar reuniones.', 409)
    await mkdir(join(this.directory, 'opencode'), { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(this.directory, 'opencode/run-'))
    if (signal?.aborted) { await rm(directory, { recursive: true, force: true }); signal.throwIfAborted() }
    const password = randomBytes(32).toString('base64url')
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'agenthub',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', snapshot: false, autoupdate: false,
        compaction: { auto: false }, default_agent: 'agenthub-memory',
        agent: { 'agenthub-memory': { mode: 'primary', description: 'Extracción de memoria con evidencia',
          prompt: 'Extraé únicamente la información solicitada de la evidencia recibida.', steps: 3, permission: { '*': 'deny', StructuredOutput: 'allow' } } } }),
    }
    // Do not inherit an unrelated project's config override. Global provider/auth configuration is retained.
    delete (env as NodeJS.ProcessEnv).OPENCODE_CONFIG
    delete (env as NodeJS.ProcessEnv).OPENCODE_CONFIG_DIR
    const child = (this.options.launch ?? spawn)(process.execPath, [fileURLToPath(new URL('./opencode-host.js', import.meta.url)), executable!], {
      cwd: directory, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    })
    const connection: Connection = { child, url: '', password, directory, lifetime: new AbortController() }
    this.starting = connection
    const abort = () => connection.lifetime.abort()
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', abort)
    child.once('exit', () => { connection.lifetime.abort(); if (this.connection === connection) this.connection = undefined })
    try {
      connection.url = await new Promise<string>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => fail(), this.options.startupMs ?? 60_000)
        const cleanup = () => { clearTimeout(timeout); child.stdout?.off('data', onData); connection.lifetime.signal.removeEventListener('abort', fail) }
        const fail = () => { cleanup(); reject(new MemoryError(502, 'OpenCode no pudo iniciar en segundo plano. Revisá su instalación y configuración.')) }
        const onData = (data: Buffer) => {
          output = (output + data.toString()).slice(-8192)
          const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
          if (match) { cleanup(); resolve(match[1]!) }
        }
        child.stdout?.on('data', onData)
        connection.lifetime.signal.addEventListener('abort', fail, { once: true })
        if (connection.lifetime.signal.aborted) fail()
      })
      child.stdout?.resume()
      this.connection = connection
      return connection
    } catch (error) { await this.stop(connection); signal?.throwIfAborted(); throw error }
    finally { this.starting = undefined; signal?.removeEventListener('abort', abort) }
  }

  private stop(connection: Connection): Promise<void> {
    return connection.stopping ??= this.stopChild(connection)
  }

  private async stopChild(connection: Connection) {
    if (this.connection === connection) this.connection = undefined
    connection.lifetime.abort()
    const child = connection.child
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2500)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.stdin?.end()
        child.kill('SIGTERM')
      })
    }
    await rm(connection.directory, { recursive: true, force: true })
  }

  async close() {
    clearTimeout(this.idle)
    const connection = this.connection ?? this.starting ?? await this.pending?.catch(() => undefined)
    if (connection) await this.stop(connection)
  }

  private async use<T>(action: (connection: Connection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    clearTimeout(this.idle)
    this.active++
    try {
      if (!this.connection) this.pending ??= this.start(signal).finally(() => { this.pending = undefined })
      const connection = this.connection ?? await this.pending!
      return await action(connection)
    } finally {
      if (--this.active === 0) { this.idle = setTimeout(() => { if (!this.active) void this.close().catch(() => undefined) }, this.options.idleMs ?? 30_000); this.idle.unref() }
    }
  }

  private async request(connection: Connection, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`${connection.url}${path}`, {
      method, headers: { Authorization: `Basic ${Buffer.from(`agenthub:${connection.password}`).toString('base64')}`, 'Content-Type': 'application/json', 'x-opencode-directory': connection.directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([connection.lifetime.signal, AbortSignal.timeout(this.options.requestMs ?? 180_000), ...(signal ? [signal] : [])]),
    })
    check(response.ok, `OpenCode no pudo completar la solicitud (HTTP ${response.status}). Revisá el proveedor y el modelo configurados.`, 502)
    return response.status === 204 ? undefined : response.json()
  }

  private async models(connection: Connection): Promise<OpenCodeModel[]> {
    const data = await this.request(connection, '/provider')
    check(Array.isArray(data.all) && Array.isArray(data.connected), 'Actualizá OpenCode: su API de proveedores no es compatible.', 409)
    return data.all.filter((p: any) => data.connected.includes(p.id)).flatMap((p: any) =>
      Object.entries(p.models ?? {}).filter(([, m]: any) => m.status !== 'deprecated' && m.capabilities?.toolcall !== false && m.capabilities?.input?.text !== false).map(([id, m]: any) => ({ id: `${p.id}/${id}`, name: `${p.name ?? p.id} · ${m.name ?? id}` })))
      .sort((a: OpenCodeModel, b: OpenCodeModel) => a.name.localeCompare(b.name))
  }

  async status(): Promise<OpenCodeStatus> {
    if (!(this.options.executable ?? findOpenCode)()) return { installed: false, models: [], detail: 'Instalá OpenCode y conectá un proveedor para usarlo en segundo plano.' }
    try {
      const models = await this.use(c => this.models(c))
      return { installed: true, models, ...(!models.length ? { detail: 'Conectá un proveedor en OpenCode y actualizá la lista de modelos.' } : {}) }
    } catch (error) { return { installed: true, models: [], detail: error instanceof MemoryError ? error.message : 'No se pudo consultar OpenCode. Revisá su configuración.' } }
  }

  async extract(model: string, system: string, content: unknown, schema: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.use(async connection => {
      let sessionId: string | undefined
      const cancel = () => { void this.stop(connection).catch(() => undefined) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        signal?.throwIfAborted()
        const models = await this.models(connection)
        check(models.some(m => m.id === model), 'El modelo elegido ya no está disponible en OpenCode. Revisá el proveedor y volvé a elegirlo en Ajustes.', 409)
        const session = await this.request(connection, '/session', 'POST', { title: 'Agent Hub · procesamiento automático',
          permission: [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'StructuredOutput', pattern: '*', action: 'allow' }] }, signal)
        check(typeof session.id === 'string' && /^ses_[\w-]+$/.test(session.id), 'OpenCode devolvió una sesión inválida.', 502)
        sessionId = session.id
        const slash = model.indexOf('/')
        const result = await this.request(connection, `/session/${sessionId}/message`, 'POST', {
          model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }, agent: 'agenthub-memory', system,
          parts: [{ type: 'text', text: JSON.stringify(content) }], format: { type: 'json_schema', schema, retryCount: 2 },
        }, signal)
        check(!result.info?.error, 'OpenCode no pudo generar la extracción. Revisá la conexión, el acceso al modelo y el saldo del proveedor.', 502)
        const value = result.info?.structured ?? result.info?.structured_output
        check(value !== undefined && value !== null, 'OpenCode no devolvió el JSON estructurado requerido. Actualizá OpenCode o elegí un modelo compatible.', 502)
        const tokens = result.info?.tokens
        return { value, usage: { model, input_tokens: Number(tokens?.input ?? 0) + Number(tokens?.cache?.read ?? 0) + Number(tokens?.cache?.write ?? 0), output_tokens: Number(tokens?.output ?? 0) } }
      } catch (error) {
        // A timed-out HTTP request must not leave model generation running in the background.
        await this.stop(connection)
        if (signal?.aborted) signal.throwIfAborted()
        throw error instanceof MemoryError ? error : new MemoryError(502, 'Se interrumpió el procesamiento con OpenCode; el trabajo se puede reintentar.')
      } finally {
        signal?.removeEventListener('abort', cancel)
        if (sessionId && !connection.lifetime.signal.aborted) {
          await this.request(connection, `/session/${sessionId}`, 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => undefined)
        }
      }
    }, signal)
  }
}
