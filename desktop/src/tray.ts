import { t } from "./i18n.js"
import type { SupervisorState } from "./supervisor.js"

/**
 * Plantilla del menú de tray, como datos puros.
 *
 * El main la traduce a `Menu.buildFromTemplate`. Separarla permite verificar
 * en pruebas qué acciones existen y qué estado muestran, sin Electron. Los textos
 * salen del idioma activo de `i18n.ts`: el main la vuelve a construir al cambiarlo.
 */

export type TrayAction = "show" | "hide" | "toggle-autostart" | "restart-core" | "restart-client" | "quit"

export interface TrayItem {
  id?: TrayAction
  label?: string
  type?: "normal" | "separator" | "checkbox"
  enabled?: boolean
  checked?: boolean
}

export interface TrayViewModel {
  coreState: SupervisorState
  windowVisible: boolean
  autostartEnabled: boolean
  showShortcut?: { label: string; registered: boolean } | null
  /** Hay un cliente de escritorio que sigue con una lista de herramientas vieja. */
  clientRestart?: boolean
}

function coreLabel(state: SupervisorState): string {
  switch (state) {
    case "running":
      return t("tray.core.running")
    case "starting":
      return t("tray.core.starting")
    case "restarting":
      return t("tray.core.restarting")
    case "stopping":
      return t("tray.core.stopping")
    case "failed":
      return t("tray.core.failed")
    case "stopped":
    default:
      return t("tray.core.stopped")
  }
}

export function buildTrayTemplate(vm: TrayViewModel): TrayItem[] {
  return [
    { label: coreLabel(vm.coreState), enabled: false },
    { type: "separator" },
    vm.windowVisible
      ? { id: "hide", label: t("tray.hide"), type: "normal" }
      : { id: "show", label: t("tray.show"), type: "normal" },
    ...(vm.showShortcut ? [{
      label: t(vm.showShortcut.registered ? "tray.shortcut" : "tray.shortcutUnavailable", { shortcut: vm.showShortcut.label }),
      enabled: false,
    }] : []),
    {
      id: "toggle-autostart",
      label: t("tray.autostart"),
      type: "checkbox",
      checked: vm.autostartEnabled,
    },
    {
      id: "restart-core",
      label: t("tray.restartCore"),
      type: "normal",
      enabled: vm.coreState !== "starting" && vm.coreState !== "restarting",
    },
    ...(vm.clientRestart ? [{ id: "restart-client" as const, label: t("tray.restartClient"), type: "normal" as const }] : []),

    { type: "separator" },
    { id: "quit", label: t("tray.quit"), type: "normal" },
  ]
}

/** Tooltip del ícono; con el atajo registrado lo menciona. */
export function trayTooltip(shortcut: string | null): string {
  return shortcut ? t("tray.tooltipShortcut", { shortcut }) : t("tray.tooltip")
}
