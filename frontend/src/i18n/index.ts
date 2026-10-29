import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./locales/en"
import es from "./locales/es"
import { LANGUAGES, applyLanguage, readLanguagePreference, resolveLanguage, watchLanguageSources } from "./language"
import type { Namespace } from "./types"

const initialLanguage = resolveLanguage(readLanguagePreference())

void i18n.use(initReactI18next).init({
  resources: { es, en },
  lng: initialLanguage,
  fallbackLng: "en",
  supportedLngs: [...LANGUAGES],
  ns: Object.keys(es) as Namespace[],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
})

applyLanguage(initialLanguage)
watchLanguageSources()

export default i18n
export { useT, useFormat } from "./useT"
export { useLanguagePreference, setLanguagePreference, resolveLanguage, systemLanguage, LANGUAGE_STORAGE_KEY } from "./language"
export { formatDate, formatRelative, formatNumber, formatList, pluralSuffix } from "./format"
export { errorKey } from "./errors"
export type { Language, LanguagePreference, Namespace, PluralKey } from "./types"
