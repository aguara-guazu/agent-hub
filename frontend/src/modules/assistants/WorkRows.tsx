import { Button, Chip, cx } from "../../components/ui"
import { useT } from "../../i18n"
import type { Work } from "./data"
import { BARE_BUTTON, useLabels } from "./shared"

export interface WorkRowsProps {
  items: readonly Work[]
  activeId: string | undefined
  onOpen: (work: Work) => void
  onRetry: (work: Work) => void
  busy: boolean
}

/** Delegated work as rows; a blocked one carries its only action, retry. */
export function WorkRows({ items, activeId, onOpen, onRetry, busy }: WorkRowsProps) {
  const { t } = useT("assistants")
  const labels = useLabels()
  return (
    <>
      {items.map((work) => {
        const active = work.id === activeId
        const chip = labels.work(work.state)
        const sub = [work.project_title, t(work.role)].filter(Boolean).join(" · ")
        return (
          <div
            key={work.id}
            id={"work-" + work.id}
            className={cx("row", active && "is-selected")}
            style={{ cursor: "pointer" }}
            aria-current={active ? "true" : undefined}
            onClick={() => onOpen(work)}
          >
            <div className="row-main">
              <span className="row-title" title={work.objective}>
                <button
                  type="button"
                  style={BARE_BUTTON}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(work)
                  }}
                >
                  {work.objective}
                </button>
              </span>
              <span className="row-sub" title={sub}>
                {sub}
              </span>
            </div>
            <Chip tone={chip.tone}>{chip.label}</Chip>
            {work.state === "blocked" && (
              <Button
                small
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  onRetry(work)
                }}
              >
                {t("retry")}
              </Button>
            )}
          </div>
        )
      })}
    </>
  )
}
