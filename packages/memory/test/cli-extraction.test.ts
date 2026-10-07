import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { CliExtractionRuntime, extractionClis, type ExtractionCli } from '../src/cli-extraction.js'
import { MemoryAI } from '../src/ai.js'
import { defaultAI, usesRemoteExtraction, Vault } from '../src/config.js'
import { aiConfigSchema, MemoryService } from '../src/service.js'

let directory: string, runtime: CliExtractionRuntime, children: ChildProcess[]
const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-cli-test-')); children = [] })
afterEach(async () => { await runtime?.close(); for (const child of children) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) })
function setup(requestMs = 3000) {
  const launch = vi.fn((command, args, options) => {
    expect(args.join(' ')).not.toContain('private transcript')
    expect(options.shell).toBeUndefined()
    const child = spawn(command, [fileURLToPath(new URL('../src/cli-host.ts', import.meta.url)), fileURLToPath(new URL('./fixtures/extraction-cli.mjs', import.meta.url)), ...args.slice(1)], {
      ...options, env: { ...options.env, FIXTURE_REQUESTS: join(directory, 'requests') },
    })
    children.push(child)
    return child
  })
  runtime = new CliExtractionRuntime(directory, { executable: provider => provider, launch, requestMs, discoveryMs: 3000 })
  return launch
}
async function requests() { return (await readFile(join(directory, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }

it.each(extractionClis)('descubre modelos de %s usando su protocolo y limpia los procesos', async provider => {
  setup()
  const status = await runtime.status(provider)
  expect(status).toMatchObject({ installed: true, models: [{ id: 'fixture', name: 'Fixture' }, ...(provider === 'codex_cli' ? [{ id: 'second', name: 'Fixture' }] : [])] })
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  expect(await readdir(join(directory, 'cli-extraction'))).toEqual([])
})
it.each(extractionClis)('extrae JSON con %s, aísla herramientas y no pone evidencia en argumentos', async provider => {
  setup()
  const result = await runtime.extract(provider, 'fixture', '', { text: 'private transcript' }, schema)
  expect(result.value).toEqual({ code: 'AGENTHUB_OK' })
  expect(result.usage).toEqual({ model: 'fixture', input_tokens: provider === 'kiro' ? 0 : 15, output_tokens: provider === 'kiro' ? 0 : 3 })
  const calls = await requests(), args = calls[0].args
  if (provider === 'claude_code') { expect(args).toContain('--safe-mode'); expect(args[args.indexOf('--tools') + 1]).toBe(''); expect(args).toContain('--strict-mcp-config') }
  if (provider === 'codex_cli') { expect(args).toContain('--ignore-user-config'); expect(args).toContain('read-only'); expect(args).toContain('features.shell_tool=false'); expect(args).toContain('--ephemeral') }
  if (provider === 'kiro') { expect(args).toContain('--trust-tools='); expect(calls.some(c => c.args?.includes('--delete-session'))).toBe(true) }
  expect(calls.find(c => c.input)?.input).toContain('private transcript')
  expect(await readdir(join(directory, 'cli-extraction'))).toEqual([])
})
it.each(extractionClis)('rechaza JSON inválido y resultados que incumplen el esquema en %s', async provider => {
  setup()
  await expect(runtime.extract(provider, 'bad-json', '', {}, schema)).rejects.toThrow('JSON válido')
  await expect(runtime.extract(provider, 'bad-schema', '', {}, schema)).rejects.toThrow('esquema')
})
it.each(['codex_cli', 'kiro'] as const)('rechaza respuestas incompletas de %s', async provider => {
  setup()
  await expect(runtime.extract(provider, 'incomplete', '', {}, schema)).rejects.toThrow('no completó')
})
it('clasifica acceso y límites sin revelar stderr ni evidencia', async () => {
  setup()
  await expect(runtime.extract('claude_code', 'auth-error', '', {}, schema)).rejects.toMatchObject({ statusCode: 409, transient: false })
  await expect(runtime.extract('codex_cli', 'rate-limit', '', {}, schema)).rejects.toMatchObject({ statusCode: 503, transient: true })
  await expect(runtime.test('codex_cli', 'rate-limit')).rejects.toThrow('Volvé a probar')
})
it('termina el árbol de procesos al cancelar y al vencer el plazo', async () => {
  setup(500)
  const controller = new AbortController()
  const pending = runtime.extract('codex_cli', 'hang', '', {}, schema, controller.signal)
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(async () => expect((await requests()).some(c => c.input)).toBe(true))
  controller.abort(); await assertion
  expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
  const pid = (await requests())[0].pid
  expect(() => process.kill(pid, 0)).toThrow()
  await expect(runtime.extract('claude_code', 'hang', '', {}, schema)).rejects.toMatchObject({ transient: true })
})
it('espera el cierre del proceso y la limpieza al cerrar el runtime', async () => {
  setup()
  const result = runtime.extract('claude_code', 'hang', '', {}, schema).catch(error => error)
  await vi.waitFor(async () => expect((await requests()).some(c => c.input)).toBe(true))
  await runtime.close()
  expect(await result).toMatchObject({ name: 'AbortError' })
  expect(await readdir(join(directory, 'cli-extraction'))).toEqual([])
})
it('no inicia procesos si se cierra mientras prepara la carpeta temporal', async () => {
  const launch = setup()
  const result = runtime.extract('claude_code', 'hang', '', {}, schema).catch(error => error)
  await runtime.close()
  expect(await result).toMatchObject({ name: 'AbortError' })
  expect(launch).not.toHaveBeenCalled()
  expect(await readdir(join(directory, 'cli-extraction'))).toEqual([])
})
it('no ejecuta una CLI ausente ni un modelo inválido', async () => {
  const launch = vi.fn()
  runtime = new CliExtractionRuntime(directory, { executable: () => undefined, launch })
  expect(await runtime.status('kiro')).toMatchObject({ installed: false, models: [] })
  await expect(runtime.extract('kiro', 'fixture', '', {}, schema)).rejects.toThrow('No se encontró')
  await expect(runtime.extract('kiro', '--unsafe', '', {}, schema)).rejects.toThrow('modelo válido')
  expect(launch).not.toHaveBeenCalled()
})
it.each(extractionClis)('conserva proveedor/modelo de %s por trabajo y respeta el permiso remoto', async provider => {
  setup()
  const config = { ...defaultAI, extraction: provider, extraction_model: 'fixture', remote_processing_enabled: true }
  expect(usesRemoteExtraction(config)).toBe(true)
  expect(aiConfigSchema.safeParse(config).success).toBe(true)
  const ai = new MemoryAI(async () => defaultAI, new Vault(directory), vi.fn(), undefined, undefined, undefined, [], runtime)
  const pinned = ai.forJob(config, new AbortController().signal)
  expect((await pinned.extract('', {}, z.object({ code: z.string() }))).value).toEqual({ code: 'AGENTHUB_OK' })
  const before = children.length
  await expect(ai.forJob({ ...config, remote_processing_enabled: false }, new AbortController().signal).extract('', {}, z.object({}))).rejects.toThrow('remoto está desactivado')
  expect(children).toHaveLength(before)
})
it.each(extractionClis)('no reemplaza la configuración si falla la prueba de %s', async (provider: ExtractionCli) => {
  const service = new MemoryService(directory, 'http://localhost/callback')
  const test = vi.spyOn(service.cliExtraction, 'test').mockRejectedValue(new Error('No hay acceso'))
  const get = vi.spyOn(service, 'get')
  try {
    await expect(service.saveAI({ ...defaultAI, extraction: provider, extraction_model: 'fixture', remote_processing_enabled: true })).rejects.toThrow('No hay acceso')
    expect(test).toHaveBeenCalledWith(provider, 'fixture', undefined)
    expect(get).not.toHaveBeenCalled()
  } finally { await service.close() }
})
