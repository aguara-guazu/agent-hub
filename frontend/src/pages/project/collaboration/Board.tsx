import { useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Avatar, Banner, Button, Empty, ErrorState, Icon, MoreMenu, Seg, SkeletonRows, cx, useToast, type MenuItem } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory, type MemoryEntity, type Page } from "../../../lib/memory"
import { AgentPanel } from "./AgentPanel"
import { ChannelPanel, DeleteChannelDialog } from "./ChannelPanel"
import { PlanPanel } from "./PlanPanel"
import { agentInitials, visibleAgents } from "./chatShared"
import type { Participant } from "./chatTypes"
import { SidePanel, useWorkPanel } from "../work"
import { useBoardParams, type BoardChannel, type BoardThread, type ThreadState } from "./collabData"
import { TrashPanel } from "./BoardPanels"
import { ThreadView } from "./ThreadView"
import { InterhubAgents } from "./InterhubAgents"
import { isInterhub, useInterhubRoster } from "./interhubData"

const CHANNEL_LIMIT = 100
const THREAD_PAGE = 30
const HEAD_AGENTS = 4

type Notice = "deleteUncertain" | "designateUncertain" | null

/** Colaboración del proyecto en tres columnas: canales › hilos del canal › debate del hilo. */
export function CollaborationBoard({ project }: { project: MemoryEntity }) {
  const { t } = useT("project")
  const toast = useToast()
  const params = useBoardParams()
  const [notice, setNotice] = useState<Notice>(null)
  const [agentOffset, setAgentOffset] = useState(0)
  const agentsPanel = useWorkPanel("agents")
  const agentPanel = useWorkPanel("agent")
  const planPanel = useWorkPanel("plan")
  const trashPanel = useWorkPanel("trash")

  const channels = useMemory<Page<BoardChannel>>("chat_channels", { project_id: project.id, limit: CHANNEL_LIMIT, offset: 0 })
  const all = channels.data?.items ?? []
  // Locales primero y compartidos entre hubs después, como se ven en la columna.
  const local = all.filter(item => !isInterhub(item))
  const shared = all.filter(isInterhub)
  const items = [...local, ...shared]
  const channel = items.find(item => item.id === params.channel) ?? items[0]

  const selectChannel = (id: string) => params.patch({ channel: id, thread: null, tstate: null })
  const openThread = (threadId: string, channelId?: string) => params.patch({ thread: threadId, ...(channelId ? { channel: channelId } : {}) })

  let panel = null
  if (trashPanel.value) {
    panel = <TrashPanel projectId={project.id} onClose={trashPanel.close} />
  } else if (planPanel.value) {
    panel = <PlanPanel key={planPanel.value} planId={planPanel.value} onThread={(id, channelId) => { planPanel.close(); openThread(id, channelId) }} onClose={planPanel.close} />
  } else if (agentPanel.value) {
    panel = <AgentPanelLoader projectId={project.id} agentId={agentPanel.value} onClose={agentPanel.close} />
  } else if (agentsPanel.value) {
    const target = items.find(item => item.id === agentsPanel.value)
    if (target) {
      panel = <ChannelPanel
        key={target.id}
        channel={target}
        projectId={project.id}
        agentOffset={agentOffset}
        onAgentOffset={setAgentOffset}
        onThreads={id => { agentsPanel.close(); selectChannel(id) }}
        onThread={(id, channelId) => { agentsPanel.close(); openThread(id, channelId) }}
        onPlan={id => planPanel.open(id)}
        onChannel={id => { setAgentOffset(0); agentsPanel.open(id) }}
        onInspect={agent => agentPanel.open(agent.id)}
        onDesignated={uncertain => { if (uncertain) setNotice("designateUncertain"); else toast.success(t("collaboration.board.designated")) }}
        onClose={agentsPanel.close}
      />
    }
  }

  const banner = notice && (
    <Banner tone="warn" action={<Button small onClick={() => setNotice(null)}>{t("collaboration.board.dismiss")}</Button>}>
      {t(notice === "deleteUncertain" ? "collaboration.board.deleteUncertain" : "collaboration.board.designateUncertain")}
    </Banner>
  )

  return (
    <section className="section fill" aria-label={t("collaboration.board.label")}>
      {banner}
      <div className="collab">
        <nav className="collab-chans" aria-label={t("collaboration.board.channels")}>
          <div className="nav-group">{t("collaboration.board.channels")}</div>
          {channels.isPending ? <SkeletonRows count={3} avatar={false} label={t("collaboration.board.loadingChannels")} />
            : channels.error ? <ErrorState error={channels.error} title={t("collaboration.board.channelsError")} onRetry={() => void channels.refetch()} />
            : <>
              {local.map(item => <ChannelLink key={item.id} item={item} active={item.id === channel?.id} href={params.href({ channel: item.id, thread: null, tstate: null })} />)}
              {shared.length > 0 && <div className="nav-group">{t("collaboration.interhub.group")}</div>}
              {shared.map(item => <ChannelLink key={item.id} item={item} active={item.id === channel?.id} href={params.href({ channel: item.id, thread: null, tstate: null })} />)}
            </>}
        </nav>

        {channels.data && !channel
          ? (
            <section className="collab-threads" aria-label={t("collaboration.board.threads")} style={{ borderRight: 0 }}>
              <Empty
                icon="collaboration"
                title={t("collaboration.board.noChannelsTitle")}
                detail={t("collaboration.board.noChannelsDetail")}
                action={<Button small onClick={() => trashPanel.open()}>{t("collaboration.board.trash")}</Button>}
              />
            </section>
          )
          : channel
            ? <ChannelColumns
                key={channel.id}
                projectId={project.id}
                channel={channel}
                state={params.state}
                threadId={params.thread}
                onState={state => params.patch({ tstate: state === "open" ? null : state, thread: null })}
                onThread={id => openThread(id)}
                onCloseThread={() => params.patch({ thread: null })}
                onAgents={() => { setAgentOffset(0); agentsPanel.open(channel.id) }}
                onPlan={id => planPanel.open(id)}
                onTrash={() => trashPanel.open()}
                onDeleted={uncertain => {
                  params.patch({ channel: null, thread: null, tstate: null })
                  if (uncertain) setNotice("deleteUncertain")
                  else toast.success(t("collaboration.board.deleted", { name: channel.name }))
                }}
              />
            : <section className="collab-threads"><SkeletonRows count={2} avatar={false} /></section>}
      </div>
      {panel && <SidePanel>{panel}</SidePanel>}
    </section>
  )
}

