import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { Button, Tag } from "../../components/ui/basics"
import { Empty, ErrorState, Loading } from "../../components/ui/display"
import { useFormat, useT } from "../../i18n/useT"
import { highlightParts, isEntityKind, useMemoryReady, useRetryMigration } from "../../lib/memory-view"

const MARK_STYLE = { background: "var(--accent-weak)", color: "var(--text)", borderRadius: "var(--r-sm)", padding: "0 2px" }

/** Texto con las coincidencias de la búsqueda resaltadas. */
export function Highlight({ text, query }: { text: string; query: string }) {
  return <>{highlightParts(text, query).map((part, index) => part.match ? <mark key={index} style={MARK_STYLE}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>
}

export function KindTag({ kind }: { kind: string }) {
  const { t } = useT("memory")
  return <Tag>{isEntityKind(kind) ? t(`kind.${kind}`) : t("kind.other")}</Tag>
}

/** Fechas de lista (R5): relativas hasta 7 días, después «13 oct»; la absoluta completa va en el `title`. */
export function useListDate() {
  const format = useFormat()
  return (value: string | null | undefined): { text: string; title: string } => {
    if (!value) return { text: "—", title: "" }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return { text: "—", title: "" }
    const title = format.date(date, "datetime")
    if (Math.abs(Date.now() - date.getTime()) < 7 * 86_400_000) return { text: format.relative(date), title }
    const sameYear = date.getFullYear() === new Date().getFullYear()
    const text = new Intl.DateTimeFormat(format.language, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(date)
    return { text, title }
  }
}

/** Muestra el contenido solo cuando la memoria local está lista; si no, el estado correspondiente con una acción. */
export function MemoryGate({ children }: { children: ReactNode }) {
  const { t } = useT("memory"), { t: common } = useT("common"), status = useMemoryReady(), retry = useRetryMigration()
  if (status.isPending) return <Loading label={t("gate.connecting")} />
  if (status.error) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />
  const data = status.data
  if (data.state === "migrating") {
    const total = data.migration?.total ?? 0, copied = data.migration?.copied ?? 0
    return <Empty icon="sync" title={t("gate.migratingTitle")} detail={total ? t("gate.migratingProgress", { percent: Math.floor((copied * 100) / total) }) : t("gate.migratingPreparing")} />
  }
  if (data.state === "migration_pending") {
    return <Empty tone="danger" icon="warning" title={t("gate.pendingTitle")} detail={t("gate.pendingDetail")} action={<Button small disabled={retry.isPending} onClick={() => retry.mutate()}>{t("gate.retryMigration")}</Button>} />
  }
  if (!data.ready) {
    return <Empty tone="danger" icon="error" title={t("gate.unavailableTitle")} detail={t("gate.unavailableDetail")} action={<Button small onClick={() => void status.refetch()}>{common("actions.retry")}</Button>} />
  }
  return <>{children}</>
}

/** Carga progresiva: pide la página siguiente al acercarse al final; el botón queda como alternativa de teclado. */
export function LoadMore({ loading, onMore }: { loading: boolean; onMore: () => void }) {
  const { t: common } = useT("common")
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !loading) onMore() }, { rootMargin: "240px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, onMore])
  return <div ref={sentinel} style={{ display: "flex", justifyContent: "center" }}><Button small disabled={loading} onClick={onMore}>{loading ? common("states.loading") : common("actions.showMore")}</Button></div>
}
