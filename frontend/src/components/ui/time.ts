import i18n from "i18next"
import { formatDate, formatRelative } from "../../i18n/format"
import type { Language } from "../../i18n/types"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SHORT_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }

/** Idioma activo de i18next; fuera de React no hay re-render, así que se lee en cada llamada. */
function activeLanguage(): Language {
  return (i18n.resolvedLanguage ?? i18n.language) === "en" ? "en" : "es"
}

function parse(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** Fechas en listas (R5): relativas hasta 7 días, después absolutas cortas («16 oct»). Sin fecha: «—». */
export function relativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  const date = parse(value)
  if (!date) return "—"
  const language = activeLanguage()
  if (Math.abs(now - date.getTime()) >= WEEK_MS) return new Intl.DateTimeFormat(language, SHORT_DATE).format(date)
  return formatRelative(date, language, now)
}

/** Fechas en paneles (R5): absolutas completas («29 oct 2026, 14:19»). Sin fecha: «—». */
export function absoluteTime(value: string | number | Date | null | undefined): string {
  const date = parse(value)
  return date ? formatDate(date, activeLanguage(), "datetime") : "—"
}
