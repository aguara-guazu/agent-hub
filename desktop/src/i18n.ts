/**
 * Textos del proceso principal (bandeja, notificaciones, diálogos y resultados que llegan al renderer como `detail`).
 *
 * Módulo puro, sin Electron: el idioma activo arranca en `es` y lo fija `main.ts` con la preferencia guardada en
 * `userData/language`. Las pruebas corren con `es`. Interpolación con `{nombre}`; plurales con las claves `_one` y
 * `_other` y la variable `count`.
 */

export type Language = "es" | "en"
export type LanguagePreference = Language | "auto"

const es = {
  tray: {
    core: {
      running: "Core: en ejecución",
      starting: "Core: iniciando…",
      restarting: "Core: reiniciando…",
      stopping: "Core: deteniendo…",
      failed: "Core: con fallo",
      stopped: "Core: detenido",
    },
    show: "Abrir Agent Hub",
    hide: "Ocultar ventana",
    shortcut: "Mostrar/ocultar: {shortcut}",
    shortcutUnavailable: "Atajo no disponible: {shortcut}",
    autostart: "Iniciar al ingresar",
    restartCore: "Reiniciar core",
    restartClient: "Reiniciar Claude Desktop (cambios sin cargar)",
    quit: "Salir de Agent Hub",
    tooltip: "Agent Hub",
    tooltipShortcut: "Agent Hub · Mostrar/ocultar: {shortcut}",
  },
  autostartOffer: {
    message: "Iniciar Agent Hub al ingresar",
    detail: "Las automatizaciones solo corren mientras Agent Hub está abierto. Si lo iniciamos al ingresar, el brief de la mañana no depende de que lo abras vos.",
    accept: "Iniciar al ingresar",
    decline: "Ahora no",
  },
  clientRestart: {
    skillInstalled_one: "Skill instalada: {skills}",
    skillInstalled_other: "Skills instaladas: {skills}",
    skillInstalledBody_one: "Claude Desktop tiene que reiniciarse para verla. Hacé clic para reiniciarla ahora.",
    skillInstalledBody_other: "Claude Desktop tiene que reiniciarse para verlas. Hacé clic para reiniciarla ahora.",
    confirmTitle: "Reiniciar Claude Desktop",
    confirmDetail: "Se cierra y se vuelve a abrir Claude Desktop. Guardá lo que tengas a medias en la app.",
    confirmDetailPending: "Cambios pendientes: {changes}. Se cierra y se vuelve a abrir Claude Desktop. Guardá lo que tengas a medias en la app.",
    confirmAccept: "Reiniciar ahora",
    confirmDecline: "Más tarde",
    restarted: "Claude Desktop reiniciada",
    failed: "No se pudo reiniciar Claude Desktop",
    alreadyRunning: "Ya hay un reinicio en curso.",
    changesGeneric: "la lista de herramientas cambió",
    skillsAdded: "skills nuevas: {list}",
    skillsChanged: "skills actualizadas: {list}",
    skillsRemoved: "skills retiradas: {list}",
    serversAdded: "servidores nuevos: {list}",
    serversRemoved: "servidores retirados: {list}",
    unsupported: "Agent Hub no sabe reiniciar {client} en {platform}.",
    didNotClose: "Claude Desktop no se cerró sola en 15 segundos. Cerrala a mano y volvé a abrirla para que cargue los cambios.",
    reopenFailed: "Claude Desktop se cerró pero no se pudo volver a abrir. Abrila desde Aplicaciones.",
    reopened: "Claude Desktop se cerró y se volvió a abrir.",
    opened: "Claude Desktop no estaba abierta y se abrió.",
  },
  storedPdf: {
    invalidId: "El identificador del archivo no es válido.",
    readFailed: "No se pudo leer el archivo (HTTP {status}).",
    notPdf: "El archivo no es un PDF.",
  },
  shortcut: {
    title: "Atajo de Agent Hub no disponible",
    body: "No se pudo activar {shortcut} para abrir Agent Hub. Puede estar reservado por otra app o el sistema no lo permite. Abrí Agent Hub desde el menú de aplicaciones o desde su icono.",
  },
  startup: {
    title: "Agent Hub no pudo iniciar",
    lastCoreError: "Último error del core:",
    logs: "Registros: {path}",
    reportNote: "El reporte filtra credenciales conocidas, emails y la carpeta del usuario. Revisalo antes de publicarlo en GitHub.",
    openIssue: "Abrir issue en GitHub",
    copyReport: "Copiar reporte",
    close: "Cerrar",
    portUnavailable: "El puerto {port} no se puede usar ({problem}) y tampoco {fallbacks}. En Windows, los rangos reservados se ven con «netsh interface ipv4 show excludedportrange protocol=tcp».",
  },
  schedules: {
    briefReady: "Brief listo",
    closeReady: "Cierre listo",
    openDelivery: "Abrí la entrega para verla.",
    unnamed: "una automatización",
    created: "Tu agente programó: {name}",
    createdBody: "Hacé clic para verla o cancelarla.",
    updated: "Tu agente cambió el horario: {name}",
    updatedBody: "Hacé clic para revisarla.",
    cancelled: "Tu agente canceló: {name}",
    cancelledBody: "Hacé clic para ver las automatizaciones.",
    batchCreated_one: "Tu agente programó {count} automatización",
    batchCreated_other: "Tu agente programó {count} automatizaciones",
    batchUpdated_one: "Tu agente cambió {count} automatización",
    batchUpdated_other: "Tu agente cambió {count} automatizaciones",
    batchCancelled_one: "Tu agente canceló {count} automatización",
    batchCancelled_other: "Tu agente canceló {count} automatizaciones",
    batchBody: "Hacé clic para verlas.",
  },
  updater: {
    githubHttp: "GitHub no pudo consultar las actualizaciones (HTTP {status}).",
    githubInvalid: "GitHub devolvió información de versión inválida.",
    githubUnreachable: "No se pudo consultar GitHub. Revisá la conexión y volvé a intentar.",
    downloadHttp: "La descarga falló con HTTP {status}.",
    badRange: "El servidor devolvió un rango de descarga inválido.",
    incomplete: "La descarga quedó incompleta. Volvé a intentar.",
    tooSmall: "El archivo descargado pesa {bytes} bytes; no parece un instalador.",
    hashMismatch: "La descarga no coincide con el SHA-256 publicado.",
    stalled: "La descarga se detuvo por falta de datos. Se reintentará automáticamente.",
    timedOut: "La descarga superó el tiempo máximo. Se reintentará automáticamente.",
    checkFailed: "No se pudo buscar la actualización.",
  },
}

