import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PolicySnapshot } from '@agenthub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as toml from '@iarna/toml'

import {
  ADAPTERS,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  GeminiCliAdapter,
  KiroAdapter,
  applyChanges,
  deniedToolNames,
  detectAll,
  gatewayEndpoint,
  planFor,
  planMany,
} from './index.js'

function emptySnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    agent_instance_id: 'a1',
    cli_kind: 'kiro',
    user_id: 'u1',
    user_email: 'u@x',
    machine_id: 'm1',
    servers: [],
    skills: [],
    denied: [],
    snapshot_hash: 'h',
    generated_at: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

const stdioEndpoint = gatewayEndpoint({ transport: 'stdio', command: '/bin/agenthub', args: ['gateway', '--agent', 'a1'] })

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agenthub-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('invariante: una sola entrada hub', () => {
  it('cada adaptador escribe exactamente el alias hub y ninguna definición upstream', () => {
    const snapshot = emptySnapshot({
      servers: [
        {
          id: 's1',
          slug: 'ops',
          display_name: 'Ops',
          transport: 'stdio',
          command: 'node',
          args: ['-m', 'ops'],
          env: { SECRETO: 'no-deberia-viajar' },
          cwd: '',
          url: '',
          headers: {},
          secret_refs: {},
          tools: [],
        },
      ],
    })

    for (const kind of ['claude_code', 'codex_cli', 'gemini_cli', 'kiro']) {
      const changes = planFor(kind, snapshot, stdioEndpoint, home)
      applyChanges(changes)
    }

    // Ningún archivo del CLI menciona el comando ni el secreto del upstream.
    const claude = readFileSync(join(home, '.claude.json'), 'utf-8')
    expect(claude).toContain('hub')
    expect(claude).not.toContain('no-deberia-viajar')
    expect(claude).not.toContain('-m')

    const codex = toml.parse(readFileSync(join(home, '.codex/config.toml'), 'utf-8')) as {
      mcp_servers: Record<string, unknown>
    }
    expect(Object.keys(codex.mcp_servers)).toEqual(['hub'])

    const kiro = JSON.parse(readFileSync(join(home, '.kiro/settings/mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { disabled: boolean }>
    }
    expect(Object.keys(kiro.mcpServers)).toEqual(['hub'])
    expect(kiro.mcpServers['hub']!.disabled).toBe(false)

    const gemini = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(gemini.mcpServers)).toEqual(['hub'])
  })
})

describe('merge quirúrgico: preserva contenido ajeno', () => {
  it('Codex conserva otras tablas y comentarios de la persona', () => {
    const path = join(home, '.codex/config.toml')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path, 'model = "gpt"\n\n[mcp_servers.otro]\ncommand = "mio"\n')
    const changes = planFor('codex_cli', emptySnapshot({ cli_kind: 'codex_cli' }), stdioEndpoint, home)
    const result = applyChanges(changes)
    expect(result.drift).toHaveLength(0)
    const parsed = toml.parse(readFileSync(path, 'utf-8')) as {
      model: string
      mcp_servers: Record<string, unknown>
    }
    expect(parsed.model).toBe('gpt')
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['hub', 'otro'])
  })

  it('Kiro no toca otros servers del scope', () => {
    const path = join(home, '.kiro/settings/mcp.json')
    mkdirSync(join(home, '.kiro/settings'), { recursive: true })
    writeFileSync(path, JSON.stringify({ mcpServers: { propio: { command: 'x' } } }, null, 2))
    applyChanges(planFor('kiro', emptySnapshot(), stdioEndpoint, home))
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['hub', 'propio'])
  })
})

describe('idempotencia y drift', () => {
  it('no propone cambios cuando la configuración ya coincide', () => {
    applyChanges(planFor('kiro', emptySnapshot(), stdioEndpoint, home))
    const again = planFor('kiro', emptySnapshot(), stdioEndpoint, home)
    expect(again).toHaveLength(0)
  })

  it('detecta que alguien editó a mano la entrada del hub', () => {
    const adapter = new KiroAdapter()
    applyChanges(adapter.plan(emptySnapshot(), stdioEndpoint, home))
    const path = adapter.configPath(home)
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers: Record<string, { command: string }> }
    parsed.mcpServers['hub']!.command = 'algo-editado-a-mano'
    writeFileSync(path, JSON.stringify(parsed, null, 2))
    const report = adapter.readDrift(home)
    expect(report.items.length).toBeGreaterThan(0)
    expect(report.items[0]!.reason).toContain('editó a mano')
  })
})

describe('denied tool names', () => {
  it('deriva el nombre literal con el prefijo de cada CLI', () => {
    const snapshot = emptySnapshot({
      denied: [{ resource_type: 'mcp_tool', resource_id: 't1', slug: 'ops/restart_service', exposed: '', source: '', detail: '' }],
    })
    expect(deniedToolNames(snapshot, 'claude_code')).toEqual(['mcp__hub__ops_restart_service'])
    expect(deniedToolNames(snapshot, 'kiro')).toEqual(['hub___ops_restart_service'])
  })

  it('Claude escribe los deny bajo permissions.deny, no otros CLIs', () => {
    const snapshot = emptySnapshot({
      cli_kind: 'claude_code',
      denied: [{ resource_type: 'mcp_tool', resource_id: 't1', slug: 'ops/restart_service', exposed: '', source: '', detail: '' }],
    })
    applyChanges(planFor('claude_code', snapshot, stdioEndpoint, home))
    const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf-8')) as {
      permissions: { deny: string[] }
    }
    expect(settings.permissions.deny).toEqual(['mcp__hub__ops_restart_service'])
  })
})

describe('detección y registro', () => {
  it('detecta un CLI por la existencia de su config', () => {
    mkdirSync(join(home, '.kiro/settings'), { recursive: true })
    writeFileSync(join(home, '.kiro/settings/mcp.json'), '{}')
    const found = detectAll(home)
    expect(found.map((f) => f.cliKind)).toContain('kiro')
  })

  it('planMany comparte el store pero mantiene raíces independientes por cliente', () => {
    const snapshot = emptySnapshot({
      skills: [{ id: 'sk1', slug: 'runbook', display_name: 'Runbook', description: 'd', body: '# hola', version: 1, content_hash: 'c' }],
    })
    const changes = planMany(['codex_cli', 'gemini_cli'], snapshot, stdioEndpoint, home)
    const result = applyChanges(changes)
    const symlinks = result.written.filter((p) => p.includes('.codex/skills') || p.includes('.gemini/skills'))
    expect(symlinks).toHaveLength(2)
    expect(new Set(symlinks).size).toBe(symlinks.length)
  })
})

describe('registro de adaptadores', () => {
  it('tiene los cuatro CLIs', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(['claude_code', 'codex_cli', 'gemini_cli', 'kiro'])
    expect(new ClaudeCodeAdapter().cliKind).toBe('claude_code')
    expect(new CodexCliAdapter().cliKind).toBe('codex_cli')
    expect(new GeminiCliAdapter().cliKind).toBe('gemini_cli')
    expect(new KiroAdapter().cliKind).toBe('kiro')
  })
})
