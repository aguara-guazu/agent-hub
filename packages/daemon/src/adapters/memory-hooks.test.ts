import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicySnapshot } from '@agenthub/shared'
import { planMemoryHooks } from './memory-hooks.js'
import { applyChanges } from './atomic.js'
import { gatewayEndpoint } from './base.js'
import { openCodeMemoryPlugin } from './opencode-chat.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'memory-hooks-test-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
it.each(['codex_cli','claude_code','gemini_cli'] as const)('instala hooks de %s preservando los personales, detecta drift y puede retirarlos', kind => {
  const snapshot = { cli_kind: kind, servers: [{ tools: [{ name:'finish_notes' }] }] } as PolicySnapshot
  const endpoint = gatewayEndpoint({ command: '/path with spaces/node', args: ['/app/cli.js','gateway','--agent','agent','--state-dir',join(home,'state')] })
  const path = join(home, kind === 'codex_cli' ? '.codex/hooks.json' : kind === 'claude_code' ? '.claude/settings.json' : '.gemini/settings.json')
  mkdirSync(join(path,'..'),{recursive:true})
  const personal = { hooks: [{ type:'command',command:'echo personal' }] }
  writeFileSync(path,JSON.stringify({ hooks:{ Stop:[personal] },personal_preference:true }))
  const [changes,drift] = planMemoryHooks(snapshot,endpoint,home)
  expect(drift).toEqual([]); expect(applyChanges(changes).drift).toEqual([])
  const current = JSON.parse(readFileSync(path,'utf8'))
  expect(current.personal_preference).toBe(true); expect(current.hooks.Stop).toContainEqual(personal)
  const before = kind === 'gemini_cli' ? 'BeforeTool' : 'PreToolUse'
  const command = current.hooks[before][0].hooks[0].command as string
  const encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(command)?.[1]
  expect(encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command).toContain('--agenthub-memory-hook')
  expect(readFileSync(path,'utf8')).not.toContain('permissionDecision')
  expect(planMemoryHooks(snapshot,endpoint,home)[0]).toHaveLength(0)
  current.hooks[before][0].hooks[0].command += ' user edit'
  writeFileSync(path,JSON.stringify(current))
  expect(planMemoryHooks(snapshot,endpoint,home)[1]).toHaveLength(1)
  current.hooks[before][0].hooks[0].command = current.hooks[before][0].hooks[0].command.replace(' user edit','')
  writeFileSync(path,JSON.stringify(current))
  applyChanges(planMemoryHooks({ ...snapshot,servers:[] },endpoint,home)[0])
  const removed = JSON.parse(readFileSync(path,'utf8'))
  expect(removed.hooks.Stop).toEqual([personal]); expect(readFileSync(path,'utf8')).not.toContain('--agenthub-memory-hook')
})
it.each(['claude_code','codex_cli','gemini_cli','kiro','opencode','antigravity'] as const)('instala una terminal conectada para %s y preserva sus opciones personales',kind=>{
  const snapshot={cli_kind:kind,servers:[{tools:[{name:'chat_join'}]}]} as PolicySnapshot
  const endpoint=gatewayEndpoint({command:'/path with spaces/node',args:['/app/cli.js','gateway','--agent','agent','--state-dir',join(home,'state')]})
  const [changes,drift]=planMemoryHooks(snapshot,endpoint,home)
  expect(drift).toEqual([]);applyChanges(changes)
  const launcher=changes.find(c=>/agenthub-(claude|codex|gemini|kiro|opencode|agy)(\.ps1)?$/.test(c.path))!
  expect(launcher).toBeTruthy()
  const content=readFileSync(launcher.path,'utf8')
  expect(content).toContain("'chat'")
  expect(content).toMatch(/'--agent',? 'agent'/)
  expect(content).toMatch(/'--'(?: "\$@"|\) \+ \$args)/)
  expect(content).not.toMatch(/trust-all|yolo|skip-permissions/)
  expect(planMemoryHooks(snapshot,endpoint,home)[0]).toHaveLength(0)
  writeFileSync(launcher.path,content+'# editado\n')
  expect(planMemoryHooks(snapshot,endpoint,home)[1]).toHaveLength(1)
})
it('OpenCode activa la sesión por ID sin escribir en el compositor de la terminal',()=>{
  const plugin=openCodeMemoryPlugin('/bin/node',['cli.js','memory-hook'],true,true)
  expect(plugin).toContain('client.session.promptAsync')
  expect(plugin).toContain("'experimental.chat.system.transform'")
  expect(plugin).toContain("'chat-bridge'")
  expect(plugin).not.toContain('tui.')
})
it.each(['codex_cli','claude_code','gemini_cli'] as const)('registra sesiones de %s, sin alterar aprobaciones ni exigir finish_notes',kind=> {
  const snapshot={cli_kind:kind,servers:[{tools:[{name:'chat_join'}]}]} as PolicySnapshot
  const endpoint=gatewayEndpoint({command:'/bin/node',args:['/app/cli.js','gateway','--agent','agent','--state-dir',join(home,'state')]})
  const [changes,drift]=planMemoryHooks(snapshot,endpoint,home)
  expect(drift).toEqual([]);applyChanges(changes)
  const path=join(home,kind==='codex_cli'?'.codex/hooks.json':kind==='claude_code'?'.claude/settings.json':'.gemini/settings.json')
  const contents=readFileSync(path,'utf8'),hooks=JSON.parse(contents).hooks
  expect(hooks.SessionStart).toHaveLength(1)
  expect(hooks[kind==='gemini_cli'?'BeforeAgent':'UserPromptSubmit']).toHaveLength(1)
  const timeout=process.platform==='win32'?10:5
  expect(hooks.SessionStart[0].hooks[0].timeout).toBe(kind==='gemini_cli'?timeout*1000:timeout)
  if(kind==='codex_cli') {
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBe(3)
    expect(hooks.Interrupt[0].hooks[0].timeout).toBe(3)
  }
  expect(contents).not.toContain('bypass');expect(contents).not.toContain('permissionDecision')
  if (kind==='claude_code') {
    expect(hooks.Stop[0].hooks[1]).toMatchObject({asyncRewake:true,timeout:604800})
    expect(hooks.SessionStart[0].hooks[1]).toMatchObject({asyncRewake:true,timeout:604800})
  }
  else expect(contents).not.toContain('asyncRewake')
  expect(planMemoryHooks(snapshot,endpoint,home)[0]).toHaveLength(0)
})


