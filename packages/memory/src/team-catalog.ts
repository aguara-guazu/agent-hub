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
export type TeamLaunchRoute = 'agent_launch' | 'native_terminal' | 'unsupported'

const launchRoutes: Record<ExtractionCli, Exclude<TeamLaunchRoute, 'unsupported'>> = {
  claude_code: 'agent_launch',
  codex_cli: 'agent_launch',
  kiro: 'native_terminal',
}

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
  /** Native candidate; team_catalog also checks the current Orca context and adapter preflight. */
  launchable: boolean
  launch_route: TeamLaunchRoute
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
  context_window_tokens?: number
  rate_multiplier?: number
  default?: boolean
  reasoning_efforts: string[]
  reasoning_efforts_source: CliReasoningEffortsSource
  checked_at: string
  source: CliDiscoverySource
  access: 'unverified'
  role_hints: TeamRoleHint[]
  warnings: string[]
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

export interface TeamValidation extends TeamSelection {
  capabilities: {
    cli: TeamCatalogCli
    model: TeamCatalogModel
  }
}

type CatalogStatus = Omit<CliStatus, 'installed'> & { installed: boolean | null }

const KIRO_FALLBACK_WARNING = 'Los esfuerzos de este modelo son una compatibilidad declarada por el adaptador: Kiro CLI no los informó y su acceso sigue sin verificar.'

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
    ...(model.context_window_tokens === undefined ? {} : { context_window_tokens: model.context_window_tokens }),
    ...(model.rate_multiplier === undefined ? {} : { rate_multiplier: model.rate_multiplier }),
    ...(model.default === undefined ? {} : { default: model.default }),
    reasoning_efforts: [...model.reasoning_efforts],
    reasoning_efforts_source: model.reasoning_efforts_source,
    checked_at: status.checked_at,
    source: status.source,
    access: 'unverified',
    role_hints: hints,
    warnings: model.reasoning_efforts_source === 'fallback' && model.reasoning_efforts.length > 0 ? [KIRO_FALLBACK_WARNING] : [],
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

function catalogCli(cli: ExtractionCli, status: CatalogStatus): TeamCatalogCli {
  const modelSelectable = status.installed === true && status.models.length > 0
  return {
    id: cli,
    label: cliLabels[cli],
    installed: status.installed,
    catalogable: true,
    model_selectable: modelSelectable,
    launchable: modelSelectable,
    launch_route: launchRoutes[cli],
    checked_at: status.checked_at,
    source: status.source,
    ...(status.detail ? { detail: status.detail } : {}),
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
        ...statuses.map(({ cli, status }) => catalogCli(cli, status)),
        ...unsupportedClis.map(({ id, label }): TeamCatalogCli => ({
          id,
          label,
          installed: null,
          catalogable: false,
          model_selectable: false,
          launchable: false,
          launch_route: 'unsupported',
          checked_at: new Date().toISOString(),
          source: 'unsupported',
          detail: 'Este cliente todavía no admite discovery ni lanzamiento de miembros de equipo.',
        })),
      ],
      models: statuses.flatMap(({ cli, status }) => status.installed === true
        ? status.models.map(model => catalogModel(cli, status, model)) : []),
    }
  }

  async validate(cli: ExtractionCli, model: string, effort?: string): Promise<TeamValidation> {
    check(isExtractionCli(String(cli)), 'Ese cliente no admite miembros de equipo.', 422)
    const status = await discover(this.runtime, cli)
    const client = catalogCli(cli, status)
    check(client.catalogable, `${cliLabels[cli]} no admite catálogo de modelos para equipos.`, 409)
    check(client.installed === true, `${cliLabels[cli]} no está instalado o no se pudo verificar.`, 409)
    check(client.model_selectable && client.launchable, `${cliLabels[cli]} no devolvió un catálogo de modelos; no se puede lanzar el miembro.`, 409)
    const discovered = status.models.find(candidate => candidate.id === model)
    check(discovered, `${cliLabels[cli]} no ofrece el modelo elegido. Actualizá el catálogo y volvé a elegirlo.`, 409)
    const selected = catalogModel(cli, status, discovered)
    check(selected.source === 'native' && selected.access === 'unverified', `${cliLabels[cli]} devolvió procedencia incompatible para el modelo elegido.`, 409)
    if (effort) {
      check(selected.reasoning_efforts.includes(effort), `${cliLabels[cli]} no ofrece ese esfuerzo para el modelo elegido.`, 409)
      const declaredKiroFallback = cli === 'kiro' && selected.reasoning_efforts_source === 'fallback'
        && selected.warnings.includes(KIRO_FALLBACK_WARNING)
      check(selected.reasoning_efforts_source === 'native' || declaredKiroFallback,
        `${cliLabels[cli]} no informó ese esfuerzo ni existe una compatibilidad declarada por el adaptador.`, 409)
    }
    return {
      cli,
      model,
      ...(effort ? { effort } : {}),
      capabilities: {
        cli: { ...client },
        model: { ...selected, reasoning_efforts: [...selected.reasoning_efforts], role_hints: selected.role_hints.map(hint => ({ ...hint })), warnings: [...selected.warnings] },
      },
    }
  }
}
