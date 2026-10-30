import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, Chip, List, useToast } from "../../../components/ui"
import type { ChipTone } from "../../../components/ui"
import { useT } from "../../../i18n"
import { useOverview } from "../../../lib/local"
import { useMemoryStatus } from "../../../lib/memory"
import type { CoreState, CoreStatus } from "../../../electron"
import { workerActive } from "../memory"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

/** Misma clave que `useShellStatus`: el pie de la barra lateral y esta sección comparten el estado del escritorio. */
const DESKTOP_STATUS_KEY = ["desktop-status"] as const

const CORE_TONES: Record<CoreState, ChipTone> = { running: "ok", starting: "info", restarting: "info", stopping: "info", stopped: "off", failed: "danger" }
type MemoryState = "ready" | "migrating" | "migration_pending" | "unavailable"
const MEMORY_TONES: Record<MemoryState, ChipTone> = { ready: "ok", migrating: "info", migration_pending: "warn", unavailable: "danger" }
const PLATFORMS: Record<string, "mac" | "windows" | "linux"> = { darwin: "mac", win32: "windows", linux: "linux" }

/** `http://127.0.0.1:47320/api` → `127.0.0.1:47320`. */
function address(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/**
 * Sistema: servicio local y sincronizador de clientes (puente de escritorio), memoria local y esta computadora.
 * «Reiniciar servicio» se ejecuta sin confirmación: no borra datos y el estado vuelve solo (Ajustes solo confirma
 * «Restaurar»). Versión, actualizaciones y rutas de datos no están expuestas por la API ni por el puente.
 */
export default function Sistema() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const desktop = typeof window !== "undefined" ? window.agentHub : undefined
  const core = useQuery({ queryKey: DESKTOP_STATUS_KEY, queryFn: () => desktop?.getCoreStatus() ?? Promise.resolve(null), refetchInterval: 2000 })
  useEffect(() => desktop?.onCoreStateChanged(status => cache.setQueryData<CoreStatus | null>(DESKTOP_STATUS_KEY, status)), [desktop, cache])
  const restart = useMutation({
    mutationFn: () => desktop!.restartCore(),
    onSuccess: () => { void cache.invalidateQueries(); toast.success(t("system.service.restarted")) },
    onError: error => toast.error(t("system.service.restartFailed"), detail(error)),
  })
  const memory = useMemoryStatus()
  const overview = useOverview()
  const state = core.data?.state
  const daemon = core.data?.daemonState
  const memoryState = memory.data?.state as MemoryState | undefined
  const platform = desktop ? PLATFORMS[desktop.platform] : undefined
  const computer = [overview.data?.hostname, platform ? t(`system.computer.platform.${platform}`) : null].filter(Boolean).join(" · ")
  return (
    <SettingsSection title={t("sections.sistema")}>
      <List>
        <SettingRow
          label={t("system.service.label")}
          hint={!desktop ? t("system.service.browserHint") : core.data?.apiBaseUrl ? address(core.data.apiBaseUrl) : undefined}
          monoHint={Boolean(desktop && core.data?.apiBaseUrl)}
        >
          {desktop && (core.error
            ? <Chip tone="danger">{t("system.state.unreachable")}</Chip>
            : state && <Chip tone={CORE_TONES[state]}>{t(`system.state.${state}`)}</Chip>)}
          {desktop && (
            <Button small disabled={restart.isPending || state === "restarting" || state === "starting"} onClick={() => restart.mutate()}>
              {restart.isPending ? t("system.service.restarting") : t("system.service.restart")}
            </Button>
          )}
        </SettingRow>
        {desktop && (
          <SettingRow label={t("system.daemon.label")} hint={t("system.daemon.hint")}>
            {daemon ? <Chip tone={CORE_TONES[daemon]}>{t(`system.state.${daemon}`)}</Chip> : <span className="xs t3">—</span>}
          </SettingRow>
        )}
        <SettingRow
          label={t("system.memory.label")}
          hint={memory.data?.ready ? t(workerActive(memory.data) ? "system.memory.workerActive" : "system.memory.workerIdle") : undefined}
        >
          {memory.error
            ? <Chip tone="danger">{t("system.memory.state.unavailable")}</Chip>
            : memoryState && MEMORY_TONES[memoryState] && <Chip tone={MEMORY_TONES[memoryState]}>{t(`system.memory.state.${memoryState}`)}</Chip>}
        </SettingRow>
        <SettingRow label={t("system.computer.label")} hint={computer || undefined} />
      </List>
    </SettingsSection>
  )
}
