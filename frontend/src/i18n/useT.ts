import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { TOptions } from "i18next"
import { formatDate, formatList, formatNumber, formatRelative, pluralSuffix, type DateStyle } from "./format"
import type { Language, Namespace, PluralKey } from "./types"

/** Idioma efectivo de i18next acotado a los soportados. */
function asLanguage(value: string | undefined): Language {
  return value === "en" ? "en" : "es"
}

/**
 * Traducción tipada para un namespace.
 *
 * - `t("clave.anidada", { valor })`: clave verificada en compilación contra el diccionario en español.
 * - `plural("base", count, { valor })`: elige `base_one` o `base_other` con `Intl.PluralRules`; usalo en lugar de `t(key, { count })`.
 * - `language`: idioma activo (`es` | `en`); el componente se vuelve a renderizar cuando cambia.
 */
export function useT<N extends Namespace>(namespace: N) {
  const { t, i18n } = useTranslation(namespace)
  const language = asLanguage(i18n.resolvedLanguage ?? i18n.language)
  const plural = useCallback(
    (key: PluralKey<N>, count: number, options: TOptions = {}): string =>
      (i18n.t as (key: string, options: TOptions) => string)(`${key}_${pluralSuffix(count, language)}`, { ...options, ns: namespace, count }),
    [i18n, language, namespace],
  )
  return { t, plural, language }
}

/** Formateadores ligados al idioma activo; ver `format.ts` para el detalle de cada uno. */
export function useFormat() {
  const { i18n } = useTranslation()
  const language = asLanguage(i18n.resolvedLanguage ?? i18n.language)
  return useMemo(() => ({
    language,
    date: (value: Date | string | number, style?: DateStyle) => formatDate(value, language, style),
    relative: (value: Date | string | number, now?: Date | string | number) => formatRelative(value, language, now),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, language, options),
    list: (items: readonly string[], type?: "conjunction" | "disjunction") => formatList(items, language, type),
  }), [language])
}
