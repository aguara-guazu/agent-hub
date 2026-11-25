import { powerSaveBlocker } from 'electron'
import type { AutostartOffer } from '../../autostart-offer.js'
import { ClockWake } from './clock-wake.js'
import { holdLimitFor, KeepAwake } from './keep-awake.js'
import { deliveryNotice, FeedPoller, ScheduleNoticeBatcher, type FeedResponse, type Notice } from './schedule-feed.js'

interface ScheduleHost {
  coreFetch(path: string, init?: RequestInit): Promise<Response>
  canPoll(): boolean
  notifyOpening(notice: Notice): void
  offerAutostart: AutostartOffer['consider']
}

export function createDesktopSchedules({ coreFetch, canPoll, notifyOpening, offerAutostart }: ScheduleHost) {
  /** Ajustes de `GET /api/automations`; sin respuesta del core rigen los valores por defecto. */
  interface AutomationPrefs { automations_enabled: boolean; notify_schedule_created: boolean; notify_delivery: boolean; keep_awake: boolean }
  const DEFAULT_AUTOMATION_PREFS: AutomationPrefs = { automations_enabled: true, notify_schedule_created: true, notify_delivery: true, keep_awake: true }
  let automationPrefs = DEFAULT_AUTOMATION_PREFS
  /** Hasta leer los ajustes una vez no se sabe si la persona apagó «mantener despierta»; sin eso no se retiene la computadora. */
  let automationPrefsLoaded = false
  /** Cada cuánto el proceso principal consulta el feed del scheduler. */
  const SCHEDULE_FEED_POLL_MS = 10_000
  /** Agrupación de avisos de schedules creados o cambiados por un agente: cubre la ráfaga típica (status, brief y cierre) sin demorar el aviso. */
  const SCHEDULE_NOTICE_WINDOW_MS = 15_000
  /** Tope de respaldo por run cuando el core no informa `deadline_at`; con plazo, `holdLimitFor` lo ajusta al plazo real. */
  const KEEP_AWAKE_MAX_MS = 20 * 60_000
  /** Espera tras resume/unlock-screen: la red suele volver unos segundos después. */
  const CLOCK_WAKE_SETTLE_MS = 3_000

  const keepAwake = new KeepAwake({
    blocker: powerSaveBlocker,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
    maxHoldMs: KEEP_AWAKE_MAX_MS,
  })
  const scheduleNotices = new ScheduleNoticeBatcher({
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
    emit: notifyOpening,
    windowMs: SCHEDULE_NOTICE_WINDOW_MS,
  })
  const scheduleFeed = new FeedPoller({
    fetchFeed: async (after): Promise<FeedResponse> => {
      const response = await coreFetch(`/api/memory/schedules/feed${after === null ? '' : `?after=${after}`}`)
      if (!response.ok) throw new Error(`schedules feed: HTTP ${response.status}`)
      return await response.json() as FeedResponse
    },
    onEvents: events => {
      void offerAutostart(events).catch(error => console.error('[autostart offer]', error))
      if (automationPrefs.notify_schedule_created) scheduleNotices.add(events)
      if (automationPrefs.notify_delivery) for (const event of events) { const notice = deliveryNotice(event); if (notice) notifyOpening(notice) }
    },
    onActiveRuns: runs => {
      if (automationPrefsLoaded && automationPrefs.automations_enabled && automationPrefs.keep_awake) keepAwake.sync(runs.map(run => ({ reason: run.run_id, maxMs: holdLimitFor(run.deadline_at, Date.now(), KEEP_AWAKE_MAX_MS) })))
      else keepAwake.dispose()
    },
  })
  const clockWake = new ClockWake({
    wake: async () => { await coreFetch('/api/memory/schedules/kick', { method: 'POST' }); await pollSchedules() },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
    settleMs: CLOCK_WAKE_SETTLE_MS,
  })

  async function refreshAutomationPrefs(): Promise<void> {
    try {
      const response = await coreFetch('/api/automations')
      if (response.ok) { automationPrefs = { ...DEFAULT_AUTOMATION_PREFS, ...await response.json() as Partial<AutomationPrefs> }; automationPrefsLoaded = true }
    } catch {
      // Con el core caído se conservan los últimos valores conocidos.
    }
  }

  /** Consulta en curso: una respuesta lenta del core no debe solaparse con el ciclo siguiente ni con el despertar del reloj, o se duplicarían los avisos. */
  let schedulePoll: Promise<void> | null = null

  function pollSchedules(): Promise<void> {
    if (!canPoll()) return Promise.resolve()
    schedulePoll ??= (async () => {
      try {
        await refreshAutomationPrefs()
        await scheduleFeed.poll()
      } catch {
        // El próximo ciclo reintenta con el mismo cursor.
      } finally {
        schedulePoll = null
      }
    })()
    return schedulePoll
  }

  let timer: NodeJS.Timeout | undefined
  return {
    start() {
      timer ??= setInterval(() => void pollSchedules(), SCHEDULE_FEED_POLL_MS).unref()
      void pollSchedules()
    },
    wake: () => clockWake.trigger(),
    close() {
      clearInterval(timer)
      timer = undefined
      keepAwake.dispose()
      clockWake.dispose()
      scheduleNotices.dispose()
    },
  }
}
