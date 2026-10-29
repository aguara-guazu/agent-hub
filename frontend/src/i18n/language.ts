import { useSyncExternalStore } from "react"
import i18n from "i18next"
import type { Language, LanguagePreference } from "./types"

/** Clave de localStorage; el mismo origen guarda ahí la sesión (`agenthub.token`). */
export const LANGUAGE_STORAGE_KEY = "agenthub.language"

export const LANGUAGES: readonly Language[] = ["es", "en"]

const PREFERENCES: readonly LanguagePreference[] = ["es", "en", "auto"]

const listeners = new Set<() => void>()

/** `true` si el valor es una preferencia válida. */
export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === "string" && (PREFERENCES as readonly string[]).includes(value)
}

/** Preferencia guardada, o `auto` si no hay ninguna o el almacenamiento no está disponible. */
export function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguagePreference(stored) ? stored : "auto"
  } catch {
    return "auto"
  }
}

/** Primer idioma del sistema que la interfaz soporta; `es` si ninguno coincide. */
export function systemLanguage(): Language {
  const candidates = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of candidates) {
    const base = tag?.toLowerCase().split("-")[0]
    if (base === "es" || base === "en") return base
  }
  return "es"
}

/** Idioma efectivo para una preferencia: la fija, o la del sistema si es `auto`. */
export function resolveLanguage(preference: LanguagePreference): Language {
  return preference === "auto" ? systemLanguage() : preference
}

/** Cambia el idioma de i18next en caliente y actualiza `<html lang>`. */
export function applyLanguage(language: Language): void {
  if (typeof document !== "undefined") document.documentElement.lang = language
  if (i18n.language !== language) void i18n.changeLanguage(language)
}

/** Guarda la preferencia, la aplica, avisa a los suscriptores y, en escritorio, la pasa al proceso principal. */
export function setLanguagePreference(preference: LanguagePreference): void {
  storePreference(preference)
  void window.agentHub?.setLanguage?.(preference).catch(() => undefined)
}

function storePreference(preference: LanguagePreference): void {
  try {
    if (preference === "auto") localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  } catch {
    /* sin almacenamiento la elección dura hasta cerrar la ventana */
  }
  current = preference
  applyLanguage(resolveLanguage(preference))
  listeners.forEach(listener => listener())
}

let current: LanguagePreference = readLanguagePreference()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Preferencia actual y su setter; re-renderiza al cambiar desde cualquier lugar. */
export function useLanguagePreference(): [LanguagePreference, (preference: LanguagePreference) => void] {
  const preference = useSyncExternalStore(subscribe, () => current, () => current)
  return [preference, setLanguagePreference]
}

/**
 * En escritorio manda la preferencia que guarda el proceso principal; localStorage queda como copia para el arranque
 * síncrono. Si el escritorio no tiene ninguna (`auto`) y localStorage sí, es una elección previa al puente: se le pasa.
 */
function syncFromDesktop(): void {
  const bridge = window.agentHub
  if (!bridge?.getLanguage) return
  void bridge.getLanguage().then(stored => {
    if (!isLanguagePreference(stored)) return
    if (stored === "auto" && current !== "auto") void bridge.setLanguage?.(current).catch(() => undefined)
    else if (stored !== current) storePreference(stored)
  }).catch(() => undefined)
}

/**
 * Sigue cambios externos: el idioma del sistema (si la preferencia es `auto`) y
 * otra ventana del mismo origen que modifique la preferencia guardada.
 */
export function watchLanguageSources(): () => void {
  if (typeof window === "undefined") return () => undefined
  syncFromDesktop()
  const onSystemChange = () => { if (current === "auto") applyLanguage(systemLanguage()) }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANGUAGE_STORAGE_KEY) return
    current = readLanguagePreference()
    applyLanguage(resolveLanguage(current))
    listeners.forEach(listener => listener())
  }
  window.addEventListener("languagechange", onSystemChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener("languagechange", onSystemChange)
    window.removeEventListener("storage", onStorage)
  }
}
