import { useState } from "react"
import { Avatar, Button, Chip, Empty, ErrorState, List, Row, SkeletonRows } from "../../../components/ui"
import { useT } from "../../../i18n"
import { useMemory, type MemoryEntity, type Page } from "../../../lib/memory"
import { ListDate } from "../shared"
import { useTaskLabels } from "../tasks/labels"
import type { AgentNote } from "../tasks/types"

const NOTES_PAGE = 20

/** Notas de trabajo de los agentes del proyecto, solo lectura: qué hizo o está haciendo cada sesión. */
export function NotesTab({ project }: { project: MemoryEntity }) {
  const { t } = useT("project")
  const common = useT("common").t
  const labels = useTaskLabels()
  const [limit, setLimit] = useState(NOTES_PAGE)
  const notes = useMemory<Page<AgentNote>>("list_notes", { project_id: project.id, limit, offset: 0 })

  if (notes.isPending) return <SkeletonRows count={3} label={t("notes.loading")} />
  if (notes.error) return <List><ErrorState error={notes.error} title={t("notes.errorTitle")} onRetry={() => void notes.refetch()} /></List>
  if (notes.data.items.length === 0) return <List><Empty icon="note" title={t("notes.emptyTitle")} detail={t("notes.emptyDetail")} /></List>
  return (
    <section className="section" aria-label={t("notes.label")}>
      <List>
        {notes.data.items.map(note => (
          <Row
            key={note.id}
            lead={<Avatar name={note.agent_label} small />}
            title={note.text}
            titleText={note.text}
            sub={[note.agent_label, note.task_key ?? note.task_title, labels.finishReason(note)].filter(Boolean).join(" · ")}
            meta={<>
              <Chip tone={note.state === "working" ? "info" : note.state === "blocked" ? "warn" : "off"}>{labels.noteState(note)}</Chip>
              <ListDate value={note.updated_at} />
            </>}
          />
        ))}
      </List>
      {notes.data.total > notes.data.items.length && (
        <Button small variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLimit(value => value + NOTES_PAGE)}>{common("actions.showMore")}</Button>
      )}
    </section>
  )
}