type Messages<T> = { [K in keyof T]: T[K] extends string ? string : Messages<T[K]> }

const en: Messages<typeof es> = {
  tray: {
    core: {
      running: "Core: running",
      starting: "Core: starting…",
      restarting: "Core: restarting…",
      stopping: "Core: stopping…",
      failed: "Core: failed",
      stopped: "Core: stopped",
    },
    show: "Open Agent Hub",
    hide: "Hide window",
    shortcut: "Show/hide: {shortcut}",
    shortcutUnavailable: "Shortcut unavailable: {shortcut}",
    autostart: "Open at login",
    restartCore: "Restart core",
    restartClient: "Restart Claude Desktop (changes not loaded)",
    quit: "Quit Agent Hub",
    tooltip: "Agent Hub",
    tooltipShortcut: "Agent Hub · Show/hide: {shortcut}",
  },
  autostartOffer: {
    message: "Open Agent Hub at login",
    detail: "Automations only run while Agent Hub is open. If it opens at login, your morning brief does not depend on you opening it.",
    accept: "Open at login",
    decline: "Not now",
  },
  clientRestart: {
    skillInstalled_one: "Skill installed: {skills}",
    skillInstalled_other: "Skills installed: {skills}",
    skillInstalledBody_one: "Claude Desktop needs a restart to load it. Click to restart it now.",
    skillInstalledBody_other: "Claude Desktop needs a restart to load them. Click to restart it now.",
    confirmTitle: "Restart Claude Desktop",
    confirmDetail: "Claude Desktop will close and open again. Save any unfinished work in it first.",
    confirmDetailPending: "Pending changes: {changes}. Claude Desktop will close and open again. Save any unfinished work in it first.",
    confirmAccept: "Restart now",
    confirmDecline: "Later",
    restarted: "Claude Desktop restarted",
    failed: "Could not restart Claude Desktop",
    alreadyRunning: "A restart is already in progress.",
    changesGeneric: "the tool list changed",
    skillsAdded: "new skills: {list}",
    skillsChanged: "updated skills: {list}",
    skillsRemoved: "removed skills: {list}",
    serversAdded: "new servers: {list}",
    serversRemoved: "removed servers: {list}",
    unsupported: "Agent Hub cannot restart {client} on {platform}.",
    didNotClose: "Claude Desktop did not close within 15 seconds. Close it manually and open it again to load the changes.",
    reopenFailed: "Claude Desktop closed but could not open again. Open it from Applications.",
    reopened: "Claude Desktop closed and opened again.",
    opened: "Claude Desktop was not open, so it was opened.",
  },
  storedPdf: {
    invalidId: "The file identifier is not valid.",
    readFailed: "Could not read the file (HTTP {status}).",
    notPdf: "The file is not a PDF.",
  },
  shortcut: {
    title: "Agent Hub shortcut unavailable",
    body: "Could not enable {shortcut} to open Agent Hub. Another app may be using it or the system does not allow it. Open Agent Hub from the applications menu or its icon.",
  },
  startup: {
    title: "Agent Hub could not start",
    lastCoreError: "Last core error:",
    logs: "Logs: {path}",
    reportNote: "The report removes known credentials, emails and your user folder. Review it before posting it on GitHub.",
    openIssue: "Open GitHub issue",
    copyReport: "Copy report",
    close: "Close",
    portUnavailable: "Port {port} cannot be used ({problem}), and neither can {fallbacks}. On Windows, list reserved ranges with “netsh interface ipv4 show excludedportrange protocol=tcp”.",
  },
  schedules: {
    briefReady: "Brief ready",
    closeReady: "Daily close ready",
    openDelivery: "Open the delivery to view it.",
    unnamed: "an automation",
    created: "Your agent scheduled: {name}",
    createdBody: "Click to view or cancel it.",
    updated: "Your agent changed the schedule: {name}",
    updatedBody: "Click to review it.",
    cancelled: "Your agent cancelled: {name}",
    cancelledBody: "Click to view your automations.",
    batchCreated_one: "Your agent scheduled {count} automation",
    batchCreated_other: "Your agent scheduled {count} automations",
    batchUpdated_one: "Your agent changed {count} automation",
    batchUpdated_other: "Your agent changed {count} automations",
    batchCancelled_one: "Your agent cancelled {count} automation",
    batchCancelled_other: "Your agent cancelled {count} automations",
    batchBody: "Click to view them.",
  },
  updater: {
    githubHttp: "GitHub could not check for updates (HTTP {status}).",
    githubInvalid: "GitHub returned invalid version information.",
    githubUnreachable: "Could not reach GitHub. Check your connection and try again.",
    downloadHttp: "The download failed with HTTP {status}.",
    badRange: "The server returned an invalid download range.",
    incomplete: "The download is incomplete. Try again.",
    tooSmall: "The downloaded file is {bytes} bytes and does not look like an installer.",
    hashMismatch: "The download does not match the published SHA-256.",
    stalled: "The download stalled with no data. It will retry automatically.",
    timedOut: "The download took too long. It will retry automatically.",
    checkFailed: "Could not check for updates.",
  },
}

