import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  Button, Chip, ConfirmDialog, Dl, ErrorState, Field, Input, List, Loading, MoreMenu, Panel, PanelBody, PanelFooter, PanelHeader, RowLink, Select, useToast,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { useDeliveryChannels, useRuns, useSchedules } from "../../lib/automations"
import type { MemoryEntity } from "../../lib/memory"
import {
  AUTOMATION_FIELDS, DEFAULT_LIMITS, ROSTER_CLIS, automationErrorCode, automationServerProblem, cleanDocument, parseBranches, repositoryServerProblem,
  useAddRepository, useProjectAutomation, useSaveProjectAutomation, validateDelegation, validateRepository,
} from "../../lib/project-automation"
import type {
  AutomationField, DelegatedItemKind, DelegationDocument, FieldProblem, FieldProblems, ProjectAutomationView, RepositoryField, RepositoryProblem, RepositoryProblems, RosterEntry,
} from "../../lib/project-automation"
import { useActionError, useScheduleText } from "./shared"

const FLEET_CLIS = ROSTER_CLIS
type FleetCli = typeof FLEET_CLIS[number]
const FIELD_LABELS: Record<AutomationField, "actions" | "repositories" | "channel" | "coordinatorCli" | "coordinatorModel" | "agentCli" | "agentModel"> = {
  actions: "actions", repositories: "repositories", channel: "channel",
  "coordinator.cli": "coordinatorCli", "coordinator.model": "coordinatorModel", "agent.cli": "agentCli", "agent.model": "agentModel",
}
/** Campos que vuelven a validarse cuando cambia cada parte del borrador (para limpiar el error del servidor al corregir). */
const TOUCHES: Record<keyof Draft, AutomationField[]> = {
  kinds: ["actions", "repositories"], repositories: ["repositories"], channel: ["channel"],
  coordinator: ["coordinator.cli", "coordinator.model"], agent: ["agent.cli", "agent.model"],
}

/** Lleva el foco y el scroll al primer campo marcado dentro de `root`. */
function focusFirstInvalid(root: HTMLElement | null) {
  const target = root?.querySelector<HTMLElement>("[data-invalid]")
  if (!target) return
  const control = target.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), textarea:not([disabled])") ?? target
  control.focus({ preventScroll: true })
  target.scrollIntoView({ block: "center", behavior: "smooth" })
}
const OWNER_TEMPLATES = ["daily_brief", "daily_close", "project_status"]
const NO_CHANNEL = "none"

interface Draft { kinds: DelegatedItemKind[]; repositories: string[]; channel: string; coordinator: RosterEntry; agent: RosterEntry }

function draftOf(project: MemoryEntity, view: ProjectAutomationView): Draft {
  const current = view.delegation?.document
  const fallback: RosterEntry = view.defaults?.coordinator ?? { cli: "claude_code", model: "" }
  const hasJira = Boolean(project.data?.jira_project_key)
  return {
    kinds: current?.item_kinds ?? (hasJira ? ["jira_worklog"] : []),
    repositories: current?.repository_ids ?? [],
    channel: view.channel?.id ?? view.channel_candidates[0]?.id ?? NO_CHANNEL,
    coordinator: current?.roster.coordinator ?? fallback,
    agent: current?.roster.project_agent ?? view.defaults?.project_agent ?? fallback,
  }
}

function Check({ checked, disabled, invalid, describedBy, onChange, children }: { checked: boolean; disabled?: boolean; invalid?: boolean; describedBy?: string; onChange: () => void; children: ReactNode }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" style={{ accentColor: "var(--accent)", margin: 0 }} checked={checked} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={onChange} />
      <span className="row-main">{children}</span>
    </label>
  )
}

function RosterFields({ label, value, errors, onChange }: { label: string; value: RosterEntry; errors: { cli?: string | undefined; model?: string | undefined }; onChange: (value: RosterEntry) => void }) {
  const { t } = useT("automations")
  const ts = useT("status").t
  const options = FLEET_CLIS.map(cli => ({ value: cli, label: ts(`client.${cli}`) }))
  const known = (FLEET_CLIS as readonly string[]).includes(value.cli)
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <legend className="label" style={{ padding: 0, marginBottom: "var(--sp-2)" }}>{label}</legend>
      <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div data-invalid={errors.cli ? "" : undefined} style={{ flex: "0 1 auto", minWidth: 0 }}>
          <Field label={t("project.cli")} error={errors.cli}>
            <Select<FleetCli> bare label={`${label} · ${t("project.cli")}`} value={known ? value.cli as FleetCli : ""} placeholder={value.cli} options={options} onChange={cli => onChange({ ...value, cli })} />
          </Field>
        </div>
        <div data-invalid={errors.model ? "" : undefined} style={{ flex: "1 1 160px", minWidth: 0 }}>
          <Field label={t("project.model")} error={errors.model}>
            <Input mono placeholder={t("project.modelPlaceholder")} value={value.model} onChange={event => onChange({ ...value, model: event.target.value })} />
          </Field>
        </div>
      </div>
    </fieldset>
  )
}

