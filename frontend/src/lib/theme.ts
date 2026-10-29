import { useCallback, useEffect, useSyncExternalStore } from "react"

export type ThemePreference = "system" | "dark" | "light"
export type Theme = "dark" | "light"

const STORAGE_KEY = "agenthub.theme"
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "dark" || value === "light" ? value : "system"
  } catch {
    return "system"
  }
}

let preference: ThemePreference = typeof window === "undefined" ? "system" : readPreference()

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

function emit() {
  for (const listener of listeners) listener()
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Sin almacenamiento la preferencia dura hasta recargar.
  }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const media = window.matchMedia?.("(prefers-color-scheme: light)")
  media?.addEventListener("change", listener)
  return () => {
    listeners.delete(listener)
    media?.removeEventListener("change", listener)
  }
}

function snapshot(): string {
  return `${preference}:${preference === "system" ? systemTheme() : preference}`
}

function themeClass(theme: Theme): string {
  return theme === "light" ? "t-light" : "t-dark"
}

/** Tema resuelto (t-dark | t-light en el shell) y la preferencia guardada. */
export function useTheme() {
  const value = useSyncExternalStore(subscribe, snapshot, () => "system:dark")
  const [pref, resolved] = value.split(":") as [ThemePreference, Theme]
  useEffect(() => {
    // Los estilos legacy leen data-theme en <html>; el sistema nuevo, la clase del shell.
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.colorScheme = resolved
  }, [resolved])
  const toggle = useCallback(() => setThemePreference(resolved === "dark" ? "light" : "dark"), [resolved])
  return { preference: pref, theme: resolved, className: themeClass(resolved), setPreference: setThemePreference, toggle }
}
