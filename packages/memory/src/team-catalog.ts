import { check } from './contracts.js'
import {
  cliLabels,
  extractionClis,
  isExtractionCli,
  type CliExtractionRuntime,
  type CliModel,
  type CliReasoningEffortsSource,
  type ExtractionCli,
} from './cli-extraction.js'

export type TeamModelDescriptionSource = 'native' | 'heuristic'
export type UnsupportedTeamCli = 'gemini_cli' | 'opencode' | 'antigravity' | 'claude_desktop'
export type TeamCatalogCliId = ExtractionCli | UnsupportedTeamCli

const unsupportedClis: ReadonlyArray<{ id: UnsupportedTeamCli; label: string }> = [
  { id: 'gemini_cli', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'claude_desktop', label: 'Claude Desktop' },
]

export interface TeamCatalogCli {
  id: TeamCatalogCliId
  label: string
  /** null means this catalog deliberately does not inspect installation for an unsupported CLI. */
  installed: boolean | null
  supported: boolean
  catalogable: boolean
  model_selectable: boolean
  launchable: boolean
  detail?: string
}

export interface TeamCatalogModel {
  cli: ExtractionCli
  id: string
  name: string
  description: string
  description_source: TeamModelDescriptionSource
  default?: boolean
  reasoning_efforts: string[]
  reasoning_efforts_source: CliReasoningEffortsSource
}

export interface TeamCatalogResult {
  clis: TeamCatalogCli[]
  models: TeamCatalogModel[]
}

export interface TeamSelection {
  cli: ExtractionCli
  model: string
  effort?: string
}

/** Family guidance is intentionally qualitative and carries heuristic provenance.
 * It never claims price, recency, benchmarks or account-specific availability. */
function heuristicDescription(cli: ExtractionCli, model: CliModel): string {
  const family = `${model.id} ${model.name}`.toLowerCase()
  if (family.includes('haiku')) return 'Recomendación heurística por familia: considerar para una tarea acotada.'
  if (family.includes('opus')) return 'Recomendación heurística por familia: considerar para análisis o revisión compleja.'
  if (family.includes('sonnet')) return 'Recomendación heurística por familia: considerar como opción general para implementación y revisión.'
  if (/(?:^|\W)gpt(?:\W|$)/.test(family)) return 'Recomendación heurística por familia: considerar como opción general para implementación y revisión.'
  const identity = model.name === model.id ? model.id : `${model.name} (${model.id})`
  return `${identity}, modelo informado por ${cliLabels[cli]}.`
}

function catalogModel(cli: ExtractionCli, model: CliModel): TeamCatalogModel {
  const native = model.description?.trim()
  return {
    cli,
    id: model.id,
    name: model.name,
    description: native || heuristicDescription(cli, model),
    description_source: native ? 'native' : 'heuristic',
    ...(model.default === undefined ? {} : { default: model.default }),
    reasoning_efforts: [...model.reasoning_efforts],
    reasoning_efforts_source: model.reasoning_efforts_source,
  }
}

/** Models available to the three launch adapters. Unsupported clients remain
 * visible instead of being mistaken for not installed or silently omitted. */
export class TeamCatalog {
  constructor(private readonly runtime: CliExtractionRuntime) {}

  async catalog(): Promise<TeamCatalogResult> {
    const statuses = await Promise.all(extractionClis.map(async cli => ({ cli, status: await this.runtime.status(cli) })))
    return {
      clis: [
        ...statuses.map(({ cli, status }): TeamCatalogCli => {
          const modelSelectable = status.installed && status.models.length > 0
          return {
            id: cli,
            label: cliLabels[cli],
            installed: status.installed,
            supported: true,
            catalogable: true,
            model_selectable: modelSelectable,
            launchable: modelSelectable,
            ...(status.detail ? { detail: status.detail } : {}),
          }
        }),
        ...unsupportedClis.map(({ id, label }): TeamCatalogCli => ({
          id,
          label,
          installed: null,
          supported: false,
          catalogable: false,
          model_selectable: false,
          launchable: false,
          detail: 'Este cliente todavía no admite miembros de equipo lanzados por Agent Hub.',
        })),
      ],
      models: statuses.flatMap(({ cli, status }) => status.models.map(model => catalogModel(cli, model))),
    }
  }

  async validate(cli: ExtractionCli, model: string, effort?: string): Promise<TeamSelection> {
    check(isExtractionCli(String(cli)), 'Ese cliente no admite miembros de equipo.', 422)
    const status = await this.runtime.status(cli)
    check(status.installed, `${cliLabels[cli]} no está instalado.`, 409)
    check(status.models.length > 0, `${cliLabels[cli]} no devolvió un catálogo de modelos; no se puede lanzar el miembro.`, 409)
    const selected = status.models.find(candidate => candidate.id === model)
    check(selected, `${cliLabels[cli]} no ofrece el modelo elegido. Actualizá el catálogo y volvé a elegirlo.`, 409)
    if (effort) check(selected.reasoning_efforts.includes(effort), `${cliLabels[cli]} no ofrece ese esfuerzo para el modelo elegido.`, 409)
    return { cli, model, ...(effort ? { effort } : {}) }
  }
}