function RepositoryAdder({ projectId }: { projectId: string }) {
  const { t } = useT("automations")
  const format = useFormat()
  const toast = useToast()
  const save = useAddRepository(projectId)
  const errorText = useAutomationErrorText()
  const problemText = useProblemText()
  const root = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState("")
  const [branches, setBranches] = useState("feat/*, fix/*")
  const [attempted, setAttempted] = useState(false)
  const [server, setServer] = useState<RepositoryProblems>({})
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => { if (focusTick) focusFirstInvalid(root.current) }, [focusTick])
  const local = attempted ? validateRepository(path, parseBranches(branches)) : {}
  const problems: RepositoryProblems = { ...server, ...local }
  const text = (field: RepositoryField) => { const problem = problems[field]; return problem ? problemText(problem) : undefined }
  function add() {
    const list = parseBranches(branches)
    const found = validateRepository(path, list)
    setAttempted(true)
    setServer({})
    const fields = (Object.keys(found) as RepositoryField[])
    if (fields.length) {
      toast.error(t("project.repositoryFailed"), t("project.validation.review", { fields: format.list(fields.map(field => t(`project.validation.fields.${field}`))) }))
      setFocusTick(tick => tick + 1)
      return
    }
    save.mutate({ repo_path: path.trim(), allowed_branches: list }, {
      onSuccess: () => { setPath(""); setAttempted(false); toast.success(t("project.repositoryAdded")) },
      onError: error => {
        const mapped = repositoryServerProblem(error, list)
        if (!mapped) { toast.error(t("project.repositoryFailed"), errorText(error)); return }
        setServer({ [mapped.field]: mapped.problem })
        toast.error(t("project.repositoryFailed"), t("project.validation.review", { fields: t(`project.validation.fields.${mapped.field}`) }))
        setFocusTick(tick => tick + 1)
      },
    })
  }
  return (
    <div ref={root} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <div data-invalid={problems.repoPath ? "" : undefined}>
        <Field label={t("project.repoPath")} error={text("repoPath")}>
          <Input mono value={path} placeholder={t("project.repoPathPlaceholder")} onChange={event => { setPath(event.target.value); setServer(({ repoPath: _path, ...rest }) => rest) }} />
        </Field>
      </div>
      <div data-invalid={problems.repoBranches ? "" : undefined}>
        <Field label={t("project.repoBranches")} hint={t("project.repoBranchesHint")} error={text("repoBranches")}>
          <Input mono value={branches} onChange={event => { setBranches(event.target.value); setServer(({ repoBranches: _branches, ...rest }) => rest) }} />
        </Field>
      </div>
      <Button small icon="add" style={{ alignSelf: "flex-start" }} disabled={!path.trim() || save.isPending} onClick={add}>{t("project.addRepository")}</Button>
    </div>
  )
}

/** Texto del motivo de un campo marcado, por clave de `project.validation` o por código cerrado de `project.errors`. */
function useProblemText() {
  const { t } = useT("automations")
  return (problem: FieldProblem | RepositoryProblem): string => {
    if ("code" in problem) return t(`project.errors.${problem.code}`)
    if ("pattern" in problem) return t(`project.validation.${problem.message}`, { pattern: problem.pattern })
    return t(`project.validation.${problem.message}`)
  }
}

function useAutomationErrorText() {
  const { t } = useT("automations")
  const fallback = useActionError()
  return (error: unknown): string => {
    const code = automationErrorCode(error)
    return code ? t(`project.errors.${code}`) : fallback(error)
  }
}

