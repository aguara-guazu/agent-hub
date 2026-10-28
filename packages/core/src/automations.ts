import type { Store } from './store.js'

export const AUTOMATIONS_ENABLED_SETTING = 'automations_enabled'
/** Absence keeps the scheduler on; this switch is independent of the collaboration one. */
export function automationsEnabled(store: Pick<Store, 'setting'>): boolean {
  return store.setting(AUTOMATIONS_ENABLED_SETTING) !== '0'
}

const NOTIFY_CREATED_SETTING = 'automations_notify_schedule_created'
const NOTIFY_DELIVERY_SETTING = 'automations_notify_delivery'
const KEEP_AWAKE_SETTING = 'automations_keep_awake'
const WORKDAY_HOURS_SETTING = 'automations_workday_hours'
export const DEFAULT_WORKDAY_HOURS = 8

export interface AutomationSettings {
  automations_enabled: boolean
  /** System notification when an agent creates a schedule. */
  notify_schedule_created: boolean
  /** System notification when a brief or close is delivered. */
  notify_delivery: boolean
  /** Length of a working day, in hours, used to size estimated worklogs. */
  workday_hours: number
  /** Keep the machine from sleeping while a run is active. */
  keep_awake: boolean
}
const on = (store: Pick<Store, 'setting'>, key: string) => store.setting(key) !== '0'

export function readAutomationSettings(store: Pick<Store, 'setting'>): AutomationSettings {
  const hours = Number(store.setting(WORKDAY_HOURS_SETTING))
  return { automations_enabled: automationsEnabled(store), notify_schedule_created: on(store, NOTIFY_CREATED_SETTING), notify_delivery: on(store, NOTIFY_DELIVERY_SETTING),
    workday_hours: Number.isFinite(hours) && hours >= 1 && hours <= 24 ? hours : DEFAULT_WORKDAY_HOURS, keep_awake: on(store, KEEP_AWAKE_SETTING) }
}

/** Returns the field that failed validation, or null after saving every given field. */
export function saveAutomationSettings(store: Pick<Store, 'setSetting'>, input: Record<string, unknown>): string | null {
  const flag = { automations_enabled: AUTOMATIONS_ENABLED_SETTING, notify_schedule_created: NOTIFY_CREATED_SETTING, notify_delivery: NOTIFY_DELIVERY_SETTING, keep_awake: KEEP_AWAKE_SETTING } as const
  for (const [key, value] of Object.entries(input)) {
    if (key in flag) { if (typeof value !== 'boolean') return key; continue }
    if (key === 'workday_hours') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 24) return key; continue }
    return key
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'workday_hours') store.setSetting(WORKDAY_HOURS_SETTING, String(value))
    else store.setSetting(flag[key as keyof typeof flag], value ? '1' : '0')
  }
  return null
}
