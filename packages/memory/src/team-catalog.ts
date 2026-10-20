import { check } from './contracts.js'
import {
  cliLabels,
  extractionClis,
  isExtractionCli,
  type CliExtractionRuntime,
  type CliModel,
  type ExtractionCli,
} from './cli-extraction.js'

export type TeamModelDescriptionSource = 'native' | 'heuristic'

export interface TeamCatalogCli {
  id: ExtractionCli
  label: string
  installed: boolean
  supported: true
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

/** Tautological fallback: it identifies the observed model without claiming cost,
 * recency, quality or access that the native catalog did not report. */
function heuristicDescription(cli: ExtractionCli, model: CliModel): string {
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
  }
}

/** Models available to launchable team CLIs. Discovery reports availability;
 * only validate() accepts a concrete CLI/model/effort selection. */
export class TeamCatalog {
  constructor(private readonly runtime: CliExtractionRuntime) {}

  async catalog(): Promise<TeamCatalogResult> {
    const statuses = await Promise.all(extractionClis.map(async cli => ({ cli, status: await this.runtime.status(cli) })))
    return {
      clis: statuses.map(({ cli, status }) => ({
        id: cli,
        label: cliLabels[cli],
        installed: status.installed,
        supported: true,
        ...(status.detail ? { detail: status.detail } : {}),
      })),
      models: statuses.flatMap(({ cli, status }) => status.models.map(model => catalogModel(cli, model))),
    }
  }

  async validate(cli: ExtractionCli, model: string, effort?: string): Promise<TeamSelection> {
    check(isExtractionCli(String(cli)), 'Ese cliente no admite miembros de equipo.', 422)
    const status = await this.runtime.status(cli)
    check(status.installed, `${cliLabels[cli]} no está instalado.`, 409)
    const selected = status.models.find(candidate => candidate.id === model)
    check(selected, `${cliLabels[cli]} no ofrece el modelo elegido. Actualizá el catálogo y volvé a elegirlo.`, 409)
    if (effort) check(selected.reasoning_efforts.includes(effort), `${cliLabels[cli]} no ofrece ese esfuerzo para el modelo elegido.`, 409)
    return { cli, model, ...(effort ? { effort } : {}) }
  }
}
