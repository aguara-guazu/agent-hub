import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicySnapshot } from '@agenthub/shared'
import { planMemoryHooks } from './memory-hooks.js'
import { applyChanges } from './atomic.js'
import { gatewayEndpoint } from './base.js'

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
  expect(readFileSync(path,'utf8')).toContain('--agenthub-memory-hook')
  expect(readFileSync(path,'utf8')).not.toContain('permissionDecision')
  expect(planMemoryHooks(snapshot,endpoint,home)[0]).toHaveLength(0)
  const before = kind === 'gemini_cli' ? 'BeforeTool' : 'PreToolUse'
  current.hooks[before][0].hooks[0].command += ' user edit'
  writeFileSync(path,JSON.stringify(current))
  expect(planMemoryHooks(snapshot,endpoint,home)[1]).toHaveLength(1)
  current.hooks[before][0].hooks[0].command = current.hooks[before][0].hooks[0].command.replace(' user edit','')
  writeFileSync(path,JSON.stringify(current))
  applyChanges(planMemoryHooks({ ...snapshot,servers:[] },endpoint,home)[0])
  const removed = JSON.parse(readFileSync(path,'utf8'))
  expect(removed.hooks.Stop).toEqual([personal]); expect(readFileSync(path,'utf8')).not.toContain('--agenthub-memory-hook')
})
