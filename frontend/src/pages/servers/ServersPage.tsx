import { useCallback, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  Avatar, Banner, Button, Chip, Empty, EmptyFiltered, ErrorState, List, MoreMenu, Row, RowHead, SearchInput, Seg, Select,
  SkeletonRows, Switch, useToast,
} from "../../components/ui"
import { useT } from "../../i18n/useT"
import { useOverview } from "../../lib/local"
import type { LocalClient } from "../../lib/local"
import { useServers } from "../../lib/queries"
import {
  STATUS_TONE, deleteServer, needsAttention, needsAuth, probeServer, rowEnabled, serverStatus, snapshotRules,
  useRuleWrite, useServersCache,
} from "../../lib/servers"
import type { RuleWrite, ServerStatus } from "../../lib/servers"
import type { MatrixRow, McpServer } from "../../lib/types"
import { ImportDialog } from "./ImportDialog"
import { NewServerDialog } from "./NewServerDialog"
import { ServerPanel } from "./ServerPanel"
import { useFailDetail } from "./shared"

type Filter = "all" | "attention" | "off"

const ALL_CLIENTS = "all"

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

function matches(server: McpServer, needle: string): boolean {
  if (!needle) return true
  const text = normalize(`${server.display_name} ${server.slug} ${server.description} ${server.tools.map(tool => tool.name).join(" ")}`)
  return text.includes(needle)
}

function clientLabel(client: LocalClient, clients: readonly LocalClient[], name: string): string {
  return clients.filter(other => other.cli_kind === client.cli_kind).length > 1 ? `${name} · ${client.machine_hostname}` : name
}

/** Servidores MCP · plantilla A con panel. El selector «Cliente» es la vista de matriz: el interruptor de cada fila
 *  escribe la regla de ese cliente, o la de todos cuando no hay uno elegido. */
