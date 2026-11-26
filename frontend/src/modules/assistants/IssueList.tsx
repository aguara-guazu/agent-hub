import { useEffect, useRef, type ReactNode } from "react"
import { Button, Chip, IconButton, List, RowHead, Tag, cx } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { scoreTone } from "./data"
import { BARE_BUTTON, type StateChip } from "./shared"

export interface IssueRow {
  id: string
  title: string
  project: string
  detail: string
  score: number
  tag: string
  chip: StateChip | null
  at?: string | undefined
  selectable: boolean
}
/** A band of issues, or a block the page renders itself (`node`) between bands. */
export type IssueGroup = { key: string; label: string } & ({ rows: IssueRow[] } | { node: ReactNode })

export interface IssueListProps {
  groups: IssueGroup[]
  activeId: string | undefined
  onOpen: (row: IssueRow) => void
  selection: ReadonlySet<string>
  onSelectionChange: (next: Set<string>) => void
  onDismiss: (ids: string[]) => void
  busy: boolean
  footer?: ReactNode
}

function AllCheck({ checked, partial, label, onChange }: { checked: boolean; partial: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial
  }, [partial])
  return <input ref={ref} className="check" type="checkbox" aria-label={label} checked={checked} onChange={onChange} />
}

/** Issues grouped by band with their own scroll; the selection bar stays above the rows. */
export function IssueList({ groups, activeId, onOpen, selection, onSelectionChange, onDismiss, busy, footer }: IssueListProps) {
  const { t, plural } = useT("assistants")
  const format = useFormat()
  const selectable = groups.flatMap((g) => ("rows" in g ? g.rows.filter((r) => r.selectable).map((r) => r.id) : []))
  const chosen = selectable.filter((id) => selection.has(id))
  const all = selectable.length > 0 && chosen.length === selectable.length

  function toggle(id: string) {
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  return (
    <>
      {chosen.length > 0 && (
        <div className="bulkbar assistant-bulk" role="region" aria-label={t("selection")}>
          <strong aria-live="polite">{plural("selected", chosen.length)}</strong>
          <Button small disabled={busy} onClick={() => onDismiss(chosen)}>
            {t("dismissSelected")}
          </Button>
          <span className="assistant-grow" />
          <IconButton icon="close" small variant="ghost" label={t("clearSelection")} onClick={() => onSelectionChange(new Set())} />
        </div>
      )}
      <List className="assistant-rows" aria-label={t("issues")}>
        {groups.map((group, index) => (
          <div key={group.key} role="group" aria-label={group.label}>
            <RowHead>
              {selectable.length > 0 &&
                (index === 0 ? (
                  <AllCheck
                    checked={all}
                    partial={chosen.length > 0 && !all}
                    label={t("selectAll")}
                    onChange={() => onSelectionChange(all ? new Set() : new Set(selectable))}
                  />
                ) : (
                  <span className="assistant-check-slot" />
                ))}
              <span className="trunc">{group.label}</span>
            </RowHead>
            {"node" in group
              ? group.node
              : group.rows.map((row) => {
                  const active = row.id === activeId
                  const sub = [row.project, row.detail].filter(Boolean).join(" · ")
                  return (
                    <div
                      key={row.id}
                      id={"issue-" + row.id}
                      className={cx("row", active && "is-selected")}
                      style={{ cursor: "pointer" }}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onOpen(row)}
                    >
                      {selectable.length > 0 &&
                        (row.selectable ? (
                          <input
                            className="check"
                            type="checkbox"
                            aria-label={t("selectIssue", { title: row.title })}
                            checked={selection.has(row.id)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggle(row.id)}
                          />
                        ) : (
                          <span className="assistant-check-slot" />
                        ))}
                      <Chip tone={scoreTone(row.score)} title={t("urgency", { score: row.score })} className="assistant-score num">
                        {row.score}/10
                      </Chip>
                      <div className="row-main">
                        <span className="row-title" title={row.title}>
                          <button
                            type="button"
                            style={BARE_BUTTON}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpen(row)
                            }}
                          >
                            {row.title}
                          </button>
                        </span>
                        <span className="row-sub" title={sub}>
                          {row.chip && <span className="assistant-sub-state">{row.chip.label} · </span>}
                          {sub}
                        </span>
                      </div>
                      {row.chip && (
                        <span className="col assistant-col-state">
                          <Chip tone={row.chip.tone}>{row.chip.label}</Chip>
                        </span>
                      )}
                      <span className="col assistant-col-tag">
                        <Tag>{row.tag}</Tag>
                      </span>
                      {row.at && (
                        <time className="col xs t3 num assistant-col-time" dateTime={row.at} title={format.date(row.at, "datetime")}>
                          {format.relative(row.at)}
                        </time>
                      )}
                    </div>
                  )
                })}
          </div>
        ))}
        {footer}
      </List>
    </>
  )
}
