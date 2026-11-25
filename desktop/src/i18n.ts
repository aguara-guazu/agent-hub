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
    cancelQuit: "Cancelar cierre",
    quitWaiting: "Cerrando: esperando a los líderes · gracia en {time}",
    quitGrace: "Cerrando: período de gracia · cierre forzado en {time}",
    quitForced: "Cerrando: cierre forzado en curso",
    quitClosing: "Cerrando: deteniendo a los equipos",
    tooltip: "Agent Hub",
    tooltipShortcut: "Agent Hub · Mostrar/ocultar: {shortcut}",
    recordStart: "Grabar reunión",
    recordWindow: "Elegir ventana para identificar voces…",
    recordTab: "Elegir pestaña de la reunión web",
    recordStop: "Detener grabación",
    recording: "Grabando: {title}",
  },
  recording: {
    noWindow: "No se pudo leer la ventana de la llamada. Revisá los permisos de pantalla y el módulo OCR en Ajustes. El audio sigue grabándose.",
    autoSpeaker: "Detectar el indicador automáticamente",
    markSpeaker: "Marcar dónde aparece el nombre de quien habla…",
    markHint: "Arrastrá sobre el nombre que cambia con quien habla. Presioná Esc para cancelar.",
    noVisual: "Continuar solo con audio",
    tabHint: "Elegí la pestaña de Zoom, Teams u otra reunión. Si la llamada está en otro navegador o perfil, copiá allí la dirección de esta página. Google Meet se procesa desde Calendario.",
    tabShare: "Seleccionar pestaña",
    tabStop: "Dejar de compartir pestaña",
    tabSharing: "El Hub está leyendo el indicador de quien habla en la pestaña elegida. Podés trabajar en otras pestañas.",
    tabStopped: "Se detuvo la lectura de la pestaña. El Hub puede seguir grabando el audio.",
    tabEnded: "Terminó la conexión con esta grabación. Podés cerrar esta página.",
    tabFallback: "No se compartió una pestaña de reunión. Podés volver a elegirla. Si tu navegador solo ofrece ventanas, separá la llamada en su propia ventana y usá «Elegir ventana para identificar voces» en el Hub.",
    tabBusy: "La pestaña ya está vinculada en otra página o la grabación terminó. Volvé a elegir la pestaña desde el Hub.",
    tabOcrFailed: "No se pudo leer el indicador de la pestaña. Revisá el módulo OCR en el Hub y volvé a elegir la pestaña desde la barra de menú.",
    manualTitle: "Reunión del {date}",
    micDeniedTitle: "Falta el permiso de micrófono",
    micDeniedBody: "Habilitá Agent Hub en Ajustes del Sistema → Privacidad y seguridad → Micrófono y volvé a intentar.",
    failedTitle: "No se pudo grabar",
    failedBody: "Agent Hub no logró abrir el micrófono ni el audio del sistema.",
    savedTitle: "Grabación guardada",
    incompleteTitle: "La grabación quedó incompleta",
    incompleteBody: "Se recuperará el audio disponible de {title}. Puede faltar una parte de la reunión.",
    storageFailedTitle: "La grabación se detuvo por un problema al guardar",
    storageFailedBody: "No se pudo escribir todo el audio. Revisá el espacio y los permisos del disco. Se intentará recuperar lo que llegó a guardarse.",
    savedBody: "{title} · {minutes} min",
    emptyTitle: "No quedó audio grabado",
    emptyBody: "La grabación se detuvo antes de recibir audio.",
    limitTitle: "La grabación llegó al máximo",
    limitBody: "Se detuvo a las 3 horas, que es el tope por grabación.",
    untitled: "Reunión sin título",
    offerTitle: "{title} no tendrá transcripción",
    offerBody: "Empieza a las {time}. Abrí Agent Hub para decidir si la grabás.",
    offerBodyPlatform: "Empieza a las {time} por {platform}. Abrí Agent Hub para decidir si la grabás.",
    endedTitle: "Terminó el horario de la reunión",
    endedBody: "«{title}» sigue grabándose. ¿Querés detener la grabación?",
    endContinue: "Seguir grabando",
    endStop: "Detener y guardar",
    silenceTitle: "La grabación sigue en curso",
    chooseCalendar: "Hay reuniones superpuestas en el calendario",
    visualTitle: "Identificar quién habla",
    visualHint: "Elegí la ventana o pestaña de la reunión para leer el nombre de quien habla.",
    chooseCalendarBody: "El audio se está grabando. Elegí el evento en Inicio › Pendientes para recibir el aviso de fin.",
    silenceBody: "No se escucha a nadie en {title} hace 5 minutos. Detenela si la reunión terminó.",
    remoteSilenceBody: "Hace 5 minutos que no se detecta audio de la llamada en «{title}». ¿Querés seguir grabando?",
    trackLostTitle: "Se cortó una parte de la grabación",
    micLostBody: "El micrófono dejó de grabar. La grabación sigue solo con el audio de la llamada.",
    systemLostBody: "El audio de la llamada dejó de grabarse. La grabación sigue solo con el micrófono.",
    linuxSystemLost: "La grabación sigue con el micrófono. Para captar la salida, comprobá que esté disponible pw-record con PipeWire o parec con PulseAudio.",
    captureLostTitle: "La grabación se detuvo",
    captureLostBody: "Se cortaron el micrófono y el audio de la llamada. Se guardó lo grabado hasta ese momento.",
    rejectedTitle: "No se pudo guardar una grabación",
    rejectedBody: "{title} no entró a la memoria. El audio quedó apartado en este equipo durante 30 días.",
    systemSilentTitle: "No llega el audio de la llamada",
    systemSilentBody: "Solo se está grabando el micrófono. Revisá en Ajustes del Sistema → Privacidad y seguridad que Agent Hub pueda grabar el audio del sistema.",
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
    untrustedUrl: "La descarga apunta a un origen no permitido ({host}).",
    versionInvalid: "La versión «{version}» no es un SemVer válido.",
    sizeMissing: "La release no publica el tamaño del archivo para verificar la descarga.",
    stateCorrupt: "El estado de las actualizaciones está dañado; no se actualiza hasta revisarlo.",
    trustInvalid: "El conjunto de claves de actualización de esta instalación no es válido.",
    tooManyRedirects: "La descarga tuvo demasiadas redirecciones.",
    manifestInvalid: "El manifiesto de la actualización no es válido.",
    manifestMissing: "La release no incluye el manifiesto firmado de la actualización.",
    signatureInvalid: "La firma del manifiesto de la actualización no es válida.",
    digestMissing: "La release no publica un SHA-256 para verificar la descarga.",
    bundleMismatch: "La aplicación descargada no es Agent Hub.",
    versionMismatch: "La versión de la aplicación descargada no coincide con la release.",
    codesignInvalid: "La firma de la aplicación descargada no es coherente.",
    archMismatch: "La aplicación descargada no es para la arquitectura de este equipo.",
    helperInvalid: "No se puede aplicar la actualización: falta el instalador atómico o no es válido.",
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
    cancelQuit: "Cancel quit",
    quitWaiting: "Quitting: waiting for the leaders · grace period in {time}",
    quitGrace: "Quitting: grace period · forced close in {time}",
    quitForced: "Quitting: forced close in progress",
    quitClosing: "Quitting: stopping the teams",
    tooltip: "Agent Hub",
    tooltipShortcut: "Agent Hub · Show/hide: {shortcut}",
    recordStart: "Record meeting",
    recordWindow: "Choose call window to identify voices…",
    recordTab: "Choose web meeting tab",
    recordStop: "Stop recording",
    recording: "Recording: {title}",
  },
  recording: {
    noWindow: "Could not read the call window. Check screen permissions and the OCR module in Settings. Audio recording continues.",
    autoSpeaker: "Detect the speaker indicator automatically",
    markSpeaker: "Select the active speaker name area…",
    markHint: "Drag over the name that changes when the speaker changes. Press Esc to cancel.",
    noVisual: "Continue with audio only",
    tabHint: "Select the tab for Zoom, Teams or another meeting. If your call is in a different browser or profile, copy this page’s address there. Google Meet is processed through Calendar.",
    tabShare: "Select tab",
    tabStop: "Stop sharing tab",
    tabSharing: "The Hub is reading the active speaker indicator in the selected tab. You can work in other tabs.",
    tabStopped: "Tab sharing stopped. The Hub can continue recording audio.",
    tabEnded: "The connection to this recording ended. You can close this page.",
    tabFallback: "A meeting tab was not shared. You can select it again. If your browser only offers windows, move the call to its own window and use “Choose call window to identify voices” in the Hub.",
    tabBusy: "Another page already linked the tab, or recording ended. Choose the tab again from the Hub.",
    tabOcrFailed: "The tab’s speaker indicator could not be read. Check the OCR module in the Hub and select the tab again from the tray menu.",
    manualTitle: "Meeting on {date}",
    micDeniedTitle: "Microphone permission is missing",
    micDeniedBody: "Enable Agent Hub in System Settings → Privacy & Security → Microphone and try again.",
    failedTitle: "Recording could not start",
    failedBody: "Agent Hub could not open the microphone or the system audio.",
    savedTitle: "Recording saved",
    incompleteTitle: "The recording is incomplete",
    incompleteBody: "The available audio from {title} will be recovered. Part of the meeting may be missing.",
    storageFailedTitle: "Recording stopped because audio could not be saved",
    storageFailedBody: "Some audio could not be written. Check disk space and permissions. Any audio already saved will be recovered where possible.",
    savedBody: "{title} · {minutes} min",
    emptyTitle: "No audio was recorded",
    emptyBody: "The recording stopped before any audio arrived.",
    limitTitle: "The recording reached its limit",
    limitBody: "It stopped at 3 hours, the maximum per recording.",
    untitled: "Untitled meeting",
    offerTitle: "{title} will have no transcript",
    offerBody: "It starts at {time}. Open Agent Hub to decide whether to record it.",
    offerBodyPlatform: "It starts at {time} on {platform}. Open Agent Hub to decide whether to record it.",
    endedTitle: "The scheduled meeting time has ended",
    endedBody: "“{title}” is still being recorded. Would you like to stop recording?",
    endContinue: "Keep recording",
    endStop: "Stop and save",
    silenceTitle: "The recording is still running",
    chooseCalendar: "There are overlapping calendar meetings",
    visualTitle: "Identify who is speaking",
    visualHint: "Choose the meeting window or tab to read the active speaker’s name.",
    chooseCalendarBody: "Audio is recording. Choose the event in Home › Pending to get its end reminder.",
    silenceBody: "Nobody has been heard in {title} for 5 minutes. Stop it if the meeting is over.",
    remoteSilenceBody: "No call audio has been detected in “{title}” for 5 minutes. Keep recording?",
    trackLostTitle: "Part of the recording was cut",
    micLostBody: "The microphone stopped recording. The recording continues with the call audio only.",
    systemLostBody: "The call audio stopped recording. The recording continues with the microphone only.",
    linuxSystemLost: "Recording continues with the microphone. To capture output, check that pw-record with PipeWire or parec with PulseAudio is available.",
    captureLostTitle: "The recording stopped",
    captureLostBody: "Both the microphone and the call audio were cut. What was recorded until then was saved.",
    rejectedTitle: "A recording could not be saved",
    rejectedBody: "{title} did not reach the memory. Its audio is set aside on this computer for 30 days.",
    systemSilentTitle: "The call audio is not arriving",
    systemSilentBody: "Only the microphone is being recorded. Check in System Settings → Privacy & Security that Agent Hub may record system audio.",
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
    untrustedUrl: "The download points to a disallowed origin ({host}).",
    versionInvalid: "Version \"{version}\" is not valid SemVer.",
    sizeMissing: "The release does not publish the file size to verify the download.",
    stateCorrupt: "The update state is damaged; updates are paused until it is reviewed.",
    trustInvalid: "This installation's update key set is not valid.",
    tooManyRedirects: "The download had too many redirects.",
    manifestInvalid: "The update manifest is not valid.",
    manifestMissing: "The release does not include the signed update manifest.",
    signatureInvalid: "The update manifest signature is not valid.",
    digestMissing: "The release does not publish a SHA-256 to verify the download.",
    bundleMismatch: "The downloaded application is not Agent Hub.",
    versionMismatch: "The downloaded application version does not match the release.",
    codesignInvalid: "The downloaded application signature is not consistent.",
    archMismatch: "The downloaded application is not for this machine's architecture.",
    helperInvalid: "The update cannot be applied: the atomic installer is missing or invalid.",
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