type LeafKeys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : LeafKeys<T[K], `${P}${K}.`>
}[keyof T & string]

type Key = LeafKeys<typeof es>
type PluralBaseOf<K> = K extends `${infer Base}_one` ? Base : never
type PluralBase = PluralBaseOf<Key>
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Falla la compilación si `en` no tiene exactamente las claves de `es`. */
const parity: SameKeys<Key, LeafKeys<typeof en>> = true
void parity

export type MessageKey = Exclude<Key, `${string}_one` | `${string}_other`> | PluralBase
export type MessageVars = Record<string, string | number>

const DICTIONARIES: Record<Language, Messages<typeof es>> = { es, en }

let active: Language = "es"
const listeners = new Set<(language: Language) => void>()

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "es" || value === "en" || value === "auto"
}

/** Idioma efectivo: el fijo, o la base del locale del sistema si es `es`/`en`; `es` para cualquier otro. */
export function resolveLanguage(preference: LanguagePreference, systemLocale: string | undefined): Language {
  if (preference !== "auto") return preference
  const base = systemLocale?.toLowerCase().split(/[-_]/)[0]
  return base === "en" ? "en" : "es"
}

export function activeLanguage(): Language {
  return active
}

/** Cambia el idioma activo y avisa a los suscriptores (bandeja, tooltip) sólo si cambió. */
export function setActiveLanguage(language: Language): void {
  if (language === active) return
  active = language
  for (const listener of listeners) listener(language)
}

export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function lookup(dictionary: Messages<typeof es>, key: string): string | undefined {
  let node: unknown = dictionary
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part]
  return typeof node === "string" ? node : undefined
}

/** Texto en el idioma activo; con `count` y una clave plural elige `_one` (count = 1) u `_other`. */
export function t(key: MessageKey, vars: MessageVars = {}): string {
  const dictionary = DICTIONARIES[active]
  const count = vars.count
  const template = (typeof count === "number" ? lookup(dictionary, `${key}_${count === 1 ? "one" : "other"}`) : undefined)
    ?? lookup(dictionary, key)
    ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match)
}
