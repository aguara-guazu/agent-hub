import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  Avatar, Badge, Banner, Button, Chip, Empty, EmptyFiltered, ErrorState, List, MoreMenu, Row, RowHead, SearchInput, Seg, Select,
  SkeletonRows, describeError, relativeTime, useToast, type MenuItem,
} from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { useMemory, type Page } from "../../lib/memory"
import { MemoryGate } from "../memory/shared"
import { AgentPanel } from "./AgentPanel"
import { CHANNEL_TONE, ChannelPanel, DELETE_REASON, channelKind } from "./ChannelPanel"
import { PlanPanel } from "./PlanPanel"
import { ThreadPanel } from "./ThreadPanel"
import { CHANNEL_PAGE, Pager, SCOPE, THREAD_PAGE, planState, useCollaborationParams, visibleAgents, type ListView, type ThreadState } from "./shared"
import type { Channel, Participant, Thread } from "./types"

const ALL = "all"

type Notice = { kind: "deleteUncertain"; channelId: string } | { kind: "designateUncertain" } | null

/** Colaboración · plantilla A con panel. Hilos entre agentes de canales sin proyecto; la persona observa y administra. */
export default function CollaborationPage() {
  const { t, plural } = useT("collaboration")
  const toast = useToast()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const params = useCollaborationParams()
  const { view, state, channel, agent, query, thread, plan, inspect, offset, messageOffset, channelOffset, agentOffset, patch } = params
  const [notice, setNotice] = useState<Notice>(null)

  const channelFilter = view === "threads" ? channel : ""
  const threadInput = { ...SCOPE, ...(channelFilter ? { channel_id: channelFilter } : {}), query, ...(agent ? { author_id: agent } : {}) }
  const threads = useMemory<Page<Thread>>("chat_threads", { ...threadInput, state, limit: THREAD_PAGE, offset }, view === "threads")
  const otherState: ThreadState = state === "open" ? "resolved" : "open"
  const otherCount = useMemory<Page<Thread>>("chat_threads", { ...threadInput, state: otherState, limit: 1, offset: 0 }, view === "threads")
  const channels = useMemory<Page<Channel>>("chat_channels", { ...SCOPE, limit: CHANNEL_PAGE, offset: view === "threads" ? 0 : channelOffset, ...(view === "trash" ? { deleted: true } : {}) })
  const lookup = useMemory<Page<Channel>>("chat_channels", { ...SCOPE, channel_id: channel }, Boolean(channel) && Boolean(channels.data) && !channels.data!.items.some(item => item.id === channel))
  const agents = useMemory<Page<Participant>>("chat_agents", { ...SCOPE, include_team_history: true, limit: 100, offset: 0 })

  const restore = useMutation({
    mutationFn: (channel_id: string) => api.post("/memory/chat/channels/restore", { channel_id }),
    onSuccess: (_, id) => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      const name = channels.data?.items.find(item => item.id === id)?.name ?? ""
      toast.success(t("toast.restored", { name }))
    },
    onError: error => toast.error(t("toast.restoreFailed"), describeError(error)),
  })

  // Volver a borrar un canal ya en la papelera repite la detención de sus trabajadores (mismo pedido que el original).
  const retryStop = useMutation({
    mutationFn: (channel_id: string) => api.post<{ uncertain_members?: string[] }>("/memory/chat/channels/delete", { channel_id, reason: DELETE_REASON }),
    onSuccess: result => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      if (!result?.uncertain_members?.length) { setNotice(null); toast.success(t("toast.stopped")) }
    },
    onError: error => toast.error(t("toast.stopFailed"), describeError(error)),
  })

  const allAgents = visibleAgents(agents.data?.items)
  const connected = allAgents.filter(item => item.connection_state === "online" && !item.closed_at).length
  const selectedChannel = channels.data?.items.find(item => item.id === channel) ?? lookup.data?.items[0]
  const inspected = inspect ? (allAgents.find(item => item.id === inspect) ?? agents.data?.items.find(item => item.id === inspect)) : undefined
  const pendingPlans = (threads.data?.items ?? []).filter(item => item.team_plan_id && !item.team_root_thread_id && planState(item.team_plan_state) === "prepared")

  const openThread = (id: string) => patch({ thread: id, moffset: 0, plan: null, inspect: null })
  const openPlan = (id: string) => patch({ plan: id, inspect: null })
  const showView = (next: ListView) => patch({ view: next === "threads" ? null : next, channel: null, coffset: 0, aoffset: 0, thread: null, plan: null, inspect: null })
  const showThreads = (channelId: string, agentId?: string) => patch({ view: null, channel: channelId, agent: agentId ?? null, offset: 0, thread: null, plan: null, inspect: null })
  const clearFilters = () => patch({ channel: null, agent: null, q: null, offset: 0 })
  const filtered = Boolean(channelFilter || agent || query)

  const menu: MenuItem[] = []
  if (view !== "threads") menu.push({ label: t("menu.threads"), onSelect: () => showView("threads") })
  if (view !== "channels") menu.push({ label: t("menu.channels"), onSelect: () => showView("channels") })
  if (view === "threads" && channelFilter) menu.push({ label: t("menu.thisChannel"), onSelect: () => patch({ view: "channels", channel: channelFilter, aoffset: 0, thread: null, plan: null, inspect: null }) })
  if (view !== "trash") menu.push({ label: t("menu.trash"), onSelect: () => showView("trash") })

  const banner = notice?.kind === "deleteUncertain"
    ? <Banner tone="warn" action={<Button small disabled={retryStop.isPending} onClick={() => retryStop.mutate(notice.channelId)}>{t("actions.retryStop")}</Button>}>{t("banner.deleteUncertain")}</Banner>
    : notice?.kind === "designateUncertain"
      ? <Banner tone="warn" action={<Button small onClick={() => setNotice(null)}>{t("actions.dismiss")}</Button>}>{t("banner.designateUncertain")}</Banner>
      : view === "threads" && pendingPlans.length > 0
        ? <Banner tone="warn" action={<Button small onClick={() => openPlan(pendingPlans[0]!.team_plan_id!)}>{t("actions.reviewTeam")}</Button>}>{plural("banner.pendingPlans", pendingPlans.length)}</Banner>
        : null

  function renderThreads() {
    if (threads.isPending) return <SkeletonRows label={t("loading.threads")} />
    if (threads.error) return <List><ErrorState error={threads.error} title={t("error.threads")} onRetry={() => void threads.refetch()} /></List>
    const items = threads.data!.items
    if (items.length === 0) {
      if (filtered) return <List><EmptyFiltered text={query ? t("empty.filteredQuery", { query }) : t("empty.filtered")} onClear={clearFilters} /></List>
      if (state === "resolved") return <List><Empty icon="collaboration" title={t("empty.noClosed")} action={<Button small onClick={() => patch({ state: null, offset: 0 })}>{t("actions.seeOpen")}</Button>} /></List>
      return <List><Empty icon="collaboration" title={t("empty.title")} detail={t("empty.detail")} action={<Button small onClick={() => navigate("/clients")}>{t("actions.seeClients")}</Button>} /></List>
    }
    return <>
      <List>
        {items.map(item => {
          const pending = item.pending_responses ?? 0
          const prepared = Boolean(item.team_plan_id) && !item.team_root_thread_id && planState(item.team_plan_state) === "prepared"
          return (
            <Row
              key={item.id}
              selected={item.id === thread}
              onOpen={() => openThread(item.id)}
              lead={<Avatar name={item.author_label} small round />}
              title={item.title}
              sub={`#${item.channel_name} · ${item.participants || item.author_label}`}
              meta={<>
                {prepared
                  ? <Chip tone="warn">{t("row.planPending")}</Chip>
                  : pending > 0 && <Chip tone="warn" title={item.awaiting_labels ? t("row.awaiting", { names: item.awaiting_labels }) : undefined}>{plural("row.pending", pending)}</Chip>}
                <Badge count={item.messages} label={plural("row.messages", item.messages)} />
                <span title={item.updated_at}>{relativeTime(item.updated_at)}</span>
              </>}
            />
          )
        })}
      </List>
      <Pager total={threads.data!.total} offset={offset} limit={THREAD_PAGE} onChange={value => patch({ offset: value })} />
    </>
  }

  function renderChannels() {
    const trash = view === "trash"
    if (channels.isPending) return <SkeletonRows label={t("loading.channels")} />
    if (channels.error) return <List><ErrorState error={channels.error} title={t("error.channels")} onRetry={() => void channels.refetch()} /></List>
    const items = channels.data!.items
    if (items.length === 0) {
      return trash
        ? <List><Empty icon="collaboration" title={t("empty.trash")} action={<Button small onClick={() => showView("channels")}>{t("menu.channels")}</Button>} /></List>
        : <List><Empty icon="collaboration" title={t("empty.channels")} detail={t("empty.channelsDetail")} action={<Button small onClick={() => navigate("/clients")}>{t("actions.seeClients")}</Button>} /></List>
    }
    return <>
      <List>
        <RowHead>{trash ? t("list.trash") : t("list.channels")}</RowHead>
        {items.map(item => {
          const kind = channelKind(item)
          return trash
            ? (
              <Row
                key={item.id}
                lead={<Avatar name={item.name} small />}
                title={`#${item.name}`}
                sub={item.path}
                meta={<span title={item.deleted_at ?? undefined}>{relativeTime(item.deleted_at)}</span>}
                action={<Button small disabled={restore.isPending} onClick={() => restore.mutate(item.id)}>{t("actions.restore")}</Button>}
              />
            )
            : (
              <Row
                key={item.id}
                selected={item.id === channel}
                onOpen={() => patch({ channel: item.id, aoffset: 0, thread: null, plan: null, inspect: null })}
                lead={<Avatar name={item.name} small />}
                title={`#${item.name}`}
                sub={item.path}
                meta={<>
                  <Chip tone={CHANNEL_TONE[kind]}>{t(`channelKind.${kind}`)}</Chip>
                  <span>{plural("row.threads", item.threads)}</span>
                </>}
              />
            )
        })}
      </List>
      <Pager total={channels.data!.total} offset={channelOffset} limit={CHANNEL_PAGE} onChange={value => patch({ coffset: value })} />
    </>
  }

  const channelOptions = [{ value: ALL, label: t("filter.allChannels") }, ...(channels.data?.items ?? []).map(item => ({ value: item.id, label: `#${item.name}` }))]
  if (channelFilter && !channelOptions.some(option => option.value === channelFilter) && selectedChannel) channelOptions.push({ value: selectedChannel.id, label: `#${selectedChannel.name}` })
  const agentOptions = [{ value: ALL, label: t("filter.allAgents") }, ...allAgents.map(item => ({ value: item.id, label: item.label, avatar: item.label, round: true }))]
  const threadCount = (value: ThreadState) => (value === state ? threads.data?.total : otherCount.data?.total)

  let panel = null
  if (plan) panel = <PlanPanel key={plan} planId={plan} onThread={openThread} onClose={() => patch({ plan: null })} />
  else if (inspect) {
    panel = <AgentPanel
      key={inspect}
      agent={{ id: inspect, label: inspected?.label ?? t("agent.unknown") }}
      onClose={() => patch({ inspect: null })}
      onThreads={() => showThreads(inspected?.master_channel_id ?? inspected?.channel_id ?? "", inspect)}
    />
  } else if (thread) {
    panel = <ThreadPanel
      key={thread}
      threadId={thread}
      messageOffset={messageOffset}
      onMessageOffset={value => patch({ moffset: value })}
      onOpenPlan={openPlan}
      onClose={() => patch({ thread: null, moffset: 0 })}
    />
  } else if (view === "channels" && selectedChannel) {
    panel = <ChannelPanel
      key={selectedChannel.id}
      channel={selectedChannel}
      agentOffset={agentOffset}
      onAgentOffset={value => patch({ aoffset: value })}
      onThreads={showThreads}
      onThread={openThread}
      onPlan={openPlan}
      onChannel={id => patch({ channel: id, aoffset: 0 })}
      onInspect={item => patch({ inspect: item.id })}
      onDeleted={(deleted, uncertain) => {
        patch({ channel: null, aoffset: 0 })
        if (uncertain) setNotice({ kind: "deleteUncertain", channelId: deleted.id })
        else toast.success(t("toast.deleted", { name: deleted.name }))
      }}
      onDesignated={uncertain => { if (uncertain) setNotice({ kind: "designateUncertain" }); else toast.success(t("toast.designated")) }}
      onClose={() => patch({ channel: null, aoffset: 0 })}
    />
  }

  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
          <div className="ph-actions">
            {agents.data && <Chip tone={connected > 0 ? "ok" : "off"}>{connected > 0 ? plural("connected", connected) : t("noneConnected")}</Chip>}
            <MoreMenu items={menu} />
          </div>
        </div>
        <MemoryGate>
          {banner}
          {view === "threads" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
              <Seg<ThreadState>
                label={t("filter.state")}
                value={state}
                onChange={value => patch({ state: value === "open" ? null : value, offset: 0 })}
                options={[
                  { value: "open", label: t("filter.open"), count: threadCount("open") },
                  { value: "resolved", label: t("filter.closed"), count: threadCount("resolved") },
                ]}
              />
              <Select label={t("filter.channel")} value={channelFilter || ALL} options={channelOptions} onChange={value => patch({ channel: value === ALL ? null : value, offset: 0 })} />
              {allAgents.length > 0 && <Select label={t("filter.agent")} value={agent || ALL} options={agentOptions} onChange={value => patch({ agent: value === ALL ? null : value, offset: 0 })} />}
              <SearchInput label={t("filter.search")} value={query} onChange={event => patch({ q: event.target.value, offset: 0 })} />
            </div>
          )}
          {view === "threads" ? renderThreads() : renderChannels()}
        </MemoryGate>
      </div>
      {panel}
    </div>
  )
}
