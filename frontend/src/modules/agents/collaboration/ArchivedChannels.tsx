import { useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Badge, Button, ErrorState, Icon, SkeletonRows, absoluteTime, cx, relativeTime } from "../../../components/ui"
import { useT } from "../../../i18n"
import { useMemory, type Page } from "../../../lib/memory"
import { archiveCause, type BoardChannel } from "./collabData"

const ARCHIVE_PAGE = 50

interface ArchivedChannelsProps {
  projectId: string
  open: boolean
  onToggle: () => void
  activeId: string | undefined
  href: (channelId: string) => string
}

/**
 * Pie de la columna de canales: los archivados, plegados por defecto. Solo para ver; abrir uno muestra sus hilos como
 * cualquier canal. El backend los ordena por `archived_at` descendente.
 */
export function ArchivedChannels({ projectId, open, onToggle, activeId, href }: ArchivedChannelsProps) {
  const { t, plural } = useT("project")
  const common = useT("common").t
  const [limit, setLimit] = useState(ARCHIVE_PAGE)
  const scope = { project_id: projectId, archived: true, offset: 0 }
  // Plegada solo hace falta el total; la página se pide al desplegarla y queda visible mientras llega la siguiente.
  const count = useMemory<Page<BoardChannel>>("chat_channels", { ...scope, limit: 1 }, !open)
  const page = useMemory<Page<BoardChannel>>("chat_channels", { ...scope, limit }, open)
  const kept = useRef<Page<BoardChannel> | undefined>(undefined)
  if (page.data) kept.current = page.data
  const data = page.data ?? kept.current
  const total = (open ? data?.total : undefined) ?? count.data?.total

  if (!open && count.isPending) return null
  if (total === 0) return null

  const listId = `collab-archive-${projectId}`
  const items = data?.items ?? []
  return (
    <section className="collab-archive" aria-label={t("collaboration.archive.label")}>
      <button type="button" className="collab-archive-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={onToggle}>
        <Icon name="right" small />
        <span className="trunc">{t("collaboration.archive.title")}</span>
        {total !== undefined && <Badge count={total} label={plural("collaboration.archive.count", total)} />}
      </button>
      {open && (
        <div id={listId} className="collab-archive-list">
          {!data && page.isPending ? <SkeletonRows count={2} avatar={false} label={t("collaboration.archive.loading")} />
            : !data && page.error ? <ErrorState error={page.error} title={t("collaboration.archive.error")} onRetry={() => void page.refetch()} />
            : items.map(item => <ArchivedLink key={item.id} item={item} active={item.id === activeId} href={href(item.id)} />)}
          {data && data.total > items.length && (
            <Button small variant="ghost" disabled={page.isPending} onClick={() => setLimit(value => value + ARCHIVE_PAGE)}>{common("actions.showMore")}</Button>
          )}
        </div>
      )}
    </section>
  )
}

function ArchivedLink({ item, active, href }: { item: BoardChannel; active: boolean; href: string }) {
  const { t } = useT("project")
  const cause = archiveCause(item.archive_cause)
  const when = relativeTime(item.archived_at)
  const sub = cause ? t("collaboration.archive.sub", { when, cause: t(`collaboration.archive.cause.${cause}`) }) : when
  const title = [`#${item.name}`, t("collaboration.archive.on", { date: absoluteTime(item.archived_at) }), cause && t(`collaboration.archive.causeDetail.${cause}`)].filter(Boolean).join(" · ")
  return (
    <Link replace className={cx("nav-item", "nav-item-2", active && "is-active")} aria-current={active ? "page" : undefined} to={href} title={title}>
      <span className="chan-hash" aria-hidden="true">#</span>
      <span className="nav-item-text">
        <span className="trunc">{item.name}</span>
        <span className="xs t3 trunc">{sub}</span>
      </span>
    </Link>
  )
}
