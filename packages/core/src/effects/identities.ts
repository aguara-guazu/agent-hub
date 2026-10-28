import { RUN_PROFILE_VERSION, type RunProfileKind } from '@agenthub/shared'
import type { Store } from '../store.js'
import type { AgentInstance } from '../types.js'

/**
 * Registra (o devuelve) la identidad de política de un perfil de run para el dueño.
 *
 * Es el único camino que crea estas filas: el registro de agentes del daemon valida `cli_kind` contra `CLI_KINDS`,
 * que no incluye los perfiles, de modo que un cliente no puede adquirir una identidad de perfil por declararla.
 * Devuelve `undefined` mientras el dueño no tenga ninguna máquina registrada.
 */
export function ensureRunProfileAgent(store: Store, ownerId: string, kind: RunProfileKind): AgentInstance | undefined {
  const existing = store.runProfileAgent(ownerId, kind)
  if (existing) return existing
  const machine = store.machinesOfUser(ownerId)[0]
  if (!machine) return undefined
  return store.insertAgent({ machine_id: machine.id, cli_kind: kind, cli_version: String(RUN_PROFILE_VERSION), config_path: '' })
}
