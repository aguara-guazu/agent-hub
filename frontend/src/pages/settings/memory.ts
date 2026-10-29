import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "../../components/ui"
import { memoryCall } from "../../lib/memory"
import { useErrorDetail } from "./SettingRow"

/** Fuente de la memoria tal como la devuelve `list_connectors`. */
export interface Connector {
  id: string
  provider: "google" | "notion" | "slack" | "jira" | string
  name: string
  config: Record<string, any>
  project_ids: string[]
  interval_minutes: number
  enabled: boolean
  account_email?: string | null
  gmail_authorized?: boolean
  gmail_send_authorized?: boolean
  last_success_at?: string | null
  last_error?: string | null
}

/** Payload de `save_connector`: sin `id` crea una fuente nueva. */
export type ConnectorInput = Pick<Connector, "provider" | "name" | "config" | "project_ids" | "interval_minutes" | "enabled"> & { id?: string }

export function connectorInput(connector: Connector, patch: Partial<ConnectorInput> = {}): ConnectorInput {
  const { id, provider, name, config, project_ids, interval_minutes, enabled } = connector
  return { id, provider, name, config, project_ids, interval_minutes, enabled, ...patch }
}

/** Gmail pide permisos que la cuenta todavía no concedió (lectura o envío). */
export function needsAuthorization(connector: Connector): boolean {
  if (connector.provider !== "google" || !connector.enabled) return false
  if (connector.gmail_authorized === false) return true
  return connector.config?.gmail_send_enabled === true && connector.gmail_send_authorized === false
}

/**
 * Operación de memoria con el error traducido en un toast. `errorTitle` es el texto principal del aviso;
 * el detalle es el mensaje del servidor. Invalida `memory` y `memory-status` igual que `useMemoryMutation`.
 */
export function useMemoryAction<T = unknown>(operation: string, errorTitle: string, onSuccess?: (data: T, input: any) => void) {
  const cache = useQueryClient()
  const toast = useToast()
  const detail = useErrorDetail()
  return useMutation({
    mutationFn: (input: unknown) => memoryCall<T>(operation, input),
    onSuccess: (data, input) => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      void cache.invalidateQueries({ queryKey: ["memory-status"] })
      onSuccess?.(data, input)
    },
    onError: error => toast.error(errorTitle, detail(error)),
  })
}

/** `true` si el trabajador de la memoria reportó un latido en el último minuto. */
export function workerActive(status: any): boolean {
  const heartbeat = status?.worker?.heartbeat
  return Boolean(heartbeat) && Date.now() - Date.parse(heartbeat) < 60_000
}