/** Lo que la delegación permite, en lenguaje claro: es exactamente lo que se confirma. */
function DelegationSummary({ document, view }: { document: DelegationDocument; view: ProjectAutomationView }) {
  const { t, plural } = useT("automations")
  const ts = useT("status").t
  const cli = (entry: RosterEntry) => (FLEET_CLIS as readonly string[]).includes(entry.cli) ? ts(`client.${entry.cli as FleetCli}`) : entry.cli
  const repositories = document.repository_ids.map(id => view.repositories.find(repo => repo.id === id)?.repo_path ?? t("project.repositoryMissing", { id }))
  return (
    <Dl items={[
      { label: t("project.actions"), value: document.item_kinds.length ? document.item_kinds.map(kind => ts(`item.${kind}`)).join(" · ") : null },
      ...(document.item_kinds.includes("git_push") ? [{ label: t("project.repositories"), value: repositories.length ? <span className="mono xs">{repositories.join(", ")}</span> : null }] : []),
      { label: t("project.coordinator"), value: t("project.teamValue", { cli: cli(document.roster.coordinator), model: document.roster.coordinator.model }) },
      { label: t("project.agent"), value: t("project.teamValue", { cli: cli(document.roster.project_agent), model: document.roster.project_agent.model }) },
      { label: t("project.limits"), value: plural("project.limitsValue", document.limits.max_concurrent_plans, { minutes: document.limits.max_runtime_minutes }) },
      { label: t("project.channel"), value: view.channel?.name ?? t("project.noChannel") },
    ]} />
  )
}

function Schedules({ projectId }: { projectId: string }) {
  const { t } = useT("automations")
  const text = useScheduleText()
  const schedules = useSchedules()
  const rows = (schedules.data?.items ?? []).filter(item => item.state === "active" && OWNER_TEMPLATES.includes(item.template) && (item.scope === "owner" || item.project_id === projectId))
  if (schedules.isPending) return <Loading />
  if (rows.length === 0) return <span className="xs t3">{t("project.schedulesEmpty")}</span>
  return (
    <List>
      {rows.map(item => (
        <RowLink
          key={item.id}
          to={`/automations?focus=${encodeURIComponent(item.id)}`}
          aria-label={t("project.openAutomation", { name: item.title })}
          title={text.template(item)}
          sub={text.recurrence(item.recurrence)}
          meta={<span className="xs t2 num" style={{ whiteSpace: "nowrap" }}>{text.nextOf(item)}</span>}
        />
      ))}
    </List>
  )
}

function LastClose() {
  const { t } = useT("automations")
  const format = useFormat()
  const runs = useRuns({ kind: "close", limit: "1" })
  const last = runs.data?.items[0]
  return (
    <section className="section" style={{ gap: "var(--sp-3)" }}>
      <span className="label">{t("project.lastClose")}</span>
      {runs.isPending ? <Loading />
        : !last ? <span className="xs t3">{t("project.lastCloseEmpty")}</span>
        : <List><RowLink to={`/automations/deliveries/${encodeURIComponent(last.run_id)}`} title={last.title} sub={format.date(last.started_at ?? last.scheduled_for, "datetime")} /></List>}
    </section>
  )
}

/** Brief y cierre de un proyecto: delegación, acciones, canal y equipo. Guardado explícito; los horarios y canales de entrega
 *  de cada automatización viven en Automatizaciones y acá solo se enlazan. */
export function ProjectAutomationPanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const { t } = useT("automations")
  const automation = useProjectAutomation(project.id)
  const view = automation.data
  return (
    <Content key={view ? `${view.delegation?.version ?? 0}-${view.enabled}` : "loading"} project={project} view={view} error={automation.error} retry={() => void automation.refetch()} onClose={onClose} title={t("project.title")} />
  )
}