function ChannelLink({ item, active, href }: { item: BoardChannel; active: boolean; href: string }) {
  return (
    <Link replace className={cx("nav-item", active && "is-active")} aria-current={active ? "page" : undefined} to={href}>
      {isInterhub(item) ? <Icon name="interhub" small /> : <span className="chan-hash" aria-hidden="true">#</span>}
      <span className="trunc">{item.name}</span>
    </Link>
  )
}

function AgentPanelLoader({ projectId, agentId, onClose }: { projectId: string; agentId: string; onClose: () => void }) {
  const agents = useMemory<Page<Participant>>("chat_agents", { project_id: projectId, include_team_history: true, limit: 100, offset: 0 })
  const agent = agents.data?.items.find(item => item.id === agentId)
  return <AgentPanel key={agentId} agentId={agentId} agent={agent} onClose={onClose} onThreads={onClose} />
}

interface ChannelColumnsProps {
  projectId: string
  channel: BoardChannel
  state: ThreadState
  threadId: string
  onState: (state: ThreadState) => void
  onThread: (id: string) => void
  onCloseThread: () => void
  onAgents: () => void
  onPlan: (id: string) => void
  onTrash: () => void
  onDeleted: (uncertain: boolean) => void
}

function ChannelColumns({ projectId, channel, state, threadId, onState, onThread, onCloseThread, onAgents, onPlan, onTrash, onDeleted }: ChannelColumnsProps) {
  const { t, plural } = useT("project")
  const common = useT("common").t
  const format = useFormat()
  const [limit, setLimit] = useState(THREAD_PAGE)
  const [deleting, setDeleting] = useState(false)
  const scope = { project_id: projectId, channel_id: channel.id }
  const threads = useMemory<Page<BoardThread>>("chat_threads", { ...scope, query: "", state, limit, offset: 0 })
  const other = useMemory<Page<BoardThread>>("chat_threads", { ...scope, query: "", state: state === "open" ? "resolved" : "open", limit: 1, offset: 0 })
  const shared = isInterhub(channel)
  // En un canal compartido los agentes vienen agrupados por hub (roster); chat_agents solo conoce los locales.
  const agents = useMemory<Page<Participant>>("chat_agents", { ...scope, include_team_history: true, limit: 100, offset: 0 }, !shared)
  const roster = useInterhubRoster(channel.id, shared)
  const visible = visibleAgents(agents.data?.items)
  const list = threads.data?.items ?? []
  const selected = list.find(item => item.id === threadId)?.id ?? threadId
  const count = (value: ThreadState) => (value === state ? threads.data?.total : other.data?.total)

  // Las acciones de recuperación son de canales locales: un canal compartido no las expone.
  const menu: MenuItem[] = [{ label: t("collaboration.board.channelAgents"), onSelect: onAgents }]
  if (channel.team_plan_id) menu.push({ label: t("collaboration.board.viewTeam"), onSelect: () => onPlan(channel.team_plan_id!) })
  menu.push({ label: t("collaboration.board.trash"), onSelect: onTrash })
  menu.push({ label: t("collaboration.board.deleteChannel"), danger: true, onSelect: () => setDeleting(true) })
  const hubCount = roster.data?.hub_count ?? channel.hub_count

  // Al cerrar la columna (botón X o volver a tocar el hilo) el foco vuelve a la fila del hilo.
  const rows = useRef(new Map<string, HTMLDivElement>())
  function closeThread() {
    const id = selected
    onCloseThread()
    requestAnimationFrame(() => rows.current.get(id)?.focus())
  }

  function sub(thread: BoardThread) {
    return [
      shared && thread.hub_count !== undefined ? plural("collaboration.interhub.hubs", thread.hub_count) : null,
      thread.agent_count !== undefined ? plural("collaboration.board.agents", thread.agent_count) : null,
      plural("collaboration.board.messages", Number(thread.messages)),
      format.relative(thread.updated_at),
    ].filter(Boolean).join(" · ")
  }

  return <>
    <section className="collab-threads" aria-label={t("collaboration.board.threadsOf", { name: channel.name })}>
      <div className="collab-head">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", minWidth: 0 }}>
          <div className="row-main">
            <h2 className="h2 trunc" title={channel.name}>
              {shared ? <Icon name="interhub" /> : <span className="chan-hash" aria-hidden="true">#</span>} {channel.name}
            </h2>
            {shared
              ? <span className="row-sub">{hubCount !== undefined ? plural("collaboration.interhub.sharedBetween", hubCount) : t("collaboration.interhub.shared")}</span>
              : channel.description && <span className="row-sub" title={channel.description}>{channel.description}</span>}
          </div>
          {!shared && visible.length > 0 && (
            <button
              type="button"
              onClick={onAgents}
              aria-label={plural("collaboration.board.agentsButton", visible.length)}
              title={visible.map(agent => agent.label).join(", ")}
              style={{ display: "flex", background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
            >
              {visible.slice(0, HEAD_AGENTS).map((agent, index) => (
                <span key={agent.id} style={{ display: "flex", marginLeft: index ? "calc(var(--sp-1) * -1)" : 0, borderRadius: "var(--r-sm)", boxShadow: "0 0 0 2px var(--surface)" }}>
                  <Avatar name={agent.label} text={agentInitials(agent.label, agent.cli_kind)} small />
                </span>
              ))}
              {visible.length > HEAD_AGENTS && <span className="xs t3" style={{ alignSelf: "center", marginLeft: "var(--sp-1)" }}>+{visible.length - HEAD_AGENTS}</span>}
            </button>
          )}
          {!shared && <MoreMenu small ghost label={t("collaboration.board.channelActions", { name: channel.name })} items={menu} />}
        </div>
        <div style={{ alignSelf: "flex-start" }}>
          <Seg<ThreadState>
            label={t("collaboration.board.stateLabel")}
            value={state}
            onChange={onState}
            options={[
              { value: "open", label: t("collaboration.board.open"), count: count("open") },
              { value: "resolved", label: t("collaboration.board.resolved"), count: count("resolved") },
            ]}
          />
        </div>
      </div>
      {shared && <InterhubAgents channelId={channel.id} roster={roster} />}
      {threads.isPending ? <SkeletonRows count={2} avatar={false} label={t("collaboration.board.loadingThreads")} />
        : threads.error ? <ErrorState error={threads.error} title={t("collaboration.board.threadsError")} onRetry={() => void threads.refetch()} />
        : list.length === 0
          ? state === "resolved"
            ? <Empty icon="collaboration" title={t("collaboration.board.noResolved")} action={<Button small onClick={() => onState("open")}>{t("collaboration.board.seeOpen")}</Button>} />
            : <Empty icon="collaboration" title={t("collaboration.board.noThreadsTitle")} detail={t("collaboration.board.noThreadsDetail")} />
          : <div className="list">
              {list.map(thread => (
                <div
                  key={thread.id}
                  className={cx("row", thread.id === selected && "is-selected")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={thread.id === selected}
                  ref={element => { if (element) rows.current.set(thread.id, element); else rows.current.delete(thread.id) }}
                  onClick={() => (thread.id === selected ? closeThread() : onThread(thread.id))}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (thread.id === selected) closeThread(); else onThread(thread.id) } }}
                  style={{ alignItems: "flex-start", paddingTop: "var(--sp-3)", paddingBottom: "var(--sp-3)", cursor: "pointer" }}
                >
                  <div className="row-main" style={{ gap: "var(--sp-2)" }}>
                    <span className="row-title" title={thread.title}>{thread.title}</span>
                    <span className="row-sub">{sub(thread)}</span>
                  </div>
                </div>
              ))}
              {(threads.data?.total ?? 0) > list.length && (
                <div className="row" style={{ justifyContent: "center" }}>
                  <Button small variant="ghost" onClick={() => setLimit(value => value + THREAD_PAGE)}>{common("actions.showMore")}</Button>
                </div>
              )}
            </div>}
    </section>

    {selected && (
      <section className="collab-thread" aria-label={t("collaboration.board.threadLabel")}>
        <ThreadView key={selected} threadId={selected} channel={channel} onClose={closeThread} />
      </section>
    )}

    {!shared && <DeleteChannelDialog
      channel={channel}
      open={deleting}
      onClose={() => setDeleting(false)}
      onDeleted={(_, uncertain) => { setDeleting(false); onDeleted(uncertain) }}
    />}
  </>
}