it('entrega avisos Claude tras cualquier herramienta, preserva hooks personales y retira sólo los propios',()=>{
  const snapshot={cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'}]}]} as PolicySnapshot
  const endpoint=gatewayEndpoint({command:'/bin/node',args:['/app/cli.js','gateway','--agent','agent','--state-dir',join(home,'state')]})
  const path=join(home,'.claude/settings.json')
  mkdirSync(join(path,'..'),{recursive:true})
  const personal={matcher:'Bash',hooks:[{type:'command',command:'echo personal'}]}
  writeFileSync(path,JSON.stringify({hooks:{PostToolUse:[personal]}}))
  const [changes,drift]=planMemoryHooks(snapshot,endpoint,home)
  expect(drift).toEqual([])
  applyChanges(changes)
  const hooks=JSON.parse(readFileSync(path,'utf8')).hooks
  expect(hooks.PreToolUse[0].matcher).toBe('.*hub.*')
  expect(hooks.PostToolUse).toContainEqual(personal)
  for(const event of ['PostToolUse','PostToolUseFailure']) {
    const hub=hooks[event].find((entry:{matcher:string})=>entry.matcher==='.*')
    expect(hub.hooks).toHaveLength(1)
    expect(hub.hooks[0].command).toContain('--agenthub-memory-hook')
    expect(hub.hooks[0]).not.toHaveProperty('async')
    expect(hub.hooks[0]).not.toHaveProperty('asyncRewake')
  }
  expect(hooks.PostModelSwitch).toHaveLength(1)
  expect(hooks.PostModelSwitch[0].hooks[0].command).toContain('--agenthub-memory-hook')
  expect(hooks.PostModelSwitch[0]).not.toHaveProperty('matcher')
  expect(planMemoryHooks(snapshot,endpoint,home)[0]).toHaveLength(0)
  applyChanges(planMemoryHooks({...snapshot,servers:[]},endpoint,home)[0])
  const removed=JSON.parse(readFileSync(path,'utf8')).hooks
  expect(removed.PostModelSwitch ?? []).toEqual([])
  expect(removed.PostToolUse).toEqual([personal])
  expect(removed.PostToolUseFailure ?? []).toEqual([])
})

it.each(['claude_code','codex_cli','gemini_cli'] as const)('no registra hooks de resultado adicionales para %s con sólo notas',kind=>{
  const snapshot={cli_kind:kind,servers:[{tools:[{name:'finish_notes'}]}]} as PolicySnapshot
  const endpoint=gatewayEndpoint({command:'/bin/node',args:['/app/cli.js','gateway','--agent','agent','--state-dir',join(home,'state')]})
  applyChanges(planMemoryHooks(snapshot,endpoint,home)[0])
  const path=join(home,kind==='codex_cli'?'.codex/hooks.json':kind==='claude_code'?'.claude/settings.json':'.gemini/settings.json')
  const hooks=JSON.parse(readFileSync(path,'utf8')).hooks
  expect(hooks).not.toHaveProperty('PostToolUse')
  expect(hooks).not.toHaveProperty('PostToolUseFailure')
})

it.skipIf(process.platform !== 'win32').each([false, true])('espera Electron y conserva stdin, stdout, stderr y el código 2 (encoded=%s)', async encoded => {
  const { hookCommand } = await import('./memory-hooks.js')
  const { createRequire } = await import('node:module')
  const { spawnSync } = await import('node:child_process')
  const electron: string = createRequire(import.meta.url)('electron')
  const fixture = join(home, "bloqueo d'ejemplo.cjs")
  writeFileSync(fixture, `
    const input = require('node:fs').readFileSync(0, 'utf8')
    // Like the Codex quota probe, this helper may outlive the hook deadline.
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'],
      { stdio: 'ignore', detached: true }).unref()
    setTimeout(() => { console.log(input); console.error('rewake'); process.exitCode = 2 }, 150)
  `)
  const command = hookCommand(electron, [fixture], encoded)
  const args = encoded ? command.split(' ').slice(1) : ['-NoProfile', '-NonInteractive', '-Command', command]
  const result = spawnSync('powershell.exe', args, { input: 'hook payload', encoding: 'utf8', timeout: 10000 })
  expect(result.error).toBeUndefined()
  expect(result.stdout.trim()).toBe('hook payload')
  expect(result.stderr.trim()).toBe('rewake')
  expect(result.status).toBe(2)
}, 120000)

it('reactiva Watch al habilitar Agentes de nuevo y mantiene el hook de notas durante el ciclo', () => {
  const endpoint = gatewayEndpoint({ command: 'node', args: ['cli.js', 'gateway', '--state-dir', home] })
  const file = join(home, '.claude/settings.json')
  for (const chat of [true, false, true]) {
    const tools = chat ? [{ name: 'finish_notes' }, { name: 'chat_join' }] : [{ name: 'finish_notes' }]
    const snapshot = { cli_kind: 'claude_code', servers: [{ tools }] } as PolicySnapshot
    expect(applyChanges(planMemoryHooks(snapshot, endpoint, home)[0]).drift).toEqual([])
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks
    expect(hooks.Stop[0].hooks.some((h: { asyncRewake?: boolean }) => h.asyncRewake)).toBe(chat)
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('--agenthub-memory-hook')
  }
})
