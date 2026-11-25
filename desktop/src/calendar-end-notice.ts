import { BrowserWindow, Notification, screen } from "electron"
import { fileURLToPath } from "node:url"
import { activeLanguage, t } from "./i18n.js"
import { secureWebPreferences } from "./window.js"
import type { EndDecision, EndNotice } from "./calendar-end-reminder.js"

function escapeText(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** Desktop-owned notification. Its lifetime is controlled by the recording, regardless of the OS banner timeout. */
export function showCalendarEndNotice(title: string, decide: (choice: EndDecision) => void, reason: "schedule" | "silence" | "remoteSilence" = "schedule"): EndNotice {
  const heading = t(reason === "schedule" ? "recording.endedTitle" : "recording.silenceTitle")
  const wayland = process.platform === "linux" && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland")
  const { workArea } = wayland ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.min(410, workArea.width), height = Math.min(174, workArea.height)
  const win = new BrowserWindow({
    title: heading, width, height, x: Math.max(workArea.x, workArea.x + workArea.width - width - 14),
    y: Math.max(workArea.y, workArea.y + workArea.height - height - 14),
    // A Wayland surface must be mapped before some compositors will deliver the first frame.
    show: Boolean(wayland), frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, closable: false, autoHideMenuBar: true,
    webPreferences: secureWebPreferences(fileURLToPath(new URL("./calendar-end-preload.cjs", import.meta.url))),
  })
  if (process.platform !== "win32" && !wayland) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", event => event.preventDefault())
  win.webContents.ipc.on("agenthub:calendar-end-choice", (_event, choice: unknown) => {
    if (choice === "stop" || choice === "continue") decide(choice)
  })
  // A shortcut or a window manager close request must not silently acknowledge the reminder.
  win.on("close", event => event.preventDefault())
  const body = t(reason === "schedule" ? "recording.endedBody" : reason === "silence" ? "recording.silenceBody" : "recording.remoteSilenceBody", { title: title || t("recording.untitled") })
  let native: Notification | undefined
  if (wayland) {
    // The compositor controls stacking. Also request an actionable, persistent OS notification.
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed() || !Notification.isSupported()) return
      native = new Notification({ title: heading, body, urgency: "critical", timeoutType: "never", silent: true })
      native.on("click", () => { if (!win.isDestroyed()) { win.show(); win.focus() } })
      native.show()
    })
  } else {
    win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive() })
  }
  const content = `<!doctype html><html lang="${activeLanguage()}"><meta charset="utf-8"><title>${heading}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>:root{color-scheme:light dark;font:15px/1.35 system-ui}*{box-sizing:border-box}body{margin:0;padding:16px 20px;min-height:100vh;display:flex;flex-direction:column;border:1px solid GrayText}
h1{font-size:18px;margin:0 0 6px;-webkit-app-region:drag}p{margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
footer{display:flex;gap:10px;justify-content:flex-end;margin-top:auto}button{font:inherit;padding:5px 10px;cursor:pointer}</style>
<h1>${heading}</h1><p>${escapeText(body)}</p>
<footer><button data-decision="continue">${t("recording.endContinue")}</button><button data-decision="stop">${t("recording.endStop")}</button></footer></html>`
  const close = () => { native?.close(); if (!win.isDestroyed()) win.destroy() }
  win.webContents.once("render-process-gone", close)
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(content)).catch(close)
  return { close, isClosed: () => win.isDestroyed() }
}
