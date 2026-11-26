import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import type { PortfolioPolicy, Profile, Watch } from '@agenthub/shared/assistants'
import { Button, ErrorState, Field, Input, Select, Switch, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { useT } from '../../i18n'
import { usePolicy, useProfile, useProjects, type PortfolioSettings, type SettingsData } from './data'
import './assistants.css'

export default function Settings() {
  const { t } = useT('assistants'),
    projects = useProjects(),
    [params] = useSearchParams(),
    [selected, select] = useState(params.get('project') ?? '')
  const project = selected,
    settings = useProfile(project),
    policy = usePolicy()
  if (projects.error || policy.error || settings.error) return <ErrorState error={projects.error || policy.error || settings.error} />
  if (!policy.data) return <p>{t('loading')}</p>
  return (
    <section className="assistant-pane">
      <h2>{t('globalSettings')}</h2>
      <p>{t('coverageHelp')}</p>
      <PolicyEditor key={policy.data.version} data={policy.data} />
      {!!projects.data?.items.length && (
        <details open={project ? true : undefined}>
          <summary>{t('exceptions')}</summary>
          <Select
            label={t('project')}
            value={project}
            onChange={select}
            options={[{ value: '', label: t('chooseOptional') }, ...projects.data.items.map((p) => ({ label: p.title, value: p.id }))]}
          />
          {settings.data && <Editor key={project + '/' + settings.data.version} data={settings.data} />}
        </details>
      )}
    </section>
  )
}
function PolicyEditor({ data }: { data: PortfolioSettings }) {
  const { t } = useT('assistants'),
    cache = useQueryClient(),
    [p, set] = useState(data.config)
  function change<K extends keyof PortfolioPolicy>(key: K, value: PortfolioPolicy[K]) {
    set((current) => ({ ...current, [key]: value }))
  }
  const save = useMutation({
    mutationFn: () => api.put('/assistants/settings', { config: p, version: data.version }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['assistants'] }),
  })
  const num = (key: 'delay_minutes' | 'daily_turns' | 'threshold', label: 'delay' | 'budget' | 'threshold', max: number) => (
    <Field label={t(label)}>
      <Input required type="number" min={1} max={max} value={p[key]} onChange={(e) => change(key, e.target.valueAsNumber)} />
    </Field>
  )
  return (
    <form
      className="assistant-form"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="assistant-grid">
        {num('delay_minutes', 'delay', 240)}
        {num('threshold', 'threshold', 10)}
        {num('daily_turns', 'budget', 500)}
      </div>
      <fieldset>
        <legend>{t('notice')}</legend>
        <div className="assistant-grid">
          <Field label={t('timezone')}>
            <Input required value={p.timezone} onChange={(e) => change('timezone', e.target.value)} />
          </Field>
          {(['start', 'end'] as const).map((key) => (
            <Field key={key} label={t(key)}>
              <Input required type="time" value={p[key]} onChange={(e) => change(key, e.target.value)} />
            </Field>
          ))}
        </div>
        <div className="assistant-actions" aria-label={t('weekdays')}>
          {t('days')
            .split(' ')
            .map((day, i) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={p.weekdays.includes(i)}
                  onChange={(e) => change('weekdays', e.target.checked ? [...p.weekdays, i] : p.weekdays.filter((d) => d !== i))}
                />
                {day}
              </label>
            ))}
        </div>
      </fieldset>
      {(
        [
          ['night_work', 'night'],
          ['keep_awake', 'awake'],
        ] as const
      ).map(([key, label]) => (
        <label className="assistant-switch" key={key}>
          <Switch label={t(label)} checked={p[key]} onChange={(v) => change(key, v)} />
          {t(label)}
        </label>
      ))}
      <fieldset>
        <legend>{t('deliveryPolicy')}</legend>
        <label className="assistant-switch">
          <Switch
            label={t('adaptiveCooldown')}
            checked={p.notifications.adaptive_cooldown}
            onChange={(value) => change('notifications', { ...p.notifications, adaptive_cooldown: value })}
          />
          {t('adaptiveCooldown')}
        </label>
        <label className="assistant-switch">
          <Switch
            label={t('meetingQuiet')}
            checked={p.notifications.pause_in_meetings}
            onChange={(value) => change('notifications', { ...p.notifications, pause_in_meetings: value })}
          />
          {t('meetingQuiet')}
        </label>
        <div className="assistant-grid">
          <Select
            label={t('criticalSeverity')}
            value={String(p.notifications.interrupt_severity ?? 'never')}
            onChange={(value) =>
              change('notifications', { ...p.notifications, interrupt_severity: value === 'never' ? null : Number(value) })
            }
            options={[
              { value: 'never', label: t('noInterruption') },
              ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: i + 1 + '/10' })),
            ]}
          />
          {(
            [
              ['cooldown_minutes', 'cooldown', 1, 180],
              ['reminder_minutes', 'reminder', 5, 240],
              ['daily_limit', 'dailyLimit', 1, 4],
            ] as const
          ).map(([key, label, min, max]) => (
            <Field key={key} label={t(label)}>
              <Input
                required
                type="number"
                min={min}
                max={max}
                value={p.notifications[key]}
                onChange={(e) => change('notifications', { ...p.notifications, [key]: e.target.valueAsNumber })}
              />
            </Field>
          ))}
        </div>
        <p>{t('notificationHelp')}</p>
      </fieldset>
      <Field label={t('style')}>
        <Textarea value={p.style} onChange={(e) => change('style', e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" disabled={save.isPending}>
        {t('save')}
      </Button>
      {save.error && <ErrorState error={save.error} />}
    </form>
  )
}
function Editor({ data }: { data: SettingsData }) {
  const { t } = useT('assistants'),
    cache = useQueryClient(),
    [p, set] = useState(data.config)
  function change<K extends keyof Profile>(key: K, value: Profile[K]) {
    set((current) => ({ ...current, [key]: value }))
  }
  function watch(index: number, change: Partial<Watch>) {
    set((current) => ({ ...current, slack: current.slack.map((w, i) => (i === index ? { ...w, ...change } : w)) }))
  }
  const save = useMutation({
    mutationFn: () => api.put('/assistants/projects/' + data.project_id, { config: p, version: data.version }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['assistants'] }),
  })
  const sim = useMutation({
    mutationFn: () =>
      api.post<{ cases: unknown[]; current: string[]; proposed: string[] }>('/assistants/projects/' + data.project_id + '/shadow', p),
  })
  const lines = (value: string) =>
    value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  return (
    <form
      className="assistant-form"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <Switch label={t('active')} checked={p.active} onChange={(v) => change('active', v)} />
      <span>{t(p.active ? 'monitoring' : 'paused')}</span>
      <fieldset>
        <legend>{t('channels')}</legend>
        {p.slack.map((w, i) => {
          const c = data.connectors.find((c) => c.id === w.connector_id)
          return (
            <div key={i} className="assistant-watch">
              <div className="assistant-grid">
                <Select
                  label={t('connection')}
                  value={w.connector_id}
                  options={data.connectors.map((c) => ({ value: c.id, label: c.name }))}
                  onChange={(id) => watch(i, { connector_id: id, channel: data.connectors.find((c) => c.id === id)?.channels[0] ?? '' })}
                />
                <Select
                  label={t('channel')}
                  value={w.channel}
                  options={(c?.channels ?? []).map((id) => ({ value: id, label: id }))}
                  onChange={(channel) => watch(i, { channel })}
                />
                <Field label={t('team')}>
                  <Input required value={w.team} onChange={(e) => watch(i, { team: e.target.value.trim() })} />
                </Field>
                <Field label={t('user')}>
                  <Input required value={w.owner} onChange={(e) => watch(i, { owner: e.target.value.trim() })} />
                </Field>
                <Field label={t('colleagues')}>
                  <Input
                    defaultValue={w.colleagues.join(', ')}
                    onBlur={(e) =>
                      watch(i, {
                        colleagues: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              </div>
              <Button
                small
                onClick={() =>
                  change(
                    'slack',
                    p.slack.filter((_, n) => n !== i),
                  )
                }
              >
                {t('remove')}
              </Button>
            </div>
          )
        })}
        {data.connectors.length ? (
          <Button
            small
            onClick={() => {
              const c = data.connectors[0]!
              change('slack', [...p.slack, { connector_id: c.id, channel: c.channels[0] ?? '', owner: '', team: '', colleagues: [] }])
            }}
          >
            {t('add')}
          </Button>
        ) : (
          <p>{t('noConnections')}</p>
        )}
      </fieldset>
      <details>
        <summary>{t('advanced')}</summary>
        <div className="assistant-form">
          <Field label={t('jira')}>
            <Input value={p.jira_owner} onChange={(e) => change('jira_owner', e.target.value)} />
          </Field>
          <Field label={t('repo')}>
            <Input value={p.repository} onChange={(e) => change('repository', e.target.value)} />
          </Field>
          {(
            [
              ['github_repos', 'github'],
              ['files', 'files'],
              ['verify', 'verify'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={t(label)}>
              <Textarea mono defaultValue={p[key].join('\n')} onBlur={(e) => change(key, lines(e.target.value))} />
            </Field>
          ))}
        </div>
      </details>
      <div className="assistant-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t('save')}
        </Button>
        <Button onClick={() => sim.mutate()} disabled={sim.isPending}>
          {t('shadow')}
        </Button>
      </div>
      {sim.data && (
        <p role="status">
          {t('simulation', { total: sim.data.cases.length, proposed: sim.data.proposed.length, current: sim.data.current.length })}
        </p>
      )}
      {(save.error || sim.error) && <ErrorState error={save.error || sim.error} />}
    </form>
  )
}
