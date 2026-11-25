import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { dependencies, type ModuleId } from '@agenthub/shared/modules'
import { ErrorState, List, SkeletonRows, Switch, useToast } from '../components/ui'
import { api } from '../lib/api'
import { useT } from '../i18n'
import { SettingRow, SettingsSection, useErrorDetail } from '../pages/settings/SettingRow'
import { modulesKey, useModules, type ModuleSettingsResponse } from './state'

export function ModuleSettings({ id, children }: { id: ModuleId; children?: ReactNode }) {
  const { t } = useT('settings')
  const states = useModules()
  const cache = useQueryClient()
  const toast = useToast()
  const detail = useErrorDetail()
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put<ModuleSettingsResponse>('/modules/' + id, { enabled }),
    onSuccess: result => {
      cache.setQueryData(modulesKey, result)
      if (id === 'transcriptions') void window.agentHub?.getRecordingStatus?.().catch(() => undefined)
    },
    onSettled: () => cache.invalidateQueries(),
    onError: error => toast.error(t('modules.saveFailed'), detail(error)),
  })
  const enabled = states.data?.[id]
  const blocked = dependencies(id).find(required => states.data?.[required] === false)
  return <>
    <SettingsSection title={t(`sections.${id}`)}>
      {states.isError ? <ErrorState error={states.error} onRetry={() => void states.refetch()} />
        : enabled === undefined ? <SkeletonRows count={1} avatar={false} />
        : <List><SettingRow label={t('modules.enabled')} hint={blocked ? t('modules.requires', { module: t(`sections.${blocked}`) }) : t(`moduleHints.${id}`)}>
          <Switch label={t('modules.enabled')} checked={enabled} disabled={save.isPending || states.data?.can_manage === false} onChange={value => save.mutate(value)} />
        </SettingRow></List>}
    </SettingsSection>
    {enabled === true && !blocked && children}
  </>
}