function Content({ project, view, error, retry, onClose, title }: { project: MemoryEntity; view: ProjectAutomationView | undefined; error: unknown; retry: () => void; onClose: () => void; title: string }) {
  const { t } = useT("automations")
  const tc = useT("common").t
  const format = useFormat()
  const toast = useToast()
  const errorText = useAutomationErrorText()
  const save = useSaveProjectAutomation(project.id)
  const channels = useDeliveryChannels()
  const initial = useMemo(() => (view ? draftOf(project, view) : null), [project, view])
  const [draft, setDraft] = useState<Draft | null>(initial)
  const [blocked, setBlocked] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [server, setServer] = useState<FieldProblems>({})
  const [focusTick, setFocusTick] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const idBase = useId()
  const problemText = useProblemText()
  useEffect(() => { if (focusTick) focusFirstInvalid(root.current) }, [focusTick])
  const dirty = Boolean(draft && initial && JSON.stringify(draft) !== JSON.stringify(initial))

  const header = (status?: ReactNode, actions?: ReactNode) => <PanelHeader title={title} status={status ?? <span className="xs t3 trunc" title={project.title}>{project.title}</span>} actions={actions} />
  if (error) return <Panel label={title} onClose={onClose} wide>{header()}<PanelBody><ErrorState error={error} title={t("project.loadError")} onRetry={retry} /></PanelBody></Panel>
  if (!view || !draft || !initial) return <Panel label={title} onClose={onClose} wide>{header()}<PanelBody><Loading /></PanelBody></Panel>

  const delegation = view.delegation
  const active = view.enabled && delegation !== null
  const review = active && delegation.approval_source === "coordinator_declaration"
  const hasJira = Boolean(project.data?.jira_project_key)
  const pushOn = draft.kinds.includes("git_push")
  const worklogOn = draft.kinds.includes("jira_worklog")
  const transitionsOn = draft.kinds.includes("jira_transition") && draft.kinds.includes("jira_comment")
  const check = (source: Draft) => validateDelegation({ kinds: source.kinds, repositories: source.repositories, coordinator: source.coordinator, agent: source.agent, hasJira, available: view.repositories })
  const problems: FieldProblems = { ...server, ...(attempted ? check(draft) : {}) }
  const errorOf = (field: AutomationField) => { const problem = problems[field]; return problem ? problemText(problem) : undefined }
  const hintId = (field: AutomationField) => `${idBase}-${field}`
  const marked = (field: AutomationField) => (problems[field] ? "" : undefined)
  const actionsInvalid = Boolean(problems.actions)
  const jiraProblem = Boolean(problems.actions && "message" in problems.actions && problems.actions.message === "jiraKeyMissing")
  const gmail = channels.data?.items.find(item => item.channel === "gmail")
  const set = (patch: Partial<Draft>) => {
    const touched = (Object.keys(patch) as (keyof Draft)[]).flatMap(key => TOUCHES[key])
    if (touched.some(field => server[field])) setServer(current => Object.fromEntries(Object.entries(current).filter(([field]) => !touched.includes(field as AutomationField))))
    setDraft(current => (current ? { ...current, ...patch } : current))
  }
  /** Un solo aviso con los campos a revisar; el motivo de cada uno queda en su campo. */
  const report = (fields: AutomationField[]) => {
    const names = [...new Set(AUTOMATION_FIELDS.filter(field => fields.includes(field)).map(field => {
      const problem = problems[field] ?? server[field] ?? check(draft)[field]
      return t(`project.validation.fields.${problem && "label" in problem && problem.label ? problem.label : FIELD_LABELS[field]}`)
    }))]
    toast.error(t("project.saveFailed"), t("project.validation.review", { fields: format.list(names) }))
    setFocusTick(tick => tick + 1)
  }
  const failed = (failure: unknown) => {
    const mapped = automationServerProblem(failure)
    if (!mapped) { toast.error(t("project.saveFailed"), errorText(failure)); return }
    setServer({ [mapped.field]: mapped.problem })
    const label = "label" in mapped.problem && mapped.problem.label ? mapped.problem.label : FIELD_LABELS[mapped.field]
    toast.error(t("project.saveFailed"), t("project.validation.review", { fields: t(`project.validation.fields.${label}`) }))
    setFocusTick(tick => tick + 1)
  }
  const toggleKinds = (...group: DelegatedItemKind[]) => set({
    kinds: group.every(kind => draft.kinds.includes(kind)) ? draft.kinds.filter(kind => !group.includes(kind)) : [...new Set([...draft.kinds, ...group])],
  })

  function documentOf(source: Draft): DelegationDocument {
    return cleanDocument({
      schema_version: 1,
      roster: { coordinator: { ...source.coordinator, model: source.coordinator.model.trim() }, project_agent: { ...source.agent, model: source.agent.model.trim() } },
      item_kinds: source.kinds,
      repository_ids: source.kinds.includes("git_push") ? source.repositories : [],
      limits: delegation?.document.limits ?? { ...DEFAULT_LIMITS },
    })
  }
  function submit() {
    if (!draft || save.isPending) return
    setAttempted(true)
    setServer({})
    const found = check(draft)
    const fields = Object.keys(found) as AutomationField[]
    if (fields.length) { report(fields); return }
    // Promesa y no callbacks de mutate: al guardar cambia la versión y el panel se vuelve a montar, y React Query descarta los callbacks de un observador desmontado.
    save.mutateAsync({ enabled: true, expected_version: delegation?.version ?? null, channel_id: draft.channel === NO_CHANNEL ? null : draft.channel, document: documentOf(draft) })
      .then(() => { setAttempted(false); toast.success(t(active ? "project.saved" : "project.activated")) }, failed)
  }
  function confirmDeclared() {
    if (!delegation) return
    save.mutateAsync({ enabled: true, expected_version: delegation.version, channel_id: view!.channel?.id ?? null, document: cleanDocument(delegation.document) })
      .then(() => toast.success(t("project.confirmed")), failed)
  }
  function deactivate() {
    if (!delegation) return
    save.mutateAsync({ enabled: false, expected_version: delegation.version, channel_id: view!.channel?.id ?? null, document: cleanDocument(delegation.document) })
      .then(() => { setDeactivating(false); toast.success(t("project.deactivated")) }, (failure: unknown) => { setDeactivating(false); toast.error(t("project.saveFailed"), errorText(failure)) })
  }

  const chip = <Chip tone={review ? "warn" : active ? "ok" : "off"}>{t(review ? "project.chip.review" : active ? "project.chip.on" : "project.chip.off")}</Chip>
  const channelOptions = [...view.channel_candidates.map(channel => ({ value: channel.id, label: channel.name })), { value: NO_CHANNEL, label: t("project.noChannel") }]
  return (
    <Panel label={title} onClose={onClose} wide dirty={dirty} onBlockedClose={() => setBlocked(true)}>
      {header(chip, active ? <MoreMenu small ghost items={[{ label: t("project.deactivate"), danger: true, onSelect: () => setDeactivating(true) }]} /> : undefined)}
      <PanelBody>
        <div ref={root} style={{ display: "contents" }}>
        {review && (
          <div className="card card-pad" style={{ background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            <span style={{ fontWeight: 500 }}>{delegation.instruction ? t("project.declaredQuote", { instruction: delegation.instruction }) : t("project.declared")}</span>
            <span className="xs t3">{t("project.declaredDetail")}</span>
            <DelegationSummary document={delegation.document} view={view} />
            <Button style={{ alignSelf: "flex-start" }} disabled={save.isPending || dirty} onClick={confirmDeclared}>{t("project.confirm")}</Button>
          </div>
        )}

        <section className="section" style={{ gap: "var(--sp-3)" }}>
          <span className="label">{t("project.schedules")}</span>
          {active ? <Schedules projectId={project.id} /> : <span className="t2">{t("project.schedulesDefault")}</span>}
        </section>
        {active && <LastClose />}
        <hr className="divider" />

        <div className="field" role="group" aria-labelledby={`${hintId("actions")}-label`} data-invalid={marked("actions")}>
          <span id={`${hintId("actions")}-label`} className="label">{t("project.actions")}</span>
          {/* Sin clave de Jira no se puede marcar una acción de Jira, pero sí desmarcar la que ya estaba. */}
          <Check checked={worklogOn} disabled={!hasJira && !worklogOn} invalid={actionsInvalid && (!jiraProblem || worklogOn)} describedBy={hintId("actions")} onChange={() => toggleKinds("jira_worklog")}><span>{t("project.worklog")}</span></Check>
          <Check checked={transitionsOn} disabled={!hasJira && !transitionsOn} invalid={actionsInvalid && (!jiraProblem || transitionsOn)} describedBy={hintId("actions")} onChange={() => toggleKinds("jira_transition", "jira_comment")}><span>{t("project.transitions")}</span></Check>
          <Check checked={pushOn} invalid={actionsInvalid && !jiraProblem} describedBy={hintId("actions")} onChange={() => toggleKinds("git_push")}><span>{t("project.pushes")}</span><span className="xs t3">{t("project.pushesHint")}</span></Check>
          <span id={hintId("actions")} className="hint" style={problems.actions ? { color: "var(--danger)" } : undefined}>{errorOf("actions") ?? (hasJira ? t("project.actionsHint") : t("project.noJira"))}</span>
        </div>

        {pushOn && (
          <div className="field" role="group" aria-labelledby={`${hintId("repositories")}-label`} data-invalid={marked("repositories")}>
            <span id={`${hintId("repositories")}-label`} className="label">{t("project.repositories")}</span>
            {view.repositories.length === 0 && <span className="xs t3">{t("project.repositoriesEmpty")}</span>}
            {view.repositories.map(repo => (
              <Check key={repo.id} checked={draft.repositories.includes(repo.id)} invalid={Boolean(problems.repositories)} describedBy={hintId("repositories")} onChange={() => set({ repositories: draft.repositories.includes(repo.id) ? draft.repositories.filter(id => id !== repo.id) : [...draft.repositories, repo.id] })}>
                <span className="mono xs trunc" title={repo.repo_path}>{repo.repo_path}</span>
                <span className="xs t3 trunc" title={repo.canonical_remote_url}>{t("project.repositoryBranches", { branches: repo.allowed_branches.join(", ") || "—", main: repo.default_branch })}</span>
              </Check>
            ))}
            {problems.repositories && <span id={hintId("repositories")} className="hint" style={{ color: "var(--danger)" }}>{errorOf("repositories")}</span>}
            <RepositoryAdder projectId={project.id} />
          </div>
        )}

        <div data-invalid={marked("channel")}>
          <Field label={t("project.channel")} hint={draft.channel === NO_CHANNEL ? t("project.noChannelHint") : undefined} error={errorOf("channel")}>
            {view.channel_candidates.length > 0
              ? <Select bare label={t("project.channel")} value={draft.channel} options={channelOptions} onChange={channel => set({ channel })} />
              : <span className="t3">{t("project.noChannels")}</span>}
          </Field>
        </div>
        {/* El backend exige el equipo siempre, también sin canal: se muestra para que nunca falle un dato oculto. */}
        <RosterFields label={t("project.coordinator")} value={draft.coordinator} errors={{ cli: errorOf("coordinator.cli"), model: errorOf("coordinator.model") }} onChange={coordinator => set({ coordinator })} />
        <RosterFields label={t("project.agent")} value={draft.agent} errors={{ cli: errorOf("agent.cli"), model: errorOf("agent.model") }} onChange={agent => set({ agent })} />
        <span className="hint" style={{ marginTop: "calc(-1 * var(--sp-2))" }}>{t("project.rosterHint")}</span>

        <div className="field">
          <span className="label">{t("project.delivery")}</span>
          <span className="t2">{t("project.deliveryApp")}</span>
          {gmail && (gmail.available
            ? <span className="t2">{gmail.destination ? t("project.gmailReadyTo", { destination: gmail.destination }) : t("project.gmailReady")}</span>
            : <span className="xs t3">{gmail.reason === "scope_missing" ? t("reason.channel.scope_missing") : t("reason.channel.not_connected")} · <Link to="/settings?section=fuentes">{gmail.reason === "scope_missing" ? t("panel.gmailAuthorize") : t("panel.gmailConnect")}</Link></span>)}
          {project.data?.remote_processing === false && <span className="hint">{t("project.remoteOff")}</span>}
        </div>

        {delegation && <>
          <hr className="divider" />
          <section className="section" style={{ gap: "var(--sp-3)" }}>
            <span className="label">{t("project.delegation")}</span>
            <Dl items={[
              { label: t("project.version"), value: String(delegation.version) },
              { label: t("project.approval"), value: delegation.approval_source === "owner_ui" ? t("project.approvalApp") : t("project.approvalAgent") },
              { label: t("project.approvedAt"), value: format.date(delegation.created_at, "datetime") },
              { label: t("project.coordinator"), value: t(`project.coordinatorState.${view.coordinator}`) },
              { label: t("project.digest"), value: <span className="mono xs" title={delegation.digest}>{delegation.digest.slice(0, 12)}</span> },
            ]} />
          </section>
        </>}
        </div>
      </PanelBody>
      {active
        ? <PanelFooter dirty={dirty} saving={save.isPending} warning={blocked && dirty} onDiscard={() => { setDraft(initial); setBlocked(false); setAttempted(false); setServer({}) }} onSave={submit} />
        : (
          <div className="panel-f">
            {blocked && dirty && <span className="xs" role="status" style={{ marginRight: "auto", color: "var(--warn)" }}>{tc("states.unsavedClose")}</span>}
            <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => { setDraft(initial); setBlocked(false); setAttempted(false); setServer({}) }}>{tc("actions.discard")}</Button>
            <Button disabled={save.isPending} onClick={submit}>{t("project.activate")}</Button>
          </div>
        )}
      <ConfirmDialog
        open={deactivating}
        title={t("project.deactivateTitle")}
        message={t("project.deactivateDetail")}
        confirmLabel={t("project.deactivate")}
        busy={save.isPending}
        onClose={() => setDeactivating(false)}
        onConfirm={deactivate}
      />
    </Panel>
  )
}
