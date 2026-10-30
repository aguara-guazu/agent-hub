import type { Language } from "./types"

type DateInput = Date | string | number

/** Estilos de fecha absoluta: `date` «29 oct 2026», `time` «14:13», `datetime` «29 oct 2026, 14:13». */
export type DateStyle = "date" | "time" | "datetime"

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { day: "numeric", month: "short", year: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
  datetime: { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" },
}

const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat | Intl.ListFormat | Intl.PluralRules>()

/** Devuelve un formateador `Intl` cacheado por tipo, idioma y opciones. */
function cached<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat | Intl.ListFormat | Intl.PluralRules>(
  kind: string, language: Language, options: object, create: () => T,
): T {
  const key = `${kind}|${language}|${JSON.stringify(options)}`
  let formatter = cache.get(key) as T | undefined
  if (!formatter) {
    formatter = create()
    cache.set(key, formatter)
  }
  return formatter
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Fecha absoluta para paneles y fichas (R5). Devuelve `""` si la fecha no es válida. */
export function formatDate(value: DateInput, language: Language, style: DateStyle = "datetime"): string {
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return ""
  const options = DATE_OPTIONS[style]
  return cached("date", language, options, () => new Intl.DateTimeFormat(language, options)).format(date)
}

const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.345],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
]

/**
 * Fecha relativa para listas (R5): «hace 12 min», «ayer», «en 2 h».
 * Menos de 45 s en cualquier dirección se muestra como «ahora».
 */
export function formatRelative(value: DateInput, language: Language, now: DateInput = Date.now()): string {
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return ""
  const formatter = cached("relative", language, {}, () => new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" }))
  let amount = (date.getTime() - toDate(now).getTime()) / 1000
  if (Math.abs(amount) < 45) return formatter.format(0, "second")
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(amount) < size) return formatter.format(Math.round(amount), unit)
    amount /= size
  }
  return formatter.format(Math.round(amount), "year")
}

/** Número con separadores del idioma activo; acepta las opciones de `Intl.NumberFormat`. */
export function formatNumber(value: number, language: Language, options: Intl.NumberFormatOptions = {}): string {
  return cached("number", language, options, () => new Intl.NumberFormat(language, options)).format(value)
}

/** Enumeración natural: «a, b y c» / «a, b, and c». `disjunction` usa «o» / «or». */
export function formatList(items: readonly string[], language: Language, type: "conjunction" | "disjunction" = "conjunction"): string {
  return cached("list", language, { type }, () => new Intl.ListFormat(language, { type })).format(items)
}

/**
 * Sufijo plural de i18next (`one` u `other`) para `count`.
 * Las categorías CLDR distintas de `one` (por ejemplo `many` en español para 1 000 000) se reducen a `other`.
 */
export function pluralSuffix(count: number, language: Language): "one" | "other" {
  const rules = cached("plural", language, {}, () => new Intl.PluralRules(language))
  return rules.select(count) === "one" ? "one" : "other"
}
