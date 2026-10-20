import { describe, expect, it, vi } from 'vitest'
import type { CliExtractionRuntime, CliStatus, ExtractionCli } from '../src/cli-extraction.js'
import { TeamCatalog } from '../src/team-catalog.js'

const checkedAt = '2026-10-20T18:00:00.000Z'
const statuses: Record<ExtractionCli, CliStatus> = {
  claude_code: { installed: true, checked_at: checkedAt, source: 'native', models: [{ id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.', reasoning_efforts: ['low', 'high'], reasoning_efforts_source: 'native' }] },
  codex_cli: { installed: true, checked_at: checkedAt, source: 'native', models: [{ id: 'gpt-5.6-sol', name: 'GPT Sol', default: true, reasoning_efforts: ['medium'], reasoning_efforts_source: 'native' }] },
  kiro: { installed: false, checked_at: checkedAt, source: 'native', models: [], detail: 'Kiro no detectado.' },
}

function runtime(overrides: Partial<Record<ExtractionCli, CliStatus>> = {}) {
  return { status: vi.fn(async (cli: ExtractionCli) => overrides[cli] ?? statuses[cli]) } as unknown as CliExtractionRuntime
}

describe('TeamCatalog', () => {
  it('separa instalación, catálogo, selección y lanzamiento, con unsupported explícitos', async () => {
    const result = await new TeamCatalog(runtime()).catalog()

    expect(result.clis.slice(0, 3)).toEqual([
      { id: 'claude_code', label: 'Claude Code', installed: true, catalogable: true, model_selectable: true, launchable: true, checked_at: checkedAt, source: 'native' },
      { id: 'codex_cli', label: 'Codex', installed: true, catalogable: true, model_selectable: true, launchable: true, checked_at: checkedAt, source: 'native' },
      { id: 'kiro', label: 'Kiro CLI', installed: false, catalogable: true, model_selectable: false, launchable: false, checked_at: checkedAt, source: 'native', detail: 'Kiro no detectado.' },
    ])
    expect(result.clis.slice(3).map(cli => ({ id: cli.id, installed: cli.installed, catalogable: cli.catalogable, model_selectable: cli.model_selectable, launchable: cli.launchable, source: cli.source }))).toEqual([
      { id: 'gemini_cli', installed: null, catalogable: false, model_selectable: false, launchable: false, source: 'unsupported' },
      { id: 'opencode', installed: null, catalogable: false, model_selectable: false, launchable: false, source: 'unsupported' },
      { id: 'antigravity', installed: null, catalogable: false, model_selectable: false, launchable: false, source: 'unsupported' },
      { id: 'claude_desktop', installed: null, catalogable: false, model_selectable: false, launchable: false, source: 'unsupported' },
    ])
  })

  it('conserva descripción nativa y expone discovery/access sin afirmar acceso de cuenta', async () => {
    const model = (await new TeamCatalog(runtime()).catalog()).models[0]
    expect(model).toEqual({
      cli: 'claude_code', id: 'claude-native', name: 'Claude Native', description: 'Descripción entregada por Claude.',
      description_source: 'native', reasoning_efforts: ['low', 'high'], reasoning_efforts_source: 'native',
      checked_at: checkedAt, source: 'native', access: 'unverified', role_hints: [],
    })
  })

  it('agrega role_hints heurísticos sólo para familias conocidas', async () => {
    const model = (id: string, name = id) => ({ id, name, reasoning_efforts: [], reasoning_efforts_source: 'native' as const })
    const result = await new TeamCatalog(runtime({ codex_cli: { installed: true, checked_at: checkedAt, source: 'native', models: [
      model('gpt-5.6-sol'), model('claude-haiku-4.5'), model('gpt-6-astra'), model('modelo-desconocido'),
    ] } })).catalog()
    const models = result.models.filter(item => item.cli === 'codex_cli')

    expect(models[0]?.role_hints.map(hint => hint.role)).toEqual(['implementation'])
    expect(models[1]?.role_hints.map(hint => hint.role)).toEqual(['exploration'])
    expect(models[2]?.role_hints.map(hint => hint.role)).toEqual(['design', 'review'])
    expect(models[2]?.role_hints.every(hint => hint.source === 'heuristic')).toBe(true)
    expect(models[3]).toMatchObject({ role_hints: [] })
    expect(models[3]).not.toHaveProperty('description')
    expect(models.flatMap(item => item.role_hints.map(hint => hint.rationale)).join(' ')).not.toMatch(/precio|costo|velocidad medida|latest|benchmark/i)
  })

  it('conserva un catálogo parcial cuando falla el discovery de una CLI', async () => {
    const failing = { status: vi.fn(async (cli: ExtractionCli) => {
      if (cli === 'codex_cli') throw new Error('raw provider secret')
      return statuses[cli]
    }) } as unknown as CliExtractionRuntime
    const result = await new TeamCatalog(failing).catalog()

    expect(result.models.some(model => model.cli === 'claude_code')).toBe(true)
    expect(result.models.some(model => model.cli === 'codex_cli')).toBe(false)
    expect(result.clis.find(cli => cli.id === 'codex_cli')).toMatchObject({ installed: null, catalogable: true, model_selectable: false, launchable: false, source: 'native' })
    expect(result.clis.find(cli => cli.id === 'codex_cli')?.detail).not.toContain('raw provider secret')
  })

  it('valida sólo catálogo nativo y rechaza effort inferido, catálogo ausente o selección inválida', async () => {
    const fallback = new TeamCatalog(runtime({ kiro: { installed: true, checked_at: checkedAt, source: 'native', models: [{ id: 'gpt-5.6-sol', name: 'GPT', reasoning_efforts: ['high'], reasoning_efforts_source: 'fallback' }] } }))
    await expect(new TeamCatalog(runtime()).validate('claude_code', 'claude-native', 'high')).resolves.toEqual({ cli: 'claude_code', model: 'claude-native', effort: 'high' })
    await expect(fallback.validate('kiro', 'gpt-5.6-sol')).resolves.toEqual({ cli: 'kiro', model: 'gpt-5.6-sol' })
    await expect(fallback.validate('kiro', 'gpt-5.6-sol', 'high')).rejects.toThrow('sólo infiere ese esfuerzo')
    await expect(new TeamCatalog(runtime({ kiro: { installed: true, checked_at: checkedAt, source: 'native', models: [] } })).validate('kiro', 'anything')).rejects.toThrow('no devolvió un catálogo')
    await expect(new TeamCatalog(runtime()).validate('claude_code', 'missing')).rejects.toThrow('no ofrece el modelo')
    await expect(new TeamCatalog(runtime()).validate('claude_code', 'claude-native', 'max')).rejects.toThrow('no ofrece ese esfuerzo')
    await expect(new TeamCatalog(runtime()).validate('gemini_cli' as ExtractionCli, 'model')).rejects.toMatchObject({ statusCode: 422 })
  })
})
