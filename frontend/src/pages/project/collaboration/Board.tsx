import { useState } from "react"
import { Link } from "react-router-dom"
import { Avatar, Badge, Banner, Button, Chip, Empty, ErrorState, MoreMenu, Seg, SkeletonRows, cx, useToast, type MenuItem } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory, type MemoryEntity, type Page } from "../../../lib/memory"
import { AgentPanel } from "../../collaboration/AgentPanel"
import { ChannelPanel, DeleteChannelDialog } from "../../collaboration/ChannelPanel"
import { PlanPanel } from "../../collaboration/PlanPanel"
import { visibleAgents } from "../../collaboration/shared"
import type { Participant } from "../../collaboration/types"
import { SidePanel, useWorkPanel } from "../work"
import { useBoardParams, type BoardChannel, type BoardThread, type ThreadState } from "./collabData"
import { TrashPanel } from "./BoardPanels"
import { ThreadView } from "./ThreadView"

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
  const agentsPanel = useWorkPanel("agents")
  const agentPanel = useWorkPanel("agent")
  const planPanel = useWorkPanel("plan")
  const trashPanel = useWorkPanel("trash")

  const channels = useMemory<Page<BoardChannel>>("chat_channels", { project_id: project.id, limit: CHANNEL_LIMIT, offset: 0 })
  const items = channels.data?.items ?? []
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
        agentOffset={0}
        onAgentOffset={() => undefined}
        onThreads={id => { agentsPanel.close(); selectChannel(id) }}
        onThread={(id, channelId) => { agentsPanel.close(); openThread(id, channelId) }}
        onPlan={id => planPanel.open(id)}
        onChannel={id => agentsPanel.open(id)}
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
    <section className="section" aria-label={t("collaboration.board.label")}>
      {banner}
      <div className="collab">
        <nav className="collab-chans" aria-label={t("collaboration.board.channels")}>
          <div className="nav-group">{t("collaboration.board.channels")}</div>
          {channels.isPending ? <SkeletonRows count={3} avatar={false} label={t("collaboration.board.loadingChannels")} />
            : channels.error ? <ErrorState error={channels.error} title={t("collaboration.board.channelsError")} onRetry={() => void channels.refetch()} />
            : items.map(item => (
              <Link
                key={item.id}
                replace
                className={cx("nav-item", item.id === channel?.id && "is-active")}
                aria-current={item.id === channel?.id ? "page" : undefined}
                to={params.href({ channel: item.id, thread: null, tstate: null })}
              >
                <span className="chan-hash" aria-hidden="true">#</span>
                <span className="trunc">{item.name}</span>
                <Badge count={item.awaiting_decision ?? 0} attention label={t("collaboration.board.awaitingBadge", { count: item.awaiting_decision ?? 0 })} />
              </Link>
            ))}
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
                onAgents={() => agentsPanel.open(channel.id)}
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
  onAgents: () => void
  onPlan: (id: string) => void
  onTrash: () => void
  onDeleted: (uncertain: boolean) => void
}

function ChannelColumns({ projectId, channel, state, threadId, onState, onThread, onAgents, onPlan, onTrash, onDeleted }: ChannelColumnsProps) {
  const { t, plural } = useT("project")
  const common = useT("common").t
  const format = useFormat()
  const [limit, setLimit] = useState(THREAD_PAGE)
  const [deleting, setDeleting] = useState(false)
  const scope = { project_id: projectId, channel_id: channel.id }
  const threads = useMemory<Page<BoardThread>>("chat_threads", { ...scope, query: "", state, limit, offset: 0 })
  const other = useMemory<Page<BoardThread>>("chat_threads", { ...scope, query: "", state: state === "open" ? "resolved" : "open", limit: 1, offset: 0 })
  const agents = useMemory<Page<Participant>>("chat_agents", { ...scope, include_team_history: true, limit: 100, offset: 0 })
  const visible = visibleAgents(agents.data?.items)
  const list = threads.data?.items ?? []
  const selected = list.find(item => item.id === threadId)?.id ?? (threadId || list[0]?.id || "")
  const count = (value: ThreadState) => (value === state ? threads.data?.total : other.data?.total)

  const menu: MenuItem[] = [{ label: t("collaboration.board.channelAgents"), onSelect: onAgents }]
  if (channel.team_plan_id) menu.push({ label: t("collaboration.board.viewTeam"), onSelect: () => onPlan(channel.team_plan_id!) })
  menu.push({ label: t("collaboration.board.trash"), onSelect: onTrash })
  menu.push({ label: t("collaboration.board.deleteChannel"), danger: true, onSelect: () => setDeleting(true) })

  function chip(thread: BoardThread) {
    if (thread.state === "resolved" || thread.debate_state === "resolved") return <Chip tone="off">{t("collaboration.board.resolvedChip")}</Chip>
    if (thread.debate_state === "awaiting_decision") return <Chip tone="warn">{t("collaboration.board.awaiting")}</Chip>
    if (thread.debate_state === "open") return <Chip tone="info">{t("collaboration.board.debating")}</Chip>
    return null
  }

  function sub(thread: BoardThread) {
    return [
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
            <h2 className="h2 trunc"><span className="chan-hash" aria-hidden="true">#</span> {channel.name}</h2>
            {channel.description && <span className="row-sub" title={channel.description}>{channel.description}</span>}
          </div>
          {visible.length > 0 && (
            <button
              type="button"
              onClick={onAgents}
              aria-label={plural("collaboration.board.agentsButton", visible.length)}
              title={visible.map(agent => agent.label).join(", ")}
              style={{ display: "flex", background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
            >
              {visible.slice(0, HEAD_AGENTS).map((agent, index) => (
                <span key={agent.id} style={{ display: "flex", marginLeft: index ? "calc(var(--sp-1) * -1)" : 0, borderRadius: "var(--r-sm)", boxShadow: "0 0 0 2px var(--surface)" }}>
                  <Avatar name={agent.label} small />
                </span>
              ))}
              {visible.length > HEAD_AGENTS && <span className="xs t3" style={{ alignSelf: "center", marginLeft: "var(--sp-1)" }}>+{visible.length - HEAD_AGENTS}</span>}
            </button>
          )}
          <MoreMenu small ghost label={t("collaboration.board.channelActions", { name: channel.name })} items={menu} />
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
                  onClick={() => onThread(thread.id)}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onThread(thread.id) } }}
                  style={{ alignItems: "flex-start", paddingTop: "var(--sp-3)", paddingBottom: "var(--sp-3)", cursor: "pointer" }}
                >
                  <div className="row-main" style={{ gap: "var(--sp-2)" }}>
                    <span className="row-title" title={thread.title}>{thread.title}</span>
                    <span className="row-sub">{sub(thread)}</span>
                    {chip(thread) && <span style={{ alignSelf: "flex-start" }}>{chip(thread)}</span>}
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

    <section className="collab-thread" aria-label={t("collaboration.board.threadLabel")}>
      {selected
        ? <ThreadView key={selected} threadId={selected} channel={channel} />
        : threads.isPending ? <SkeletonRows count={3} label={t("collaboration.board.loadingThread")} />
        : <Empty icon="collaboration" title={t("collaboration.board.pickThreadTitle")} detail={t("collaboration.board.pickThreadDetail")} />}
    </section>

    <DeleteChannelDialog
      channel={channel}
      open={deleting}
      onClose={() => setDeleting(false)}
      onDeleted={(_, uncertain) => { setDeleting(false); onDeleted(uncertain) }}
    />
  </>
}
