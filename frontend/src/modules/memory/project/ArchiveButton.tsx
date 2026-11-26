import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, useToast } from '../../../components/ui'
import { useT } from '../../../i18n'
import { api } from '../../../lib/api'
import type { MemoryEntity } from '../../../lib/memory'

export function ArchiveButton({ project, small = false }: { project: MemoryEntity; small?: boolean }) {
  const { t } = useT('projects')
  const cache = useQueryClient(), toast = useToast()
  const archived = Boolean(project.archived_at)
  const action = useMutation({
    mutationFn: () => api.put(`/memory/projects/${project.id}/archive`, {
      state: archived ? 'active' : 'archived', version: project.archive_version ?? 0,
    }),
    onSuccess: () => toast.success(t(archived ? 'actions.restored' : 'actions.archived', { name: project.title })),
    onError: error => toast.error(error.message),
    onSettled: async () => {
      await Promise.all(['memory','assistants','schedules','sharing'].map(key => cache.invalidateQueries({ queryKey: [key] })))
    },
  })
  return <Button small={small} disabled={action.isPending} onClick={() => action.mutate()}
    aria-label={t(archived ? 'actions.restoreNamed' : 'actions.archiveNamed', { name: project.title })}>
    {t(archived ? 'actions.unarchive' : 'actions.archive')}
  </Button>
}
