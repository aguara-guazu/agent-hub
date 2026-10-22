import type { Store } from './store.js'

export const COLLABORATION_ENABLED_SETTING = 'collaboration_enabled'
/** Absence preserves existing installations. This gate never changes personal exposure rules. */
export function collaborationEnabled(store: Pick<Store, 'setting'>): boolean {
  return store.setting(COLLABORATION_ENABLED_SETTING) !== '0'
}
