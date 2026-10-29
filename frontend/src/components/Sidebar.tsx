import { NavLink, useLocation } from "react-router-dom"
import { Icon } from "./Icon"
import { Badge, IconButton, Kbd } from "./ui/basics"
import { relativeTime } from "./ui/time"
import { uiText } from "./ui/strings"
import { DESTINATIONS, isActiveDestination, type Destination, type useShellStatus } from "./useShellStatus"

type ShellStatus = ReturnType<typeof useShellStatus>

const SIDE_STYLE = { position: "sticky", top: 0, height: "100vh", overflowY: "auto" } as const

function NavItem({ destination, status }: { destination: Destination; status: ShellStatus }) {
  const { pathname } = useLocation()
  const active = isActiveDestination(destination, pathname)
  const label = uiText(destination.labelKey)
  const badge = destination.to === "/home"
    ? <Badge count={status.pendingCount} attention label={uiText("nav.home.badge", { count: status.pendingCount })} />
    : destination.to === "/servers"
      ? <Badge count={status.serversNeedingAttention} attention label={uiText("nav.servers.badge", { count: status.serversNeedingAttention })} />
      : null
  return (
    <NavLink to={destination.to} className={active ? "nav-item is-active" : "nav-item"} aria-current={active ? "page" : undefined}>
      <Icon name={destination.icon} />
      <span className="trunc">{label}</span>
      {badge}
    </NavLink>
  )
}

function SyncLine({ status }: { status: ShellStatus }) {
  const name = status.hostname ?? uiText("status.localHub")
  const shortName = name.replace(/\.local$/, "")
  const detail = status.sync.isPending ? uiText("status.syncing")
    : status.failing ? uiText("status.stopped")
      : status.clients.length === 0 ? uiText("status.waiting")
        : status.unsynced > 0 ? uiText("status.pending")
          : uiText("status.synced", { when: relativeTime(status.lastSync) })
  return (
    <div className="side-status">
      <span className="dot" aria-hidden="true" style={status.tone === "ok" ? undefined : { background: `var(--${status.tone})` }} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }} role="status" aria-live="polite">
        <span className="trunc xs t2" title={name}>{shortName}</span>
        <span className="trunc xs t3" title={detail}>{detail}</span>
      </div>
      <IconButton icon="sync" small variant="ghost" label={uiText("status.syncNow")} disabled={status.sync.isPending} onClick={() => status.sync.mutate()} />
    </div>
  )
}

export function Sidebar({ status, onSearch, shortcut }: { status: ShellStatus; onSearch: () => void; shortcut: string }) {
  const group = (name: Destination["group"]) => DESTINATIONS.filter(destination => destination.group === name)
  return (
    <nav className="side" aria-label={uiText("nav.label")} style={SIDE_STYLE}>
      <div className="side-brand"><span className="side-mark"><Icon name="brand" small /></span>{uiText("brand.name")}</div>
      <button className="cmdk" type="button" onClick={onSearch} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K">
        <Icon name="find" />
        <span style={{ flex: 1 }}>{uiText("nav.search")}</span>
        <Kbd>{shortcut}</Kbd>
      </button>
      {group("top").map(destination => <NavItem key={destination.to} destination={destination} status={status} />)}
      <div className="nav-group" id="nav-work">{uiText("nav.group.work")}</div>
      <div role="group" aria-labelledby="nav-work" style={{ display: "contents" }}>
        {group("work").map(destination => <NavItem key={destination.to} destination={destination} status={status} />)}
      </div>
      <div className="nav-group" id="nav-connections">{uiText("nav.group.connections")}</div>
      <div role="group" aria-labelledby="nav-connections" style={{ display: "contents" }}>
        {group("connections").map(destination => <NavItem key={destination.to} destination={destination} status={status} />)}
      </div>
      <div style={{ flex: 1, minHeight: "var(--sp-5)" }} />
      {group("bottom").map(destination => <NavItem key={destination.to} destination={destination} status={status} />)}
      <SyncLine status={status} />
    </nav>
  )
}
