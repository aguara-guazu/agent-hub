import { uiLanguage, uiText } from "./strings"

/** Fechas en listas: relativas hasta 7 días, después absolutas cortas («16 oct»). */
export function relativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === "") return "—"
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return "—"
  const minutes = Math.max(0, Math.round((now - time) / 60000))
  if (minutes < 1) return uiText("time.now")
  if (minutes < 60) return uiText("time.minutes", { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return uiText("time.hours", { count: hours })
  const days = Math.round(hours / 24)
  if (days === 1) return uiText("time.yesterday")
  if (days < 7) return uiText("time.days", { count: days })
  return new Date(time).toLocaleDateString(uiLanguage() === "en" ? "en-US" : "es-AR", { day: "numeric", month: "short" })
}

/** Fechas en paneles: absolutas completas («29 oct 2026, 14:19»). */
export function absoluteTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return date.toLocaleString(uiLanguage() === "en" ? "en-US" : "es-AR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}
