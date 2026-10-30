import { Chip } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { useT } from "../../i18n"
import type { LocalClient } from "../../lib/local"

type ClientState = "paused" | "drift" | "restart" | "synced" | "syncing"

const TONE: Record<ClientState, ChipTone> = { paused: "off", drift: "warn", restart: "warn", synced: "ok", syncing: "info" }

/** Orden de prioridad: lo que pide una acción de la persona va antes que el estado de sincronización. */
export function clientState(client: LocalClient): ClientState {
  if (!client.enabled) return "paused"
  if (client.drift_detected) return "drift"
  if (client.restart_pending) return "restart"
  return client.synchronized ? "synced" : "syncing"
}

export function ClientChip({ client }: { client: LocalClient }) {
  const { t } = useT("clients")
  const state = clientState(client)
  return <Chip tone={TONE[state]}>{t(`state.${state}`)}</Chip>
}

/** Acorta por el medio: «~/Library/…/claude_desktop_config.json». */
export function shortenPath(path: string, max = 44): string {
  const home = path.replace(/^\/(Users|home)\/[^/]+/, "~")
  if (home.length <= max) return home
  const parts = home.split(/[\\/]/)
  const last = parts.at(-1) ?? ""
  const head = parts.slice(0, 2).join("/")
  const short = `${head}/…/${last}`
  return short.length < home.length ? short : `${home.slice(0, 12)}…${home.slice(-(max - 13))}`
}
