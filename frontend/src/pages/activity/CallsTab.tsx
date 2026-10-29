import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  Button, Chip, Dl, Empty, EmptyFiltered, ErrorState, List, Panel, PanelBody, PanelHeader, Row, RowHead, SearchInput, Seg, Select,
  SkeletonRows, TabPanel,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { CALL_TONE, callResult, redact, redactText, type CallResult, type ToolCall } from "../../lib/activity"
import { useOverview } from "../../lib/local"
import type { LocalClient } from "../../lib/local"
import { useAuditEvents, useServers, useToolCalls } from "../../lib/queries"
import type { AuditEvent } from "../../lib/types"
import { Bar, CodeBox, Col, useDuration, useListTime } from "./shared"

type Registry = "calls" | "changes"
type Filter = "all" | "error" | "blocked"

const ALL = "all"
const LOCAL = "local"
const LIMIT = 200
const ROW_MIN = 640

const ACTIONS = ["policy.rule.set", "agent.enabled", "agent.disabled", "agent.detected", "machine.enroll", "machine.delete", "skill.imported", "skill.removed"] as const
const TARGETS = ["mcp_server", "mcp_tool", "skill", "agent_instance", "machine"] as const
type KnownAction = typeof ACTIONS[number]
/** i18next usa «.» como separador de claves: las acciones van con «_» en el diccionario. */
type ActionKey<A extends string> = A extends `${infer H}.${infer R}` ? `${H}_${ActionKey<R>}` : A
const actionKey = (action: KnownAction) => action.replace(/\./g, "_") as ActionKey<KnownAction>
type KnownTarget = typeof TARGETS[number]
const isAction = (value: string): value is KnownAction => (ACTIONS as readonly string[]).includes(value)
const isTarget = (value: string): value is KnownTarget => (TARGETS as readonly string[]).includes(value)

