import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Ajv } from 'ajv'
import { chatAnswer } from './focused-chat.js'
import { workAnswer } from './work.js'
import * as installed from '../cli-extraction.js'
import * as openCode from '../opencode.js'
import { runAssistantTerminal, type AssistantTerminalInput } from './terminal.js'

const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false }
const session = 'fc18f1cb-e055-4d89-a899-3e005d895b3b'
const answer = { reply: 'Revisé el asunto.' }
const prompt = 'Contenido privado del proyecto.'
let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'assistant-terminal-')))
  const executable = join(directory, 'cli.mjs')
  await writeFile(executable, `import { writeFileSync,readFileSync,statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const args=process.argv.slice(2)
function observeGrant(argv) {
  const path=argv[argv.indexOf('--grant-file')+1]
  const data=JSON.parse(readFileSync(path,'utf8'))
  writeFileSync('grant.json', JSON.stringify({path, private:(statSync(path).mode & 0o077)===0, valid:data.AGENTHUB_RESIDENT_TEAM_TOKEN==='only-this-bridge'}))
}
if(args[0]==='acp'){
  const say=(packet)=>console.log(JSON.stringify({jsonrpc:'2.0',...packet}))
  const permissions=[]
  for await(const line of createInterface({input:process.stdin})){
    const m=JSON.parse(line)
    if(m.method==='initialize')say({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}})
    if(m.method==='session/new'||m.method==='session/load'){
      const srv=m.params.mcpServers.find(s=>s.name==='resident_team')
      observeGrant(srv.args)
      writeFileSync('call.json',JSON.stringify({args, grant:!!process.env.AGENTHUB_RESIDENT_TEAM_TOKEN, session:m.params.sessionId}))
      say({id:m.id,result:{sessionId:m.params.sessionId || 'fc18f1cb-e055-4d89-a899-3e005d895b3b',
        configOptions:[{id:'model',currentValue:'configured',options:[{value:'configured'}]},
          {id:'effortLevel',currentValue:'high',options:[{value:'high'}]}]}})
    }
    if(m.method==='session/prompt'){
      if(process.env.TEST_V3){
        for(const [id,serverName,sessionId] of [[8,'other',m.params.sessionId],[9,'resident_team','sess_foreign'],[10,'resident_team',m.params.sessionId]]){
          say({method:'session/request_permission',id,params:{sessionId,toolCall:{title:'@resident_team/team'},
            options:[{kind:'allow_always',optionId:'persist'},{kind:'allow_once',optionId:'once'}],
            _meta:{kiro:{mcpTool:{version:1,identity:{serverName,toolName:'team'}}}}}})
        }
        continue
      }
      say({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"reply":"Kiro con equipo"}'}}}})
      say({id:m.id,result:{stopReason:'end_turn'}})
    }
    if(m.result?.outcome){
      permissions.push(m.result.outcome)
      if(m.id===10){
        writeFileSync('permissions.json',JSON.stringify(permissions))
        say({method:'session/update',params:{sessionId:'sess_v3',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"reply":"v3"}'}}}})
        say({id:4,result:{stopReason:'end_turn'}})
      }
    }
  }
  process.exit(0)
}
if(process.env.TEST_GRANT){
  if(args.includes('--mcp-config')) observeGrant(JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.resident_team.args)
  else if(args.includes('exec')) observeGrant(JSON.parse(args.find(a=>a.startsWith('mcp_servers.resident_team.args=')).split('=').slice(1).join('=')))
  else if(args.includes('run')){
    const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
    observeGrant(config.mcp.resident_team.command)
  }
}
let input = ''
for await (const part of process.stdin) input += part
writeFileSync('call.json', JSON.stringify({args:process.argv.slice(2), input, cwd:process.cwd(), parent:process.env.CODEX_THREAD_ID,
  inheritedHub:process.env.AGENTHUB_OWNER_SECRET, config:process.env.OPENCODE_CONFIG_CONTENT, selected:process.env.SELECTED_CONFIG,
  kiroKey:!!process.env.KIRO_API_KEY, vaultKey:process.env.KIRO_API_KEY==='fresh-vault-test-key', grant:!!process.env.AGENTHUB_RESIDENT_TEAM_TOKEN}))
if (process.env.HANG) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'})
  writeFileSync('child.pid', String(child.pid))
  setInterval(()=>{},1000)
} else {
  process.stderr.write(process.env.TEST_STDERR || '')
  process.stdout.write(process.env.TEST_OUTPUT)
  process.exitCode = Number(process.env.TEST_CODE || 0)
  if (process.env.TEST_AFTER_RESULT) {
    const watcher = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'})
    writeFileSync('child.pid', String(watcher.pid))
    // The native CLI finishes writing its transcript immediately after publishing the final result.
    setTimeout(() => writeFileSync('persisted-session', 'fc18f1cb-e055-4d89-a899-3e005d895b3b'), 35)
    setInterval(()=>{},1000)
  }
}
`)
  vi.spyOn(installed, 'findExtractionCli').mockReturnValue(executable)
  vi.spyOn(openCode, 'findOpenCode').mockReturnValue(executable)
  vi.stubEnv('CODEX_THREAD_ID', 'the-parent-thread')
  vi.stubEnv('AGENTHUB_OWNER_SECRET', 'private-to-the-hub')
  vi.stubEnv('KIRO_API_KEY', 'kiro-only')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

