import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Avatar, Button, Empty, ErrorState, List, Panel, PanelBody, PanelHeader, Row, SkeletonRows, relativeTime, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemory, type Page } from "../../../lib/memory"
import { useErrorText } from "../shared"
import type { BoardChannel } from "./collabData"

/** Canales del proyecto en la papelera: se restauran con sus hilos; restaurar no reactiva sesiones cerradas. */
export function TrashPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useT("project")
  const toast = useToast()
  const errorText = useErrorText()
  const cache = useQueryClient()
  const trash = useMemory<Page<BoardChannel>>("chat_channels", { project_id: projectId, deleted: true, limit: 100, offset: 0 })
  const restore = useMutation({
    mutationFn: (channel: BoardChannel) => api.post("/memory/chat/channels/restore", { channel_id: channel.id }),
    onSuccess: (_, channel) => { void cache.invalidateQueries({ queryKey: ["memory"] }); toast.success(t("collaboration.board.restored", { name: channel.name })) },
    onError: failure => toast.error(errorText(failure)),
  })
  const items = trash.data?.items ?? []
  return (
    <Panel label={t("collaboration.board.trash")} onClose={onClose}>
      <PanelHeader title={t("collaboration.board.trash")} />
      <PanelBody>
        {trash.isPending ? <SkeletonRows count={2} label={t("collaboration.board.loadingTrash")} />
          : trash.error ? <List><ErrorState error={trash.error} title={t("collaboration.board.trashError")} onRetry={() => void trash.refetch()} /></List>
          : items.length === 0 ? <List><Empty icon="collaboration" title={t("collaboration.board.trashEmpty")} /></List>
          : (
            <List>
              {items.map(item => (
                <Row
                  key={item.id}
                  lead={<Avatar name={item.name} small />}
                  title={`#${item.name}`}
                  sub={item.description ?? item.path}
                  meta={<span title={item.deleted_at ?? undefined}>{relativeTime(item.deleted_at)}</span>}
                  action={<Button small disabled={restore.isPending} onClick={() => restore.mutate(item)}>{t("collaboration.board.restore")}</Button>}
                />
              ))}
            </List>
          )}
      </PanelBody>
    </Panel>
  )
}
