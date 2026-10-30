import { useEffect, useRef } from "react"
import type { CSSProperties } from "react"
import { Button, Chip, IconButton, List, RowHead } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import type { RunListItem } from "../../lib/automations"
import { dayKey, runWhen, useDayText, useRunResult } from "./shared"

const ROW_MIN = 600
const ROW: CSSProperties = { minWidth: ROW_MIN }
const RESULT: CSSProperties = { width: 150, display: "flex" }
const TIME: CSSProperties = { width: 48, textAlign: "right" }
/** Mismo ancho que la casilla y el punto de sin ver: los encabezados de día alinean con los títulos. */
const CHECK_SLOT: CSSProperties = { width: "var(--sp-4)", flex: "none" }
const DOT_SLOT: CSSProperties = { width: "var(--sp-2)", flex: "none" }
const BARE_TITLE: CSSProperties = { border: 0, background: "transparent", padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", maxWidth: "100%" }

export interface HistoryListProps {
  items: readonly RunListItem[]
  selection: ReadonlySet<string>
  onSelectionChange: (next: Set<string>) => void
  activeId: string
  onOpen: (run: RunListItem) => void
  projectName: (id: string | null) => string | null
  onMarkRead: (ids: string[]) => void
  onMarkUnread: (ids: string[]) => void
  busy: boolean
}

/** Casilla de «todas»: indeterminada con una selección parcial. */
function AllCheck({ checked, partial, label, onChange }: { checked: boolean; partial: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial }, [partial])
  return <input ref={ref} className="check" type="checkbox" aria-label={label} checked={checked} onChange={onChange} />
}

/** Historial de entregas agrupado por día, con casillas, punto de sin ver y barra de selección. */
export function HistoryList({ items, selection, onSelectionChange, activeId, onOpen, projectName, onMarkRead, onMarkUnread, busy }: HistoryListProps) {
  const { t, plural } = useT("automations")
  const format = useFormat()
  const days = useDayText()
  const result = useRunResult()

  const groups: { key: string; label: string; runs: RunListItem[] }[] = []
  for (const run of items) {
    const when = runWhen(run), key = dayKey(when), last = groups.at(-1)
    if (last?.key === key) last.runs.push(run)
    else groups.push({ key, label: days.day(when), runs: [run] })
  }
  const ids = items.map(run => run.run_id)
  const unread = items.filter(run => run.read_at === null).map(run => run.run_id)
  const chosen = ids.filter(id => selection.has(id))
  const all = ids.length > 0 && chosen.length === ids.length
  const pendingUnread = unread.filter(id => !selection.has(id)).length

  function toggle(id: string) {
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  return (
    <>
      {chosen.length > 0 && (
        <div className="bulkbar" role="region" aria-label={t("history.selection")} style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
            <strong aria-live="polite">{plural("history.selected", chosen.length)}</strong>
            <Button small disabled={busy} onClick={() => onMarkRead(chosen)}>{t("history.markRead")}</Button>
            <Button small variant="ghost" disabled={busy} onClick={() => onMarkUnread(chosen)}>{t("history.markUnread")}</Button>
            {pendingUnread > 0 && (
              <Button small variant="ghost" onClick={() => onSelectionChange(new Set(unread))}>{plural("history.selectUnread", unread.length)}</Button>
            )}
          </div>
          <IconButton icon="close" small variant="ghost" label={t("history.clearSelection")} onClick={() => onSelectionChange(new Set())} />
        </div>
      )}
      <List className="scroll-x">
        {groups.map((group, index) => {
          const groupUnread = group.runs.filter(run => run.read_at === null).length
          const heading = groupUnread > 0 ? t("history.groupUnread", { day: group.label, count: groupUnread }) : group.label
          return (
            <div key={group.key} role="group" aria-label={heading}>
              {index === 0
                ? <RowHead style={ROW}>
                    <AllCheck
                      checked={all}
                      partial={chosen.length > 0 && !all}
                      label={t("history.selectAll")}
                      onChange={() => onSelectionChange(all ? new Set() : new Set(ids))}
                    />
                    <span style={DOT_SLOT} />
                    <span style={{ flex: 1 }}>{heading}</span>
                    <span className="col" style={{ width: 150 }}>{t("columns.result")}</span>
                    <span className="col" style={TIME}>{t("columns.time")}</span>
                  </RowHead>
                : <RowHead style={{ ...ROW, borderTop: "1px solid var(--border)" }}>
                    <span style={CHECK_SLOT} />
                    <span style={DOT_SLOT} />
                    <span style={{ flex: 1 }}>{heading}</span>
                  </RowHead>}
              {group.runs.map(run => {
                const isUnread = run.read_at === null
                const active = run.run_id === activeId
                const name = projectName(run.project_id) ?? t("scope.owner")
                const sub = run.artifact_kind === "notice" && run.schedule_title && run.schedule_title !== run.title ? `${run.schedule_title} · ${name}` : name
                const chip = result(run)
                return (
                  <div
                    key={run.run_id}
                    id={`delivery-${run.run_id}`}
                    className={["row", isUnread && "is-unread", active && "is-selected"].filter(Boolean).join(" ")}
                    style={{ ...ROW, cursor: "pointer" }}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onOpen(run)}
                  >
                    <input
                      className="check"
                      type="checkbox"
                      aria-label={t("history.select", { name: run.title, when: days.when(runWhen(run)) })}
                      checked={selection.has(run.run_id)}
                      onClick={event => event.stopPropagation()}
                      onChange={() => toggle(run.run_id)}
                    />
                    <span className="unread" role={isUnread ? "img" : undefined} aria-label={isUnread ? t("row.unread") : undefined} aria-hidden={isUnread ? undefined : true} />
                    <div className="row-main">
                      <span className="row-title" title={run.title}>
                        <button type="button" style={BARE_TITLE} onClick={event => { event.stopPropagation(); onOpen(run) }}>{run.title}</button>
                      </span>
                      <span className="row-sub" title={sub}>{sub}</span>
                    </div>
                    <span className="col" style={RESULT}><Chip tone={chip.tone}>{chip.label}</Chip></span>
                    <span className="col xs t3 num" style={TIME} title={format.date(runWhen(run), "datetime")}>{format.date(runWhen(run), "time")}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </List>
    </>
  )
}