const native = {
  claude_code: {
    args: ['--print', '--output-format', 'stream-json', '--verbose', '--model', 'configured', '--effort', 'high'],
    resume: '--resume', count: [16, 5],
    events: [
      { type: 'system', subtype: 'init', session_id: session },
      { type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', name: 'mcp__hub__memory_list_tasks', input: {} }] } },
      { type: 'result', subtype: 'success', session_id: session, result: '', structured_output: answer,
        usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 5 } },
    ],
  },
  codex_cli: {
    args: ['exec', '--skip-git-repo-check', '--json', '--model', 'configured', '-c', 'model_reasoning_effort="high"', '-'],
    resume: 'resume', count: [16, 5],
    events: [
      { type: 'thread.started', thread_id: session }, { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'hub', tool: 'memory_list_tasks', status: 'completed' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Voy a revisar la fuente.' } },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } },
      { type: 'turn.completed', usage: { input_tokens: 16, cached_input_tokens: 4, output_tokens: 5 } },
    ],
  },
  kiro: {
    args: ['chat', '--no-interactive', '--output-format', 'stream-json', '--model', 'configured', '--effort', 'high'],
    resume: '--resume-id', count: [0, 0],
    events: [
      { type: 'runStarted', data: { sessionId: session } },
      { type: 'runFinished', data: { sessionId: session, status: 'success', stopReason: 'end_turn', finalTextTruncated: false,
        finalText: 'Resultado:\n```json\n' + JSON.stringify(answer) + '\n```' } },
    ],
  },
  opencode: {
    args: ['run', '--format', 'json', '--model', 'provider/configured', '--variant', 'high'],
    resume: '--session', count: [27, 8],
    events: [
      { type: 'step_start', sessionID: session },
      { type: 'text', sessionID: session, part: { text: 'Consulto la fuente.' } },
      { type: 'tool_use', sessionID: session, part: { tool: 'hub_memory_list_tasks', state: { status: 'completed', output: {} } } },
      { type: 'step_finish', sessionID: session, part: { reason: 'tool-calls', tokens: { input: 10, output: 3, cache: { read: 1, write: 0 } } } },
      { type: 'step_start', sessionID: session },
      { type: 'text', sessionID: session, part: { text: JSON.stringify(answer) } },
      { type: 'step_finish', sessionID: session, part: { reason: 'stop', tokens: { input: 10, output: 5, cache: { read: 4, write: 2 } } } },
    ],
  },
}
function options(provider: AssistantTerminalInput['provider'], extra: Partial<AssistantTerminalInput> = {}): AssistantTerminalInput {
  const events = native[provider].events.map(e => JSON.stringify(e)).join('\n')
  return { provider, model: provider === 'opencode' ? 'provider/configured' : 'configured', effort: 'high',
    cwd: directory, prompt, schema, signal: new AbortController().signal, ...extra,
    env: { TEST_OUTPUT: 'CLI startup notice\n' + events + '\n', SELECTED_CONFIG: 'profile', ...extra.env } }
}
const call = async () => JSON.parse(await readFile(join(directory, 'call.json'), 'utf8'))

it('Claude preautoriza sólo nombres exactos entregados por el catálogo del Hub', async () => {
  await runAssistantTerminal(options('claude_code', { readTools: ['renamed_getjiraissue', 'memory_get_task', 'other_*', 'Bash(*)'] }))
  const explicit = (await call()).args
  expect(explicit[explicit.indexOf('--allowedTools') + 1].split(',')).toEqual(['mcp__hub__renamed_getjiraissue', 'mcp__hub__memory_get_task'])
  await runAssistantTerminal(options('claude_code'))
  expect((await call()).args).not.toContain('--allowedTools')
})

it.each([
  ['chat', chatAnswer, { reply: 'Respuesta' }],
  ['trabajo', workAnswer, { summary: 'Resultado', criteria: [], missing: [], citations: [], delegate: [] }],
] as const)('Claude recibe un esquema compatible para la respuesta real de %s', async (_name, contract, value) => {
  const original = z.toJSONSchema(contract)
  const result = await runAssistantTerminal(options('claude_code', { schema: original, env: { TEST_OUTPUT: JSON.stringify({
    type: 'result', subtype: 'success', structured_output: value, session_id: session,
  }) } }))
  const { args } = await call()
  const nativeSchema = JSON.parse(args[args.indexOf('--json-schema') + 1])
  expect(new Ajv().compile(nativeSchema)(value)).toBe(true)
  expect(result.value).toEqual(value)
  expect(original.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
})

it('informa la causa que rechazó el CLI sin incluir prompts ni credenciales', async () => {
  const details = 'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema". Bearer secret-from-stderr'
  const task = runAssistantTerminal(options('claude_code', { env: { TEST_OUTPUT: '', TEST_STDERR: details, TEST_CODE: '1' } }))
  await expect(task).rejects.toMatchObject({ code: 'assistant_cli_schema' })
  await expect(task).rejects.not.toThrow(/secret-from-stderr/)
})

it.each(Object.keys(native) as (keyof typeof native)[])('ejecuta y retoma la sesión de %s con sus herramientas, modelo y esfuerzo', async provider => {
  const fixture = native[provider]
  const result = await runAssistantTerminal(options(provider))
  expect(result).toEqual({ value: answer, sessionId: session, inputTokens: fixture.count[0], outputTokens: fixture.count[1] })
  const initial = await call()
  expect(initial.args).toEqual(expect.arrayContaining(fixture.args))
  expect(initial.args).not.toContain(fixture.resume)
  expect(initial.args.join(' ')).not.toMatch(/Contenido privado|--safe-mode|--strict-mcp-config|--ignore-user-config|--ephemeral|--pure|--trust-all|--dangerously|--auto\b/)
  expect(initial).toMatchObject({ input: expect.stringContaining(prompt), cwd: directory, selected: 'profile', kiroKey: provider === 'kiro' })
  expect(initial).not.toHaveProperty('parent')
  expect(initial).not.toHaveProperty('inheritedHub')
  expect(initial.input + initial.args.join(' ')).toContain('"reply"')
  await runAssistantTerminal(options(provider, { sessionId: result.sessionId!, effort: '' }))
  const { args } = await call()
  expect(args).toContain(fixture.resume)
  expect(args).toContain(session)
  expect(args).not.toContain('--last')
  expect(args.join(' ')).not.toMatch(/--effort|--variant|model_reasoning_effort/)
})

it('no confunde un resultado de herramienta o un turno truncado con una respuesta final', async () => {
  const truncated = native.codex_cli.events.slice(0, -1).map(e => JSON.stringify(e)).join('\n')
  await expect(runAssistantTerminal(options('codex_cli', { env: { TEST_OUTPUT: truncated } }))).rejects.toThrow()
  await expect(runAssistantTerminal(options('claude_code', { schema: { type: 'array' } }))).rejects.toThrow(/esquema/i)
  await expect(runAssistantTerminal(options('opencode', { sessionId: 'otra-sesion' }))).rejects.toThrow(/sesión/i)
})

it('distingue el rechazo de una reanudación de un fallo después de iniciar el turno', async () => {
  const error = 'Error: thread/resume: no rollout found for thread id ' + session
  const input = options('codex_cli', { sessionId: session, env: { TEST_STDERR: error, TEST_OUTPUT: '', TEST_CODE: '1' } })
  await expect(runAssistantTerminal(input)).rejects.toMatchObject({ code: 'assistant_session_missing' })
  await expect(runAssistantTerminal({ ...input, env: { ...input.env, TEST_OUTPUT: '{"type":"turn.started"}' } }))
    .rejects.not.toMatchObject({ code: 'assistant_session_missing' })
})

it('devuelve el resultado final de Claude, conserva la sesión y cierra los watchers que quedaron vivos', async () => {
  const result = await runAssistantTerminal(options('claude_code', {
    signal: AbortSignal.timeout(5000), env: { TEST_AFTER_RESULT: '1' },
  }))
  expect(result.value).toEqual(answer)
  const pid = Number(await readFile(join(directory, 'child.pid'), 'utf8'))
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  expect(await readFile(join(directory, 'persisted-session'), 'utf8')).toBe(result.sessionId)
  const resumed = await runAssistantTerminal(options('claude_code', { sessionId: result.sessionId! }))
  expect(resumed.value).toEqual(answer)
  expect((await call()).args).toContain(session)
}, 10000)

it.each(Object.keys(native) as (keyof typeof native)[])('entrega la credencial de equipo sólo al bridge de %s por este turno', async provider => {
  const result = await runAssistantTerminal(options(provider, { sessionId: session, env: {
    AGENTHUB_RESIDENT_TEAM_URL: 'http://127.0.0.1/tool', AGENTHUB_RESIDENT_TEAM_TOKEN: 'only-this-bridge',
    AGENTHUB_RESIDENT_TEAM_NODE: process.execPath, AGENTHUB_RESIDENT_TEAM_CLI: join(directory, 'team-client.mjs'),
    TEST_GRANT: '1', OPENCODE_CONFIG_CONTENT: '{"mcp":{"configured":{"enabled":false}}}', AGENTHUB_OWNER_SECRET: 'another-secret',
  } }))
  expect(result.value).toEqual(provider === 'kiro' ? { reply: 'Kiro con equipo' } : answer)
  const record = await call()
  expect(record.grant).toBe(false)
  expect(record).not.toHaveProperty('inheritedHub')
  expect(JSON.stringify(record)).not.toContain('only-this-bridge')
  if (provider === 'opencode') expect(JSON.parse(record.config).mcp.configured).toEqual({ enabled: false })
  if (provider === 'codex_cli') {
    expect(record.args).toContain('mcp_servers.resident_team.tools.team.approval_mode="approve"')
    expect(record.args.join(' ')).not.toContain('default_tools_approval_mode=')
  }
  const grant = JSON.parse(await readFile(join(directory, 'grant.json'), 'utf8'))
  expect(grant.valid).toBe(true)
  if (process.platform !== 'win32') expect(grant.private).toBe(true)
  await expect(stat(grant.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('aprueba una vez la identidad MCP verificada del equipo en su sesión de Kiro v3', async () => {
  const result = await runAssistantTerminal(options('kiro', { sessionId: 'sess_v3', env: { TEST_V3: '1',
    AGENTHUB_RESIDENT_TEAM_URL: 'http://localhost/tool', AGENTHUB_RESIDENT_TEAM_TOKEN: 'only-this-bridge',
    AGENTHUB_RESIDENT_TEAM_NODE: process.execPath, AGENTHUB_RESIDENT_TEAM_CLI: join(directory, 'team-client.mjs') } }))
  expect(result.value).toEqual({ reply: 'v3' })
  expect(JSON.parse(await readFile(join(directory, 'permissions.json'), 'utf8'))).toEqual([
    { outcome: 'cancelled' }, { outcome: 'cancelled' }, { outcome: 'selected', optionId: 'once' },
  ])
})

it('entrega la clave del vault únicamente a Kiro y relee su valor en el siguiente turno', async () => {
  const env = { KIRO_API_KEY: 'fresh-vault-test-key' }
  await runAssistantTerminal(options('kiro', { env }))
  expect(await call()).toMatchObject({ vaultKey: true })
  await runAssistantTerminal(options('codex_cli', { env }))
  expect(await call()).toMatchObject({ vaultKey: false, kiroKey: false })
  await runAssistantTerminal(options('kiro'))
  expect(await call()).toMatchObject({ vaultKey: false, kiroKey: true })
})

it.each(['abort', 'timeout'])('termina la CLI y sus procesos hijos por %s', async cause => {
  const caller = new AbortController(), deadline = new AbortController()
  if (cause === 'timeout') vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  const running = runAssistantTerminal(options('codex_cli', { signal: caller.signal, env: { HANG: '1' } }))
  const rejection = expect(running).rejects.toThrow()
  let pid = 0
  try {
    await vi.waitFor(async () => { pid = Number(await readFile(join(directory, 'child.pid'), 'utf8')); expect(pid).toBeGreaterThan(1) })
    ;(cause === 'abort' ? caller : deadline).abort()
    await rejection
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  } finally { caller.abort(); if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
})
