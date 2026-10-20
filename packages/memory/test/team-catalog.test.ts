import { describe, expect, it, vi } from 'vitest'
import type { CliExtractionRuntime, CliStatus, ExtractionCli } from '../src/cli-extraction.js'
import { TeamCatalog } from '../src/team-catalog.js'

const statuses: Record<ExtractionCli, CliStatus> = {
  claude_code: { installed: true, models: [{ id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.', reasoning_efforts: ['low', 'high'], reasoning_efforts_source: 'cli' }] },
  codex_cli: { installed: true, models: [{ id: 'gpt-fallback', name: 'GPT Fallback', default: true, reasoning_efforts: ['medium'], reasoning_efforts_source: 'cli' }] },
  kiro: { installed: false, models: [], detail: 'Kiro no detectado.' },
}

function runtime(overrides: Partial<Record<ExtractionCli, CliStatus>> = {}) {
  return { status: vi.fn(async (cli: ExtractionCli) => overrides[cli] ?? statuses[cli]) } as unknown as CliExtractionRuntime
}

describe('TeamCatalog', () => {
  it('separa instalación, catálogo, selección y lanzamiento, con unsupported explícitos', async () => {
    const result = await new TeamCatalog(runtime()).catalog()

    expect(result.clis.slice(0, 3)).toEqual([
      { id: 'claude_code', label: 'Claude Code', installed: true, supported: true, catalogable: true, model_selectable: true, launchable: true },
      { id: 'codex_cli', label: 'Codex', installed: true, supported: true, catalogable: true, model_selectable: true, launchable: true },
      { id: 'kiro', label: 'Kiro CLI', installed: false, supported: true, catalogable: true, model_selectable: false, launchable: false, detail: 'Kiro no detectado.' },
    ])
    expect(result.clis.slice(3).map(cli => ({ id: cli.id, installed: cli.installed, supported: cli.supported, catalogable: cli.catalogable, model_selectable: cli.model_selectable, launchable: cli.launchable }))).toEqual([
      { id: 'gemini_cli', installed: null, supported: false, catalogable: false, model_selectable: false, launchable: false },
      { id: 'opencode', installed: null, supported: false, catalogable: false, model_selectable: false, launchable: false },
      { id: 'antigravity', installed: null, supported: false, catalogable: false, model_selectable: false, launchable: false },
      { id: 'claude_desktop', installed: null, supported: false, catalogable: false, model_selectable: false, launchable: false },
    ])
  })

  it('conserva descripción y esfuerzo nativos, y etiqueta heurísticas seguras por familia', async () => {
    const result = await new TeamCatalog(runtime()).catalog()

    expect(result.models[0]).toEqual({
      cli: 'claude_code', id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.',
      description_source: 'native', reasoning_efforts: ['low', 'high'], reasoning_efforts_source: 'cli',
    })
    expect(result.models[1]).toEqual({
      cli: 'codex_cli', id: 'gpt-fallback', name: 'GPT Fallback',
      description: 'Recomendación heurística por familia: considerar como opción general para implementación y revisión.',
      description_source: 'heuristic', default: true, reasoning_efforts: ['medium'], reasoning_efforts_source: 'cli',
    })
    expect(result.models[1]?.description).not.toMatch(/precio|barato|caro|latest|último|cuota|acceso|benchmark/i)
  })

  it('una CLI instalada sin catálogo no queda seleccionable ni lanzable', async () => {
    const result = await new TeamCatalog(runtime({ kiro: { installed: true, models: [], detail: 'Catálogo no disponible.' } })).catalog()
    expect(result.clis.find(cli => cli.id === 'kiro')).toMatchObject({ installed: true, catalogable: true, model_selectable: false, launchable: false })
  })

  it('valida una selección exacta y conserva effort CLI o fallback conocido', async () => {
    const catalog = new TeamCatalog(runtime({ kiro: { installed: true, models: [{ id: 'gpt-5.6-sol', name: 'GPT', reasoning_efforts: ['high'], reasoning_efforts_source: 'fallback' }] } }))
    await expect(catalog.validate('claude_code', 'claude-native', 'high')).resolves.toEqual({ cli: 'claude_code', model: 'claude-native', effort: 'high' })
    await expect(catalog.validate('kiro', 'gpt-5.6-sol', 'high')).resolves.toEqual({ cli: 'kiro', model: 'gpt-5.6-sol', effort: 'high' })
    await expect(catalog.validate('codex_cli', 'gpt-fallback')).resolves.toEqual({ cli: 'codex_cli', model: 'gpt-fallback' })
  })

  it('rechaza CLI unsupported, catálogo ausente, modelo inexistente y effort no soportado', async () => {
    const catalog = new TeamCatalog(runtime({ kiro: { installed: true, models: [] } }))
    await expect(catalog.validate('kiro', 'anything')).rejects.toThrow('no devolvió un catálogo')
    await expect(catalog.validate('claude_code', 'missing')).rejects.toThrow('no ofrece el modelo')
    await expect(catalog.validate('claude_code', 'claude-native', 'max')).rejects.toThrow('no ofrece ese esfuerzo')
    const unknownFallback = new TeamCatalog(runtime({ kiro: { installed: true, models: [{ id: 'unknown', name: 'Unknown', reasoning_efforts: [], reasoning_efforts_source: 'fallback' }] } }))
    await expect(unknownFallback.validate('kiro', 'unknown', 'high')).rejects.toThrow('no ofrece ese esfuerzo')
    await expect(catalog.validate('gemini_cli' as ExtractionCli, 'model')).rejects.toMatchObject({ statusCode: 422 })
  })
})
