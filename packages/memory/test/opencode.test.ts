import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpenCodeRuntime, findOpenCode } from '../src/opencode.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { aiConfigSchema, MemoryService } from '../src/service.js'
import { MemoryError } from '../src/contracts.js'

let directory: string, runtime: OpenCodeRuntime, children: ChildProcess[]
const model = 'fixture/chat/nested'
const schema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-opencode-test-')); children = [] })
afterEach(async () => { await runtime?.close(); for (const child of children) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) })
function setup(extra: { requestMs?: number; idleMs?: number; noStart?: boolean } = {}) {
  const launch = vi.fn((command, args, options) => {
    expect(args).not.toContain('private transcript')
    expect(options.windowsHide).toBe(true)
    expect(options.shell).toBeUndefined()
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT)
    expect(config).toMatchObject({ share: 'disabled', snapshot: false, compaction: { auto: false }, agent: { 'agenthub-memory': { permission: { '*': 'deny' } } } })
    expect(config.agent['agenthub-memory'].prompt).toBeUndefined() // Preserve OpenCode's own provider prompt.
    expect(Object.entries(config.agent['agenthub-memory'].permission).filter(([, action]) => action === 'allow')).toEqual([['StructuredOutput', 'allow']])
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/opencode.mjs', import.meta.url))], {
      ...options, env: { ...options.env, FIXTURE_REQUESTS: join(directory, 'requests'), ...(extra.noStart ? { FIXTURE_NO_START: '1' } : {}) },
    })
    children.push(child)
    return child
  })
  runtime = new OpenCodeRuntime(directory, { executable: () => '/fixture/opencode', launch, startupMs: extra.noStart ? 100 : 3000, ...extra })
  return launch
}
async function requests() { return (await readFile(join(directory, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }

it('detecta la instalación habitual aunque el PATH de la app no la incluya', async () => {
  if (process.platform === 'win32') return
  await mkdir(join(directory, '.opencode/bin'), { recursive: true })
  const executable = join(directory, '.opencode/bin/opencode')
  await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 })
  expect(findOpenCode({ PATH: '' }, directory)).toBe(executable)
})
it('informa que falta OpenCode sin iniciar procesos', async () => {
  const launch = vi.fn()
  runtime = new OpenCodeRuntime(directory, { executable: () => undefined, launch })
  expect(await runtime.status()).toMatchObject({ installed: false, models: [] })
  await expect(runtime.extract(model, '', {}, schema)).rejects.toThrow('No se encontró OpenCode')
  expect(launch).not.toHaveBeenCalled()
})
it('descubre sólo modelos conectados, reutiliza el servidor y elimina las sesiones temporales', async () => {
  const launch = setup()
  expect((await runtime.status()).models).toEqual([{ id: model, name: 'Fixture · Chat' }])
  const result = await runtime.extract(model, 'instructions', { transcript: 'private transcript', facts: ['evidence'] }, schema)
  expect(result).toEqual({ value: { facts: ['evidence'] }, usage: { model, input_tokens: 15, output_tokens: 5 } })
  expect(launch).toHaveBeenCalledTimes(1)
  const calls = await requests()
  const permissions = calls.find(c => c.path === '/session').body.permission
  expect(permissions).toContainEqual({ permission: '*', pattern: '*', action: 'deny' })
  expect(permissions.filter((p: any) => p.action === 'allow')).toEqual([{ permission: 'StructuredOutput', pattern: '*', action: 'allow' }])
  for (const permission of ['read', 'glob', 'grep', 'bash', 'edit', 'write', 'apply_patch']) expect(permissions).toContainEqual({ permission, pattern: '*', action: 'ask' })
  expect(calls.find(c => c.path.endsWith('/message')).body).toMatchObject({ model: { providerID: 'fixture', modelID: 'chat/nested' }, format: { type: 'json_schema', schema } })
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/session/ses_fixture' })
})
it('rechaza herramientas automáticamente sin bloquear la extracción ni responder permisos de otra sesión', async () => {
  setup()
  expect((await runtime.extract(model, '', { scenario: 'permission' }, schema)).value).toEqual({ facts: ['evidence'] })
  const replies = (await requests()).filter(c => c.path.endsWith('/reply'))
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({ path: '/permission/per_fixture/reply', body: { reply: 'reject' } })
})
it.each([
  [{ name: 'APIError', data: { statusCode: 403, isRetryable: false, message: "SECRET OpenCode's free tier can only be used from within OpenCode" } }, 409, 'modelo gratuito'],
  [{ name: 'APIError', data: { statusCode: 401, message: 'SECRET' } }, 409, 'rechazó el acceso'],
  [{ name: 'APIError', data: { statusCode: 402, message: 'SECRET' } }, 409, 'requiere saldo'],
  [{ name: 'APIError', data: { statusCode: 429, message: 'SECRET' } }, 503, 'límite de uso'],
  [{ name: 'UnknownError', data: { message: 'SECRET Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded' } }, 503, 'saturado'],
  [{ name: 'APIError', data: { statusCode: 400, isRetryable: false, message: 'SECRET' } }, 409, 'no pudo generar'],
  [{ name: 'StructuredOutputError', data: { message: 'SECRET' } }, 502, 'salida estructurada'],
])('clasifica un error del proveedor sin revelar su cuerpo: %j', async (error, statusCode, message) => {
  setup()
  await expect(runtime.extract(model, '', { error }, schema)).rejects.toMatchObject({ statusCode, message: expect.stringContaining(message) })
})
it('prueba el modelo con evidencia sintética y salida estructurada', async () => {
  setup()
  expect(await runtime.test(model)).toEqual({ model, ok: true })
  expect((await requests()).find(c => c.path.endsWith('/message')).body.parts).toEqual([{ type: 'text', text: JSON.stringify({ text: 'El código de esta prueba es AGENTHUB_OK.' }) }])
})
it('reintenta el mismo lote transitorio, informa progreso y conserva el modelo elegido', async () => {
  const extract = vi.fn().mockRejectedValueOnce(new MemoryError(503, 'Proveedor saturado', true))
    .mockResolvedValue({ value: { facts: [] }, usage: { model, input_tokens: 1, output_tokens: 1 } })
  const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: model, remote_processing_enabled: true }
  const progress = vi.fn(async () => {})
  const ai = new MemoryAI(async () => config, new Vault(directory), fetch, { extract } as unknown as OpenCodeRuntime, undefined, undefined, [1])
    .forJob(config, new AbortController().signal, progress)
  await ai.extract('Extraer', { text: 'Evidencia' }, z.object({ facts: z.array(z.string()) }))
  expect(extract).toHaveBeenCalledTimes(2)
  expect(extract.mock.calls.every(call => call[0] === model)).toBe(true)
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ provider_retry: 1 }))
  expect(progress).toHaveBeenLastCalledWith({ provider_retry: null, provider_error: null, provider_retry_at: null })
})
it('cancelar durante el backoff impide otra llamada al proveedor', async () => {
  const extract = vi.fn().mockRejectedValue(new MemoryError(503, 'Proveedor saturado', true))
  const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: model, remote_processing_enabled: true }
  const controller = new AbortController()
  const ai = new MemoryAI(async () => config, new Vault(directory), fetch, { extract } as unknown as OpenCodeRuntime)
    .forJob(config, controller.signal, async () => { controller.abort() })
  await expect(ai.extract('Extraer', {}, z.object({ facts: z.array(z.string()) }))).rejects.toThrow()
  expect(extract).toHaveBeenCalledTimes(1)
})
it('conserva la configuración anterior si el modelo falla la prueba antes de guardar', async () => {
  const service = new MemoryService(directory, 'http://127.0.0.1/callback')
  const query = vi.fn().mockResolvedValue([])
  vi.spyOn(service, 'get').mockResolvedValue({ db: { query } } as any)
  const test = vi.spyOn(service.openCode, 'test').mockRejectedValue(new MemoryError(409, 'Acceso rechazado'))
  const config = { ...defaultAI, extraction: 'opencode', extraction_model: model, remote_processing_enabled: true }
  await expect(service.saveAI(config)).rejects.toThrow('Acceso rechazado')
  expect(query).not.toHaveBeenCalled()
  test.mockResolvedValue({ model, ok: true })
  expect(await service.saveAI(config)).toEqual(config)
  expect(query).toHaveBeenCalledTimes(1)
})
it('usa una sesión nueva y JSON validado cuando el modelo sólo acepta tool_choice auto', async () => {
  setup()
  expect((await runtime.extract(model, '', { scenario: 'text' }, schema)).value).toEqual({ facts: ['evidence'] })
  const calls = await requests(), generations = calls.filter(c => c.path.endsWith('/message'))
  expect(generations).toHaveLength(2)
  expect(generations[0].body.format).toBeDefined()
  expect(generations[1].body.format).toBeUndefined()
  expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(2)
  expect((await runtime.extract(model, '', { scenario: 'text' }, schema)).value).toEqual({ facts: ['evidence'] })
  expect((await requests()).filter(c => c.path.endsWith('/message'))).toHaveLength(3)
})
it('acepta el JSON válido de un modelo que omite StructuredOutput sin generar otra respuesta', async () => {
  setup()
  expect((await runtime.extract(model, '', { scenario: 'structured_text' }, schema)).value).toEqual({ facts: ['evidence'] })
  expect((await requests()).filter(c => c.path.endsWith('/message'))).toHaveLength(1)
})
it.each(['malformed', 'wrong_schema'])('rechaza la alternativa de texto %s sin aceptar datos inválidos', async scenario => {
  setup()
  await expect(runtime.extract(model, '', { scenario }, schema)).rejects.toThrow(scenario === 'malformed' ? 'JSON válido' : 'no cumple el esquema')
  expect((await requests()).filter(c => c.path.endsWith('/message'))).toHaveLength(2)
})
it.each(['legacy', 'invalid', 'error'])('maneja la respuesta %s sin aceptar texto libre ni exponer errores del proveedor', async scenario => {
  setup()
  const result = runtime.extract(model, '', { scenario }, schema)
  if (scenario === 'legacy') expect((await result).value).toEqual({ facts: [] })
  else await expect(result).rejects.toThrow(scenario === 'invalid' ? 'JSON estructurado' : 'OpenCode no pudo generar la extracción')
})
it('rechaza modelos no disponibles antes de enviar la transcripción', async () => {
  setup()
  await expect(runtime.extract('disconnected/other', '', { transcript: 'private transcript' }, schema)).rejects.toThrow('ya no está disponible')
  expect((await requests()).every(c => c.path === '/provider')).toBe(true)
})
it.each(['timeout', 'crash'])('maneja %s, termina la generación y permite reintentar', async scenario => {
  const launch = setup({ requestMs: 200 })
  await expect(runtime.extract(model, '', { scenario }, schema)).rejects.toThrow('se puede reintentar')
  expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
  expect((await runtime.extract(model, '', {}, schema)).value).toEqual({ facts: [] })
  expect(launch).toHaveBeenCalledTimes(2)
})
it('cancela una generación activa y detiene el proceso', async () => {
  setup()
  const controller = new AbortController()
  const result = runtime.extract(model, '', { scenario: 'timeout' }, schema, controller.signal)
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(async () => expect((await requests()).some(c => c.path.endsWith('/message'))).toBe(true))
  controller.abort()
  await assertion
  expect(children[0]!.signalCode).not.toBeNull()
})
it('termina un proceso que nunca publica su dirección', async () => {
  setup({ noStart: true })
  await expect(runtime.extract(model, '', {}, schema)).rejects.toThrow('no pudo iniciar')
  expect(children[0]!.signalCode).not.toBeNull()
})
it('libera el servidor cuando queda inactivo', async () => {
  setup({ idleMs: 20 })
  await runtime.status()
  await vi.waitFor(() => expect(children[0]!.signalCode).not.toBeNull())
})
it('conserva proveedor/modelo del trabajo y valida el resultado antes de guardarlo', async () => {
  setup()
  const config = { ...defaultAI, extraction: 'opencode' as const, extraction_model: model, remote_processing_enabled: true }
  const fetcher = vi.fn()
  const ai = new MemoryAI(async () => defaultAI, new Vault(directory), fetcher, runtime).forJob(config, new AbortController().signal)
  expect((await ai.extract('', { facts: ['ok'] }, z.object({ facts: z.array(z.string()) }))).value).toEqual({ facts: ['ok'] })
  await expect(ai.extract('', { facts: [123] }, z.object({ facts: z.array(z.string()) }))).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
  const blocked = new MemoryAI(async () => ({ ...config, remote_processing_enabled: false }), new Vault(directory), fetcher, runtime)
  await expect(blocked.extract('', {}, z.object({}))).rejects.toThrow('remoto está desactivado')
  expect(aiConfigSchema.safeParse({ ...config, extraction_model: 'missing-provider' }).success).toBe(false)
})