/** Nombre corto del objeto afectado, si el detalle lo trae. */
function targetName(event: AuditEvent): string {
  const detail = event.detail ?? {}
  for (const key of ["slug", "hostname", "name", "display_name"]) {
    const value = detail[key]
    if (typeof value === "string" && value) return value
  }
  return event.target_id ? event.target_id.slice(0, 8) : ""
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/** Llamadas · registro de lo que pasó por el gateway, más el registro encadenado de cambios de reglas. */
export default function CallsTab({ header }: { header: ReactNode }) {
  const { t } = useT("activity")
  const [registry, setRegistry] = useState<Registry>("calls")
  const [selected, setSelected] = useState<string | null>(null)
  const registrySelect = (
    <Select<Registry>
      label={t("registry.label")}
      value={registry}
      onChange={value => { setRegistry(value); setSelected(null) }}
      options={[{ value: "calls", label: t("registry.calls") }, { value: "changes", label: t("registry.changes") }]}
    />
  )
  return registry === "calls"
    ? <Calls header={header} registrySelect={registrySelect} selected={selected} onSelect={setSelected} />
    : <Changes header={header} registrySelect={registrySelect} selected={selected} onSelect={setSelected} />
}

interface RegistryProps { header: ReactNode; registrySelect: ReactNode; selected: string | null; onSelect: (id: string | null) => void }

function Calls({ header, registrySelect, selected, onSelect }: RegistryProps) {
  const { t } = useT("activity")
  const ts = useT("status").t
  const navigate = useNavigate()
  const calls = useToolCalls({ limit: LIMIT })
  const overview = useOverview()
  const servers = useServers()
  const listTime = useListTime()
  const duration = useDuration()
  const [filter, setFilter] = useState<Filter>("all")
  const [clientId, setClientId] = useState<string>(ALL)
  const [server, setServer] = useState<string>(ALL)

  const clients = useMemo(() => new Map((overview.data?.clients ?? []).map(client => [client.id, client])), [overview.data])
  const serverNames = useMemo(() => new Map((servers.data ?? []).map(item => [item.slug, item.display_name])), [servers.data])
  const all = useMemo(() => (calls.data ?? []) as ToolCall[], [calls.data])

  const clientName = (client: LocalClient | undefined) => {
    if (!client) return t("calls.client.local")
    const name = ts(`client.${client.cli_kind}`)
    const twins = [...clients.values()].filter(other => other.cli_kind === client.cli_kind).length
    return twins > 1 ? `${name} · ${client.machine_hostname}` : name
  }
  const clientKey = (call: ToolCall) => (call.agent_instance_id && clients.has(call.agent_instance_id) ? call.agent_instance_id : LOCAL)
  const serverName = (slug: string) => serverNames.get(slug) ?? slug

  const scoped = all.filter(call => (clientId === ALL || clientKey(call) === clientId) && (server === ALL || call.server_slug === server))
  const counts = { error: scoped.filter(call => callResult(call) === "error").length, blocked: scoped.filter(call => callResult(call) === "blocked").length }
  const visible = scoped.filter(call => filter === "all" || callResult(call) === filter)
  const current = all.find(call => call.id === selected) ?? null

  const clientOptions = [
    { value: ALL, label: t("calls.client.all") },
    ...[...new Set(all.map(clientKey))].map(key => ({ value: key, label: clientName(clients.get(key)) })),
  ]
  const serverOptions = useMemo(() => {
    const slugs = [...new Set(all.map(call => call.server_slug).filter(Boolean))]
    return [{ value: ALL, label: t("calls.server.all") }, ...slugs.map(slug => ({ value: slug, label: serverNames.get(slug) ?? slug }))]
  }, [all, serverNames, t])

  function clearFilters() {
    setFilter("all")
    setClientId(ALL)
    setServer(ALL)
  }

  let content: ReactNode
  if (calls.isPending) content = <SkeletonRows avatar={false} label={t("calls.loading")} />
  else if (calls.error) content = <List><ErrorState error={calls.error} title={t("calls.empty.errorTitle")} onRetry={() => void calls.refetch()} /></List>
  else if (all.length === 0) content = <List><Empty icon="activity" title={t("calls.empty.title")} detail={t("calls.empty.detail")} action={<Button small onClick={() => navigate("/clients")}>{t("calls.empty.action")}</Button>} /></List>
  else if (visible.length === 0) content = <List><EmptyFiltered text={t("calls.empty.filtered")} onClear={clearFilters} /></List>
  else content = (
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("calls.columns.tool")}</span>
        <Col width={130}>{t("calls.columns.client")}</Col>
        <Col width={120}>{t("calls.columns.result")}</Col>
        <Col width={72} right>{t("calls.columns.duration")}</Col>
        <Col width={64} right>{t("calls.columns.time")}</Col>
      </RowHead>
      {visible.map(call => {
        const result = callResult(call)
        const time = listTime(call.created_at)
        const tool = call.tool_name || call.exposed_name
        return (
          <Row
            key={call.id}
            style={{ minWidth: ROW_MIN }}
            selected={call.id === selected}
            onOpen={() => onSelect(call.id === selected ? null : call.id)}
            title={<span className="mono">{tool}</span>}
            titleText={tool}
            sub={serverName(call.server_slug)}
            meta={<>
              <Col width={130} className="xs t2 trunc">{clientName(clients.get(clientKey(call)))}</Col>
              <Col width={120}><Chip tone={CALL_TONE[result]}>{ts(`call.${result}`)}</Chip></Col>
              <Col width={72} right className="xs t3 num">{result === "blocked" ? "—" : duration(call.duration_ms)}</Col>
              <Col width={64} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
  )

  return (
    <div className="split">
      <div className="page">
        {header}
        <TabPanel idPrefix="activity" value="llamadas">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <Bar>
              {registrySelect}
              {all.length > 0 && <>
                <Seg<Filter>
                  label={t("calls.filter.label")}
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: t("calls.filter.all") },
                    { value: "error", label: t("calls.filter.error"), count: counts.error },
                    { value: "blocked", label: t("calls.filter.blocked"), count: counts.blocked },
                  ]}
                />
                <Select label={t("calls.client.label")} value={clientId} options={clientOptions} onChange={setClientId} />
                <Select label={t("calls.server.label")} value={server} options={serverOptions} onChange={setServer} />
              </>}
            </Bar>
            {content}
          </div>
        </TabPanel>
      </div>
      {current && (
        <CallPanel
          key={current.id}
          call={current}
          client={clientName(clients.get(clientKey(current)))}
          server={serverName(current.server_slug)}
          onClose={() => onSelect(null)}
        />
      )}
    </div>
  )
}

function CallPanel({ call, client, server, onClose }: { call: ToolCall; client: string; server: string; onClose: () => void }) {
  const { t } = useT("activity")
  const ts = useT("status").t
  const format = useFormat()
  const duration = useDuration()
  const result: CallResult = callResult(call)
  const tool = call.tool_name || call.exposed_name
  const technical = [
    { label: t("calls.panel.principal"), value: call.principal },
    { label: t("calls.panel.run"), value: call.run_id },
    { label: t("calls.panel.intent"), value: call.intent_id },
    { label: t("calls.panel.call"), value: call.call_id },
  ].filter(item => item.value)
  return (
    <Panel label={t("calls.panel.label")} onClose={onClose}>
      <PanelHeader title={<span className="mono">{tool}</span>} status={<Chip tone={CALL_TONE[result]}>{ts(`call.${result}`)}</Chip>} />
      <PanelBody>
        <Dl items={[
          { label: t("calls.panel.server"), value: server },
          { label: t("calls.panel.client"), value: client },
          { label: t("calls.panel.when"), value: format.date(call.created_at, "datetime") },
          { label: t("calls.panel.duration"), value: result === "blocked" ? null : duration(call.duration_ms) },
          { label: t("calls.panel.exposed"), value: call.exposed_name ? <span className="mono xs">{call.exposed_name}</span> : null },
        ]} />
        {result === "blocked" && (
          <div className="field">
            <span className="label">{t("calls.panel.blockReason")}</span>
            <CodeBox tone="locked">{redactText(call.denial_reason || "—")}</CodeBox>
          </div>
        )}
        {result === "error" && (
          <div className="field">
            <span className="label">{t("calls.panel.response")}</span>
            <CodeBox tone="danger">{redactText(call.error)}</CodeBox>
          </div>
        )}
        {result === "executed" && (
          <div className="field">
            <span className="label">{t("calls.panel.response")}</span>
            <span className="xs t3">{t("calls.panel.noResponse")}</span>
          </div>
        )}
        {technical.length > 0 && (
          <div className="field">
            <span className="label">{t("calls.panel.technical")}</span>
            <Dl items={technical.map(item => ({ label: item.label, value: <span className="mono xs" style={{ overflowWrap: "anywhere" }}>{redactText(String(item.value))}</span> }))} />
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}

/** Acciones y tipos conocidos se traducen; los demás se muestran tal cual, en mono. */
function useChangeLabels() {
  const { t } = useT("activity")
  return {
    action: (event: AuditEvent): ReactNode => (isAction(event.action) ? t(`changes.action.${actionKey(event.action)}`) : <span className="mono">{event.action}</span>),
    actionText: (event: AuditEvent): string => (isAction(event.action) ? t(`changes.action.${actionKey(event.action)}`) : event.action),
    target: (event: AuditEvent): string => (isTarget(event.target_type) ? t(`changes.target.${event.target_type}`) : event.target_type),
  }
}

function Changes({ header, registrySelect, selected, onSelect }: RegistryProps) {
  const { t } = useT("activity")
  const labels = useChangeLabels()
  const events = useAuditEvents({ limit: LIMIT })
  const listTime = useListTime()
  const [query, setQuery] = useState("")
  const all = events.data ?? []
  const needle = normalize(query.trim())
  const visible = needle ? all.filter(event => normalize(`${event.action} ${labels.actionText(event)} ${labels.target(event)} ${targetName(event)} ${event.actor_label}`).includes(needle)) : all
  const current = all.find(event => event.id === selected) ?? null

  let content: ReactNode
  if (events.isPending) content = <SkeletonRows avatar={false} label={t("changes.loading")} />
  else if (events.error) content = <List><ErrorState error={events.error} title={t("changes.empty.errorTitle")} onRetry={() => void events.refetch()} /></List>
  else if (all.length === 0) content = <List><Empty icon="activity" title={t("changes.empty.title")} detail={t("changes.empty.detail")} /></List>
  else if (visible.length === 0) content = <List><EmptyFiltered text={t("changes.empty.filtered", { query: query.trim() })} onClear={() => setQuery("")} /></List>
  else content = (
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("changes.columns.action")}</span>
        <Col width={180}>{t("changes.columns.actor")}</Col>
        <Col width={80} right>{t("changes.columns.time")}</Col>
      </RowHead>
      {visible.map(event => {
        const time = listTime(event.created_at)
        const actor = event.actor_label || t("changes.system")
        return (
          <Row
            key={event.id}
            style={{ minWidth: ROW_MIN }}
            selected={event.id === selected}
            onOpen={() => onSelect(event.id === selected ? null : event.id)}
            title={labels.action(event)}
            titleText={labels.actionText(event)}
            sub={event.target_type ? [labels.target(event), targetName(event)].filter(Boolean).join(" · ") : undefined}
            meta={<>
              <Col width={180} className="xs t2 trunc" title={actor}>{actor}</Col>
              <Col width={80} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
  )

  return (
    <div className="split">
      <div className="page">
        {header}
        <TabPanel idPrefix="activity" value="llamadas">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <Bar>
              {registrySelect}
              {all.length > 0 && <SearchInput label={t("changes.search")} value={query} onChange={event => setQuery(event.target.value)} />}
            </Bar>
            {content}
          </div>
        </TabPanel>
      </div>
      {current && <ChangePanel key={current.id} event={current} onClose={() => onSelect(null)} />}
    </div>
  )
}

function ChangePanel({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const { t } = useT("activity")
  const labels = useChangeLabels()
  const format = useFormat()
  const hasDetail = event.detail && Object.keys(event.detail).length > 0
  return (
    <Panel label={t("changes.panel.label")} onClose={onClose}>
      <PanelHeader title={labels.action(event)} />
      <PanelBody>
        <Dl items={[
          { label: t("changes.panel.action"), value: <span className="mono xs">{event.action}</span> },
          { label: t("changes.panel.actor"), value: event.actor_label || t("changes.system") },
          { label: t("changes.panel.when"), value: format.date(event.created_at, "datetime") },
          { label: t("changes.panel.target"), value: event.target_type ? <span>{labels.target(event)} <span className="mono xs t3" style={{ overflowWrap: "anywhere" }}>{event.target_id}</span></span> : null },
        ]} />
        <div className="field">
          <span className="label">{t("changes.panel.detail")}</span>
          {hasDetail ? <CodeBox>{JSON.stringify(redact(event.detail), null, 2)}</CodeBox> : <span className="xs t3">{t("changes.panel.noDetail")}</span>}
        </div>
      </PanelBody>
    </Panel>
  )
}
