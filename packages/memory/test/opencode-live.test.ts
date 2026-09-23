/** Optional compatibility check against a real CLI, using an isolated local model fixture (no provider credentials). */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OpenCodeRuntime } from '../src/opencode.js'

const binary = process.env.AGENTHUB_OPENCODE_TEST_BINARY
it.skipIf(!binary).each([false, true])('OpenCode real extrae JSON sin ejecutar herramientas y se cierra con el worker (intento de lectura: %s)', async tryRead => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-opencode-live-'))
  const requests: any[] = []
  let child: ChildProcess | undefined
  let secret: string
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const read = tryRead && requests.length === 1
    const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: 'function', function: {
        name: read ? 'read' : 'StructuredOutput', arguments: JSON.stringify(read ? { filePath: secret } : { facts: ['Hecho de prueba'] }) } }] }, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const port = (provider.address() as { port: number }).port
  const runtime = new OpenCodeRuntime(directory, { executable: () => binary, requestMs: 15_000, launch: (command, args, options) => {
    secret = join(realpathSync(options.cwd as string), 'secret.txt')
    writeFileSync(secret, 'PRIVATE_FIXTURE_CONTENT')
    const config = JSON.parse(options.env!.OPENCODE_CONFIG_CONTENT!)
    Object.assign(config, { enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-key' }, models: { fixture: { name: 'Fixture', limit: { context: 32000, output: 6000 } } } } } })
    child = spawn(command, [args[0]!.replace('/src/opencode-host.js', '/dist/opencode-host.js'), args[1]!], { ...options, env: { ...options.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state') } })
    return child
  } })
  try {
    expect((await runtime.status()).models).toEqual([{ id: 'fixture/fixture', name: 'Fixture · Fixture' }])
    const result = await runtime.extract('fixture/fixture', 'Extraé hechos.', { text: 'Hecho de prueba' }, {
      type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'], additionalProperties: false,
    })
    expect(result).toEqual({ value: { facts: ['Hecho de prueba'] }, usage: { model: 'fixture/fixture', input_tokens: 12, output_tokens: 8 } })
    expect(requests).toHaveLength(tryRead ? 2 : 1)
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(['StructuredOutput', 'bash', 'read', 'glob', 'grep']))
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_FIXTURE_CONTENT')
    if (tryRead) expect(requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n')).toMatch(/reject|denied|Esta sesión sólo extrae/i)
    // Simulate the parent disappearing: the guardian's pipe closes even without an explicit stop request.
    child!.stdin!.end()
    await new Promise<void>(resolve => child!.once('exit', () => resolve()))
  } finally {
    await runtime.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
