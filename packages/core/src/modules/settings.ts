import { moduleDefinition, type ModuleId } from '@agenthub/shared/modules'
import type { Store } from '../store.js'

export function moduleEnabled(store: Pick<Store, 'setting'>, id: ModuleId) {
  return store.setting(moduleDefinition(id).setting) !== '0'
}