export default function ServersPage() {
  const { t, plural } = useT("servers")
  const status = useT("status").t
  const toast = useToast()
  const failDetail = useFailDetail()
  const refresh = useServersCache()
  const rules = useRuleWrite()
  const servers = useServers()
  const overview = useOverview()
  const [params, setParams] = useSearchParams()

  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [clientId, setClientId] = useState<string>(ALL_CLIENTS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [panelDirty, setPanelDirty] = useState(false)
  const [blockedSignal, setBlockedSignal] = useState(0)

  const creating = params.get("new") === "server"
  const setCreating = useCallback((open: boolean) => {
    setParams(current => {
      const next = new URLSearchParams(current)
      if (open) next.set("new", "server")
      else next.delete("new")
      return next
    }, { replace: true })
  }, [setParams])

  const clients = useMemo(() => overview.data?.clients ?? [], [overview.data])
  const client = clients.find(item => item.id === clientId)
  const scopedClient = client?.id
  const rows = useMemo(() => {
    const servers = new Map<string, MatrixRow>()
    const tools = new Map<string, MatrixRow>()
    for (const row of overview.data?.rows ?? []) {
      if (row.resource_type === "mcp_server") servers.set(row.resource_id, row)
      else if (row.resource_type === "mcp_tool") tools.set(row.resource_id, row)
    }
    return { servers, tools }
  }, [overview.data])

  const all = useMemo(() => (servers.data ?? []).filter(server => !hidden.has(server.id)), [servers.data, hidden])
  const statuses = useMemo(() => new Map<string, ServerStatus>(all.map(server => [server.id, serverStatus(server, rows.servers.get(server.id), scopedClient)])), [all, rows, scopedClient])
  const attention = all.filter(server => needsAttention(statuses.get(server.id)!))
  const off = all.filter(server => statuses.get(server.id) === "off")
  const needle = normalize(query.trim())
  const visible = all.filter(server => {
    const state = statuses.get(server.id)!
    if (filter === "attention" && !needsAttention(state)) return false
    if (filter === "off" && state !== "off") return false
    return matches(server, needle)
  })
  const selected = all.find(server => server.id === selectedId) ?? null
  const authCount = attention.filter(needsAuth).length

  const open = (id: string | null) => {
    if (panelDirty && id !== selectedId) { setBlockedSignal(value => value + 1); return }
    setSelectedId(id)
  }

  function clearFilters() {
    setFilter("all")
    setQuery("")
    setClientId(ALL_CLIENTS)
  }

  function toggle(server: McpServer, enabled: boolean) {
    const row = rows.servers.get(server.id)
    // Deshacer reescribe solo lo que la escritura pisó: la regla de ese cliente, o todas si fue global.
    const undo: RuleWrite[] = scopedClient
      ? [{ type: "mcp_server", id: server.id, client: scopedClient, state: row?.cells[scopedClient]?.own_rule ?? "inherit" }]
      : snapshotRules(row, "mcp_server", server.id)
    const write: RuleWrite = { type: "mcp_server", id: server.id, state: enabled ? "on" : "off", client: scopedClient }
    const clientName = client ? clientLabel(client, clients, status(`client.${client.cli_kind}`)) : ""
    const message = client
      ? t(enabled ? "toast.turnedOnFor" : "toast.turnedOffFor", { name: server.display_name, client: clientName })
      : t(enabled ? "toast.turnedOn" : "toast.turnedOff", { name: server.display_name })
    rules.mutate([write], {
      onSuccess: () => toast.show({
        message,
        undo: () => rules.mutate(undo, {
          onError: error => toast.error(t("toast.ruleFailed"), failDetail(error)),
        }),
      }),
      onError: error => toast.error(t("toast.ruleFailed"), failDetail(error)),
    })
  }

  /** La API borra en el acto; el DELETE se difiere hasta que vence el aviso para que «Deshacer» no pierda nada. */
  function remove(server: McpServer) {
    setHidden(current => new Set(current).add(server.id))
    setPanelDirty(false)
    setSelectedId(current => (current === server.id ? null : current))
    const unhide = () => setHidden(current => { const next = new Set(current); next.delete(server.id); return next })
    toast.show({
      message: t("toast.deleted", { name: server.display_name }),
      undo: unhide,
      onCommit: () => {
        deleteServer(server.id)
          .then(refresh)
          .catch(error => { unhide(); toast.error(t("toast.deleteFailed", { name: server.display_name }), failDetail(error)) })
      },
    })
  }

  async function created(server: McpServer) {
    setCreating(false)
    setFilter("all")
    setSelectedId(server.id)
    await refresh()
    const probed = await probeServer(server.id).catch(() => null)
    await refresh()
    if (probed && !probed.last_probe_error) toast.success(t("toast.added", { name: server.display_name }), plural("toast.toolsReady", probed.tools.length))
    else toast.error(t("toast.notConnected", { name: server.display_name }), probed?.last_probe_error)
  }

  const loading = servers.isPending || (overview.isPending && !overview.data)
  const loadError = servers.error ?? overview.error
  const clientOptions = [
    { value: ALL_CLIENTS, label: t("client.all") },
    ...clients.map(item => ({ value: item.id, label: clientLabel(item, clients, status(`client.${item.cli_kind}`)) })),
  ]

  let content
  if (loading) content = <SkeletonRows label={t("loading")} />
  else if (loadError) content = <List><ErrorState error={loadError} title={t("empty.errorTitle")} onRetry={() => { void servers.refetch(); void overview.refetch() }} /></List>
  else if (all.length === 0) content = <List><Empty icon="servers" title={t("empty.title")} detail={t("empty.detail")} action={<Button small variant="primary" icon="add" onClick={() => setCreating(true)}>{t("actions.add")}</Button>} /></List>
  else if (visible.length === 0) content = <List><EmptyFiltered text={query.trim() ? t("empty.filteredQuery", { query: query.trim() }) : t("empty.filtered")} onClear={clearFilters} /></List>
  else content = (
    <List className="scroll-x">
      <RowHead style={{ minWidth: 600 }}>
        <span style={{ flex: 1 }}>{t("columns.server")}</span>
        <span className="col" style={{ width: 100 }}>{t("columns.tools")}</span>
        <span className="col" style={{ width: 170 }}>{t("columns.status")}</span>
        <span className="col" style={{ width: 40 }} />
      </RowHead>
      {visible.map(server => {
        const row = rows.servers.get(server.id)
        const state = statuses.get(server.id)!
        const enabled = rowEnabled(row, scopedClient)
        const paused = Boolean(client && !client.enabled)
        const transport = status(`transport.${server.transport}`)
        return (
          <Row
            key={server.id}
            style={{ minWidth: 600 }}
            selected={server.id === selectedId}
            onOpen={() => open(server.id)}
            lead={<Avatar name={server.display_name} />}
            title={server.display_name}
            sub={server.description ? `${server.description} · ${transport}` : transport}
            meta={<>
              <span className={`col num xs ${server.tools.length ? "t2" : "t3"}`} style={{ width: 100 }}>{server.tools.length || "—"}</span>
              <span className="col" style={{ width: 170 }}><Chip tone={STATUS_TONE[state]}>{t(`status.${state}`)}</Chip></span>
            </>}
            action={<span className="col" style={{ width: 40, display: "flex", justifyContent: "flex-end" }}>
              <Switch
                checked={enabled}
                disabled={rules.isPending || paused}
                label={client ? t("row.switchClient", { name: server.display_name, client: clientOptions.find(option => option.value === client.id)?.label }) : t("row.switchAll", { name: server.display_name })}
                onChange={value => toggle(server, value)}
              />
            </span>}
          />
        )
      })}
    </List>
  )

  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
          <div className="ph-actions">
            <Button variant="primary" icon="add" onClick={() => setCreating(true)}>{t("actions.add")}</Button>
            <MoreMenu label={t("actions.more")} items={[{ label: t("actions.importJson"), onSelect: () => setImporting(true) }]} />
          </div>
        </div>

        {attention.length > 0 && (
          <Banner
            tone="warn"
            action={filter !== "attention" ? <Button small onClick={() => setFilter("attention")}>{t("actions.seeWhich")}</Button> : undefined}
          >
            {authCount === attention.length ? plural("banner.auth", authCount) : plural("banner.mixed", attention.length)}
          </Banner>
        )}

        {all.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
            <Seg<Filter>
              label={t("filter.label")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("filter.all"), count: all.length },
                { value: "attention", label: t("filter.attention"), count: attention.length },
                { value: "off", label: t("filter.off"), count: off.length },
              ]}
            />
            <SearchInput label={t("search")} value={query} onChange={event => setQuery(event.target.value)} />
            {clients.length > 0 && <Select label={t("client.label")} value={clientId} options={clientOptions} onChange={setClientId} />}
          </div>
        )}

        {content}
      </div>

      {selected && (
        <ServerPanel
          key={selected.id}
          server={selected}
          row={rows.servers.get(selected.id)}
          toolRows={rows.tools}
          clients={clients}
          onClose={() => { setPanelDirty(false); setSelectedId(null) }}
          onDelete={remove}
          onDirtyChange={setPanelDirty}
          blockedSignal={blockedSignal}
        />
      )}

      <NewServerDialog open={creating} onClose={() => setCreating(false)} onCreated={server => void created(server)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  )
}
