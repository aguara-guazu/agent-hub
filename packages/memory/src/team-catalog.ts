import { check } from './contracts.js'
import {
  cliLabels,
  extractionClis,
  isExtractionCli,
  type CliDiscoverySource,
  type CliExtractionRuntime,
  type CliModel,
  type CliReasoningEffortsSource,
  type CliStatus,
  type ExtractionCli,
} from './cli-extraction.js'

export type TeamModelDescriptionSource = 'native' | 'heuristic'
export type UnsupportedTeamCli = 'gemini_cli' | 'opencode' | 'antigravity' | 'claude_desktop'
export type TeamCatalogCliId = ExtractionCli | UnsupportedTeamCli
export type TeamRole = 'exploration' | 'implementation' | 'design' | 'review'

const unsupportedClis: ReadonlyArray<{ id: UnsupportedTeamCli; label: string }> = [
  { id: 'gemini_cli', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'claude_desktop', label: 'Claude Desktop' },
]

export interface TeamCatalogCli {
  id: TeamCatalogCliId
  label: string
  /** null means discovery could not determine installation or does not support this CLI. */
  installed: boolean | null
  catalogable: boolean
  model_selectable: boolean
  launchable: boolean
  checked_at: string
  source: CliDiscoverySource | 'unsupported'
  detail?: string
}

export interface TeamRoleHint {
  role: TeamRole
  rationale: string
  source: 'heuristic'
}

export interface TeamCatalogModel {
  cli: ExtractionCli
  id: string
  name: string
  description?: string
  description_source?: TeamModelDescriptionSource
  default?: boolean
  reasoning_efforts: string[]
  reasoning_efforts_source: CliReasoningEffortsSource
  checked_at: string
  source: CliDiscoverySource
  access: 'unverified'
  role_hints: TeamRoleHint[]
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

type CatalogStatus = Omit<CliStatus, 'installed'> & { installed: boolean | null }

function token(value: string, name: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${name}(?:$|[^a-z0-9])`, 'i').test(value)
}

/** Qualitative family guidance only. Unknown families receive no inferred role. */
function roleHints(model: CliModel): TeamRoleHint[] {
  const family = `${model.id} ${model.name}`
  if (token(family, 'haiku')) return [{ role: 'exploration', rationale: 'Considerar esta familia para exploración y uso liviano de herramientas.', source: 'heuristic' }]
  if (token(family, 'sol')) return [{ role: 'implementation', rationale: 'Considerar esta familia para tareas de implementación.', source: 'heuristic' }]
  if (token(family, 'astra') || token(family, 'opus')) return [
    { role: 'design', rationale: 'Considerar esta familia para tareas de diseño.', source: 'heuristic' },
    { role: 'review', rationale: 'Considerar esta familia para tareas de revisión.', source: 'heuristic' },
  ]
  return []
}

function catalogModel(cli: ExtractionCli, status: CatalogStatus, model: CliModel): TeamCatalogModel {
  const native = model.description?.trim()
  const hints = roleHints(model)
  const heuristic = hints.length ? hints.map(hint => hint.rationale).join(' ') : undefined
  return {
    cli,
    id: model.id,
    name: model.name,
    ...(native ? { description: native, description_source: 'native' as const }
      : heuristic ? { description: heuristic, description_source: 'heuristic' as const } : {}),
    ...(model.default === undefined ? {} : { default: model.default }),
    reasoning_efforts: [...model.reasoning_efforts],
    reasoning_efforts_source: model.reasoning_efforts_source,
    checked_at: status.checked_at,
    source: status.source,
    access: 'unverified',
    role_hints: hints,
  }
}

async function discover(runtime: CliExtractionRuntime, cli: ExtractionCli): Promise<CatalogStatus> {
  try { return await runtime.status(cli) }
  catch {
    return {
      installed: null,
      models: [],
      checked_at: new Date().toISOString(),
      source: 'native',
      detail: `No se pudo consultar ${cliLabels[cli]}; los demás catálogos siguen disponibles.`,
    }
  }
}

/** Models available to the three launch adapters. Each native discovery is
 * independent, so one broken CLI cannot hide the other catalog entries. */
export class TeamCatalog {
  constructor(private readonly runtime: CliExtractionRuntime) {}

  async catalog(): Promise<TeamCatalogResult> {
    const statuses = await Promise.all(extractionClis.map(async cli => ({ cli, status: await discover(this.runtime, cli) })))
    return {
      clis: [
        ...statuses.map(({ cli, status }): TeamCatalogCli => {
          const modelSelectable = status.installed === true && status.models.length > 0
          return {
            id: cli,
            label: cliLabels[cli],
            installed: status.installed,
            catalogable: true,
            model_selectable: modelSelectable,
            launchable: modelSelectable,
            checked_at: status.checked_at,
            source: status.source,
            ...(status.detail ? { detail: status.detail } : {}),
          }
        }),
        ...unsupportedClis.map(({ id, label }): TeamCatalogCli => ({
          id,
          label,
          installed: null,
          catalogable: false,
          model_selectable: false,
          launchable: false,
          checked_at: new Date().toISOString(),
          source: 'unsupported',
          detail: 'Este cliente todavía no admite discovery ni lanzamiento de miembros de equipo.',
        })),
      ],
      models: statuses.flatMap(({ cli, status }) => status.installed === true
        ? status.models.map(model => catalogModel(cli, status, model)) : []),
    }
  }

  async validate(cli: ExtractionCli, model: string, effort?: string): Promise<TeamSelection> {
    check(isExtractionCli(String(cli)), 'Ese cliente no admite miembros de equipo.', 422)
    const status = await this.runtime.status(cli)
    check(status.installed, `${cliLabels[cli]} no está instalado.`, 409)
    check(status.models.length > 0, `${cliLabels[cli]} no devolvió un catálogo de modelos; no se puede lanzar el miembro.`, 409)
    const selected = status.models.find(candidate => candidate.id === model)
    check(selected, `${cliLabels[cli]} no ofrece el modelo elegido. Actualizá el catálogo y volvé a elegirlo.`, 409)
    if (effort) {
      check(selected.reasoning_efforts_source === 'native', `${cliLabels[cli]} sólo infiere ese esfuerzo; elegí el esfuerzo predeterminado para lanzar el miembro.`, 409)
      check(selected.reasoning_efforts.includes(effort), `${cliLabels[cli]} no ofrece ese esfuerzo para el modelo elegido.`, 409)
    }
    return { cli, model, ...(effort ? { effort } : {}) }
  }
}
