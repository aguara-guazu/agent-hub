import { describe, expect, it, vi } from 'vitest'
import type { CliExtractionRuntime, CliStatus, ExtractionCli } from '../src/cli-extraction.js'
import { TeamCatalog } from '../src/team-catalog.js'

const statuses: Record<ExtractionCli, CliStatus> = {
  claude_code: { installed: true, models: [{ id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.', reasoning_efforts: ['low', 'high'] }] },
  codex_cli: { installed: true, models: [{ id: 'gpt-fallback', name: 'GPT Fallback', default: true, reasoning_efforts: ['medium'] }] },
  kiro: { installed: false, models: [], detail: 'Kiro no detectado.' },
}

function runtime(overrides: Partial<Record<ExtractionCli, CliStatus>> = {}) {
  return { status: vi.fn(async (cli: ExtractionCli) => overrides[cli] ?? statuses[cli]) } as unknown as CliExtractionRuntime
}

describe('TeamCatalog', () => {
  it('devuelve CLIs parciales y modelos con descripción y procedencia explícitas', async () => {
    const result = await new TeamCatalog(runtime()).catalog()

    expect(result.clis).toEqual([
      { id: 'claude_code', label: 'Claude Code', installed: true, supported: true },
      { id: 'codex_cli', label: 'Codex', installed: true, supported: true },
      { id: 'kiro', label: 'Kiro CLI', installed: false, supported: true, detail: 'Kiro no detectado.' },
    ])
    expect(result.models[0]).toEqual({
      cli: 'claude_code', id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.',
      description_source: 'native', reasoning_efforts: ['low', 'high'],
    })
    expect(result.models[1]).toEqual({
      cli: 'codex_cli', id: 'gpt-fallback', name: 'GPT Fallback', description: 'GPT Fallback (gpt-fallback), modelo informado por Codex.',
      description_source: 'heuristic', default: true, reasoning_efforts: ['medium'],
    })
    expect(result.models[1]?.description).not.toMatch(/precio|barato|caro|latest|último|cuota|acceso/i)
  })

  it('valida una selección exacta y conserva el esfuerzo opcional', async () => {
    const catalog = new TeamCatalog(runtime())
    await expect(catalog.validate('claude_code', 'claude-native', 'high')).resolves.toEqual({ cli: 'claude_code', model: 'claude-native', effort: 'high' })
    await expect(catalog.validate('codex_cli', 'gpt-fallback')).resolves.toEqual({ cli: 'codex_cli', model: 'gpt-fallback' })
  })

  it('rechaza CLI ausente, modelo inexistente y esfuerzo no soportado', async () => {
    const catalog = new TeamCatalog(runtime())
    await expect(catalog.validate('kiro', 'anything')).rejects.toMatchObject({ statusCode: 409 })
    await expect(catalog.validate('claude_code', 'missing')).rejects.toThrow('no ofrece el modelo')
    await expect(catalog.validate('claude_code', 'claude-native', 'max')).rejects.toThrow('no ofrece ese esfuerzo')
    await expect(catalog.validate('gemini_cli' as ExtractionCli, 'model')).rejects.toMatchObject({ statusCode: 422 })
  })
})
