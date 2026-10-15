import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { check, localPath } from './contracts.js'
import { GMAIL_SCOPE, GOOGLE_SCOPES, type GoogleAuth } from './google-auth.js'
import type { MemoryStore } from './store.js'

/**
 * Configuración guiada de Google para la memoria: constantes que consumen las operaciones
 * `google_setup_status` e `import_google_client`, y la skill de fábrica `google-setup` que
 * enseña al agente a recorrer el alta en Google Cloud junto con la persona.
 *
 * Los identificadores de servicio son los de `gcloud services enable`; la fuente de cada uno
 * está en los enlaces del cuerpo de la skill.
 */
export interface GoogleApi {
  service: string
  name: string
  purpose: string
}

/** APIs que usa el conector Google de la memoria (Calendar, Meet, Drive, Docs, People y Gmail). */
export const GOOGLE_SETUP_APIS: readonly GoogleApi[] = [
  { service: 'calendar-json.googleapis.com', name: 'Google Calendar API', purpose: 'Invitaciones, invitados y horarios de las reuniones' },
  { service: 'meet.googleapis.com', name: 'Google Meet REST API', purpose: 'Registros de conferencias, participantes y transcripciones recientes' },
  { service: 'drive.googleapis.com', name: 'Google Drive API', purpose: 'Listar documentos de las carpetas configuradas' },
  { service: 'docs.googleapis.com', name: 'Google Docs API', purpose: 'Leer documentos y transcripciones conservadas' },
  { service: 'people.googleapis.com', name: 'People API', purpose: 'Resolver emails de participantes por contactos y directorio' },
  { service: 'gmail.googleapis.com', name: 'Gmail API', purpose: 'Correos recibidos y enviados de las fuentes con Gmail activado' },
]

/**
 * APIs adicionales para los MCP servers remotos de Google Workspace que el hub puede
 * proxear (Gmail, Calendar y Drive); cada producto exige su API, ya incluida en
 * GOOGLE_SETUP_APIS, y su variante MCP.
 */
export const GOOGLE_MCP_APIS: readonly GoogleApi[] = [
  { service: 'gmailmcp.googleapis.com', name: 'Gmail MCP', purpose: 'MCP server remoto de Gmail' },
  { service: 'calendarmcp.googleapis.com', name: 'Google Calendar MCP', purpose: 'MCP server remoto de Calendar' },
  { service: 'drivemcp.googleapis.com', name: 'Google Drive MCP', purpose: 'MCP server remoto de Drive' },
]

export const GOOGLE_SETUP_SCOPES: readonly string[] = [...GOOGLE_SCOPES, GMAIL_SCOPE]

export interface GoogleClientFile {
  type: 'installed' | 'web'
  client_id: string
  client_secret?: string
  project_id?: string
}

/**
 * Lee el JSON de cliente OAuth que descarga Google Cloud («Descargar JSON» en Clientes).
 * Acepta la forma `{ installed: {...} }` (Aplicación de escritorio) y `{ web: {...} }`.
 * La ruta debe ser absoluta y el archivo un `.json` de menos de 64 KiB; el contenido sólo
 * sale de acá hacia el Vault, nunca hacia la respuesta de la operación.
 */
export function readGoogleClientFile(input: string): GoogleClientFile {
  const path = localPath(input, 'Indique la ruta absoluta del archivo JSON descargado de Google Cloud (en Windows, con letra de unidad: C:\\Users\\...)')
  check(extname(path).toLowerCase() === '.json', 'El archivo del cliente OAuth debe ser un .json')
  let size = 0
  try { size = statSync(path).size } catch { check(false, 'No se encontró el archivo del cliente OAuth en esa ruta', 404) }
  check(size > 0 && size <= 65_536, 'El archivo no tiene el tamaño de un cliente OAuth de Google')
  let parsed: any
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { check(false, 'El archivo no es un JSON válido') }
  const type: GoogleClientFile['type'] | null = parsed?.installed ? 'installed' : parsed?.web ? 'web' : null
  check(type, 'El JSON no tiene la forma de un cliente OAuth de Google (falta la clave installed o web)')
  const client = parsed[type]
  check(typeof client.client_id === 'string' && client.client_id.length > 0 && client.client_id.length <= 1000, 'El cliente OAuth no tiene client_id')
  check(client.client_secret === undefined || (typeof client.client_secret === 'string' && client.client_secret.length <= 2000), 'El client_secret del archivo no es válido')
  return { type, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    ...(typeof client.project_id === 'string' ? { project_id: client.project_id } : {}) }
}

/**
 * Returns the oldest Google source, creating it when none exists: Calendar (`primary`), Meet and Gmail on,
 * paused until its account is authorized (see activateGoogleSource).
 */
export async function ensureGoogleSource(store: MemoryStore): Promise<{ id: string; config: Record<string, any> }> {
  const existing = (await store.db.query("SELECT id,config FROM connectors WHERE provider='google' ORDER BY created_at LIMIT 1"))[0]
  if (existing) return existing as { id: string; config: Record<string, any> }
  return (await store.db.query(`INSERT INTO connectors(id,provider,name,config,project_ids,enabled,interval_minutes) VALUES($1,'google','Google',$2,$3,$4,30)
    RETURNING id,config`, [randomUUID(), JSON.stringify({ calendars: ['primary'] }), [], false]))[0] as { id: string; config: Record<string, any> }
}

/** After a successful authorization the source is turned on and its sync, plus the mailbox listing when Gmail was granted, start at once. */
export async function activateGoogleSource(store: MemoryStore, google: GoogleAuth, connectorId: string): Promise<void> {
  const row = (await store.db.query("UPDATE connectors SET enabled=1,last_error=NULL,updated_at=now() WHERE id=$1 AND provider='google' RETURNING id,config", [connectorId]))[0]
  if (!row) return
  await store.enqueue('sync', { connector_id: connectorId }, `sync:${connectorId}`)
  if (row.config.gmail_enabled !== false && google.granted(connectorId, GMAIL_SCOPE)) await store.enqueue('gmail', { connector_id: connectorId }, `gmail:${connectorId}`)
}

export const GOOGLE_SETUP_SKILL_SLUG = 'google-setup'
export const GOOGLE_SETUP_SKILL_DISPLAY_NAME = 'Configurar Google para la memoria'
export const GOOGLE_SETUP_SKILL_DESCRIPTION = 'Instalación de Google para la memoria de Agent Hub hecha por el agente (computer use sobre el navegador o gcloud): proyecto de Google Cloud, APIs (Calendar, Meet, Drive, Docs, People, Gmail), pantalla de consentimiento, cliente OAuth de escritorio, carga con memory_import_google_client (crea la fuente y da la autorización) y conexión de la cuenta. Usar cuando falte el cliente de Google, una fuente Google no conecte, haya errores de OAuth o de API deshabilitada, o al instalar Agent Hub en otra computadora.'

const apiList = (apis: readonly GoogleApi[]) => apis.map(api => `- \`${api.service}\` (${api.name}): ${api.purpose}.`).join('\n')
const services = (apis: readonly GoogleApi[]) => apis.map(api => api.service).join(' ')

export function renderGoogleSetupSkill(): string {
  return `# Configurar Google para la memoria de Agent Hub

La memoria de Agent Hub lee Calendar, Meet, Drive, Docs y, en las fuentes que lo activan, Gmail con un **cliente OAuth de escritorio** que la persona crea en su propio proyecto de Google Cloud. Esta skill es una instalación **hecha por el agente**: el agente ejecuta todo lo que puede (herramientas \`memory_*\`, \`gcloud\`, y la consola de Google Cloud en el navegador cuando tiene computer use) y verifica cada paso antes de seguir. A la persona sólo le quedan las decisiones (cuenta y proyecto) y lo que Google exige que haga ella.

Las herramientas llegan por el servidor \`hub\` con nombres \`memory_<operación>\` (según el cliente, con un prefijo como \`mcp__hub__\`). Si \`memory_google_setup_status\` no existe, la app de Agent Hub instalada es anterior a esta skill: pedir a la persona que la actualice y seguir con la UI del hub (Memoria → Fuentes y ajustes) como alternativa manual.

## Reglas de esta skill

- **Ningún secreto pasa por la conversación.** El client secret y los tokens viajan del archivo JSON descargado al hub con \`memory_import_google_client\`, o se pegan en la UI del hub. No pedir que peguen el secreto en el chat, no leer el JSON con herramientas de archivos, no escribirlo en notas ni en la memoria. Si aparece uno en pantalla, decir que no se guarda y seguir.
- **Hacerlo, no delegarlo.** Orden de preferencia para cada paso de Google Cloud: (1) **computer use** sobre el navegador de la persona si el cliente lo ofrece (por ejemplo \`orca computer\` de Orca: abrir la URL con \`open -a <navegador> "<url>"\` en macOS o \`Start-Process "<url>"\` en Windows y operar la página); (2) \`gcloud\` si está instalado y autenticado; (3) sólo como último recurso, pasar a la persona el enlace exacto y qué tocar. Pedir una sola vez, al empezar, permiso para operar el navegador.
- **Un paso a la vez.** Hacer, comprobar el resultado con una herramienta, una captura o un comando, y recién entonces seguir. Si algo falla, ir a «Errores frecuentes» antes de improvisar.
- **Preguntar sólo lo que es decisión de la persona:** la cuenta de Google y si usar un proyecto existente o crear uno. El resto tiene valor por defecto en esta skill.
- La pantalla de permisos de Google la acepta la persona; el agente puede pulsar «Permitir» sólo si la persona le pidió hacer la conexión completa.
- La persona ejecuta en su terminal los comandos interactivos (por ejemplo \`gcloud auth login\`); en Claude Code puede escribirlos con el prefijo \`!\`.
- Citar la documentación de Google (enlaces al final) cuando se afirme un límite o un requisito.

## Paso 0. Diagnóstico

Llamar a \`memory_google_setup_status\`. Devuelve \`client_configured\` (si ya hay cliente OAuth), \`client_id\`, \`redirect_url\` (la URL de retorno que usa la memoria), \`apis\` y \`scopes\` requeridos, y \`connectors\`: cada fuente Google con \`enabled\`, \`connected\` (tiene token) y \`last_error\`.

- Si \`client_configured\` es \`true\` y la fuente está \`connected\` sin \`last_error\`: no hay nada que instalar; ofrecer \`memory_sync_connector\` y terminar.
- Si \`client_configured\` es \`true\` pero la fuente no está conectada, o \`gmail_authorized\` es \`false\`: ir al paso 6.
- Si \`last_error\` dice «Falta habilitar <servicio> en el proyecto de Google Cloud: <enlace>»: abrir ese enlace y pulsar **Habilitar** (paso 3); después \`memory_sync_connector\`.
- Si no hay cliente: seguir con el paso 1.

Comprobar también si la memoria está lista (\`memory_processing_status\` responde), si hay computer use disponible y si \`gcloud\` está instalado (\`gcloud --version\`). Con computer use no hace falta instalar \`gcloud\`.

## Paso 1. Cuenta y audiencia

Preguntar con qué cuenta de Google se van a leer reuniones y correos. La audiencia de la pantalla de consentimiento sale de esa respuesta, sin otra pregunta:

- **Cuenta de Google Workspace de una organización** (por ejemplo el dominio de la empresa): **Interna**, siempre. La app no pasa por verificación, no muestra la pantalla de «app no verificada» y no tiene el límite de 100 usuarios; los ámbitos restringidos como \`drive.readonly\` y \`gmail.readonly\` no requieren revisión. Es la opción recomendada.
- **Cuenta personal (@gmail.com)**: la única opción es **Externa**. En estado «Prueba» hay que agregar la cuenta como usuario de prueba, y Google emite tokens de actualización que **vencen a los 7 días**: la fuente dejará de sincronizar cada semana hasta reconectarla. Publicar la app a producción con \`drive.readonly\` o \`gmail.readonly\` (ámbitos restringidos) exige verificación y evaluación de seguridad. Decirlo antes de seguir y dejar que la persona decida.

Además, la persona que crea el proyecto necesita permiso para crear proyectos y habilitar servicios en Google Cloud (rol Propietario o Editor del proyecto alcanza). Si la organización restringe la creación de proyectos, hay que pedir uno al administrador de Google Cloud.

## Paso 2. Proyecto de Google Cloud

Preguntar si hay un proyecto existente para esto o se crea uno nuevo. Un solo proyecto puede alojar el cliente de la memoria y, si hace falta, los clientes de los MCP servers de Google del hub (paso 7).

Con \`gcloud\` (la persona ejecuta lo interactivo):

\`\`\`bash
gcloud auth login
gcloud projects create agent-hub-memoria-<sufijo> --name="Agent Hub memoria"
gcloud config set project agent-hub-memoria-<sufijo>
\`\`\`

El identificador es global y no se puede cambiar; sugerir uno con el nombre de la persona o del equipo. Si el proyecto ya existe: \`gcloud projects list\` para elegirlo y \`gcloud config set project <id>\`. No hace falta facturación: el uso estándar de estas APIs no tiene costo adicional (ver Calendar en las fuentes).

Sin \`gcloud\`: crear el proyecto en https://console.cloud.google.com/projectcreate (con computer use, completarlo el agente) y anotar el **ID del proyecto** (no el nombre) para construir los enlaces siguientes.

## Paso 3. Habilitar las APIs

Las APIs que usa la memoria:

${apiList(GOOGLE_SETUP_APIS)}

Con \`gcloud\`, un solo comando (el agente puede ejecutarlo si la sesión ya está autenticada):

\`\`\`bash
gcloud services enable ${services(GOOGLE_SETUP_APIS)} --project <id-del-proyecto>
gcloud services list --enabled --project <id-del-proyecto> | grep -E 'calendar|meet|drive|docs|people|gmail'
\`\`\`

En Windows (PowerShell), filtrar con \`Select-String -Pattern 'calendar|meet|drive|docs|people|gmail'\` en lugar de \`grep -E\`.

Sin \`gcloud\`: abrir cada una en la biblioteca de APIs, \`https://console.cloud.google.com/apis/library/<servicio>?project=<id-del-proyecto>\`, y pulsar **Habilitar** (con computer use, el agente; la página muestra «API habilitada» cuando ya lo está). Una API recién habilitada puede tardar unos minutos en aceptar llamadas. Si una falta, la primera sincronización lo dice con el servicio y el enlace exactos.

## Paso 4. Pantalla de consentimiento (Google Auth Platform)

Sólo se puede hacer en la consola web: con computer use la completa el agente; si no, entrega los enlaces con el proyecto ya seleccionado y verifica con la persona lo que ve.

1. **Branding**: https://console.cloud.google.com/auth/branding?project=<id-del-proyecto>. Si aparece «Comenzar», completar nombre de la app (por ejemplo «Agent Hub memoria»), email de asistencia y email de contacto del desarrollador.
2. **Audiencia** (https://console.cloud.google.com/auth/audience?project=<id-del-proyecto>): **Interna** o **Externa** según el paso 1. Si es Externa, agregar en **Usuarios de prueba** cada cuenta que se va a conectar.
3. **Acceso a los datos** (https://console.cloud.google.com/auth/scopes?project=<id-del-proyecto>): con audiencia Externa, agregar estos ámbitos con «Agregar o quitar permisos» (pegar la lista en el cuadro de entrada manual). Con audiencia Interna no es obligatorio listarlos, pero dejarlos declarados documenta qué pide la app:

${GOOGLE_SETUP_SCOPES.map(scope => `   - \`${scope}\``).join('\n')}

Estos son los ámbitos que la memoria puede solicitar al autorizar; \`gmail.readonly\` sólo se pide para las fuentes con Gmail activado. Ninguno permite escribir datos.

## Paso 5. Cliente OAuth de escritorio y carga en el hub

1. **Clientes**: https://console.cloud.google.com/auth/clients?project=<id-del-proyecto> → **Crear cliente** → Tipo de aplicación **Aplicación de escritorio** → nombre «Agent Hub memoria» → **Crear**. Si la consola muestra la casilla «Use this client for an AI-powered agent» (cliente para un agente con IA), dejarla **desmarcada**: la memoria llama a las APIs REST de Workspace, no a sus servidores MCP, y Google indica que esas apps no necesitan la marca. Desde el 12 de noviembre de 2026 la marca no se puede cambiar en un cliente existente; si se marcó por error, crear otro cliente y repetir este paso.
2. En el cuadro de confirmación (o desde la fila del cliente), **Descargar JSON**. El archivo se llama \`client_secret_<...>.json\` y suele quedar en \`~/Downloads\`.
3. Ubicar la descarga sin leer su contenido: \`ls -t ~/Downloads/client_secret*.json | head -1\` en macOS y Linux; en Windows (PowerShell), \`Get-ChildItem "$env:USERPROFILE\\Downloads\\client_secret*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1\`. No pedirle a la persona la ruta si se puede encontrar así.
4. Llamar a \`memory_import_google_client\` con \`path\` absoluto. Devuelve \`client_type\` (debe ser \`installed\`), \`client_id\`, \`project_id\` (confirmar que es el esperado), \`connector_id\` de la fuente Google (si no había una, la crea con Calendar \`primary\`, Meet y Gmail) y \`authorization_url\`. Si \`client_type\` es \`web\`, el cliente se creó con el tipo equivocado: crear uno de escritorio y repetir.
5. Borrar la descarga (\`rm <ruta>\`; en PowerShell, \`Remove-Item <ruta>\`): la copia que usa el hub ya está en un archivo privado dentro del directorio de la memoria (permisos \`0600\` en macOS y Linux; en Windows la protegen los permisos de la carpeta del perfil del usuario) y no entra en los respaldos.
6. Seguir directo con el paso 6, punto 2, usando esa \`authorization_url\`.

Alternativa sin agente: en el hub, Memoria → Fuentes y ajustes → **Configurar cliente OAuth** acepta el mismo JSON; al guardarlo crea la fuente y abre la autorización en el navegador.

## Paso 6. Fuente Google y autorización

1. La fuente Google la crea \`memory_import_google_client\` (paso 5) con los valores por defecto: Calendar \`primary\`, Meet y Gmail activados (correos recibidos y enviados; quedan afuera Promociones, Social, Spam, Papelera y borradores; después el buzón se revisa cada 2 minutos). No crearla a mano ni preguntar nada para crearla. La sincronización regular cubre siempre los **últimos 90 días** de Calendar y Gmail; no hay fecha de inicio que configurar.
2. Abrir la \`authorization_url\` en el navegador de la persona (\`open "<url>"\` en macOS, \`Start-Process "<url>"\` en Windows). Si venció (10 minutos) o hace falta reconectar, \`memory_connect_google\` con el \`connector_id\` da una nueva.
3. Se elige la cuenta del paso 1 y se aceptan los permisos (ver Reglas). Google vuelve al hub en la \`redirect_url\` y muestra «Google conectado a Agent Hub»: la fuente queda **activa** y la sincronización de Calendar y Meet y la primera revisión de Gmail arrancan solas. Con audiencia Externa en prueba aparece antes un aviso de app no verificada: «Continuar» es lo esperado.
4. Verificar con \`memory_google_setup_status\` que la fuente quedó \`enabled: true\`, \`connected: true\` y \`gmail_authorized: true\`, y seguir el progreso con \`memory_list_jobs\` (\`kind: "sync,gmail"\`). Si aparece \`last_error\`, ir a «Errores frecuentes».
5. Recién con todo andando, ofrecer los ajustes opcionales con \`memory_save_connector\`: \`project_ids\` de los proyectos de la memoria a los que vincular lo importado, \`folder_ids\` o \`document_ids\` de Drive con transcripciones históricas, otro \`name\` o \`gmail_enabled: false\` si la persona no quiere correos. Preguntar los valores; no inventarlos.
6. Si Google ya estaba conectado con menos permisos (por ejemplo sin People API, o la fuente se autorizó antes de que Gmail viniera activado: \`memory_list_connectors\` muestra \`gmail_authorized: false\`), reconectar con \`memory_connect_google\` y luego \`memory_repair_google\` para completar emails y hablantes de lo ya importado.
7. **Datos anteriores a 90 días, sólo a pedido de la persona.** \`memory_sync_connector\` con \`id\`, \`since\` (fecha \`AAAA-MM-DD\` o ISO 8601) y opcionalmente \`until\` (por defecto, ahora) importa los eventos de Calendar y los correos de Gmail de ese período, sin cambiar la sincronización regular. Meet conserva las intervenciones unos 30 días, así que de un período anterior sólo llegan las transcripciones adjuntas a los eventos como documentos de Docs. Antes de lanzarlo, avisar que cada correo e invitación pasa por el modelo de extracción y que un período largo puede tardar horas. El trabajo aparece en \`memory_list_jobs\` como «Sincronización de un período anterior».

## Paso 7 (opcional). MCP servers de Google del hub

Agent Hub también puede proxear los MCP servers remotos de Google Workspace (Gmail, Google Calendar y Google Drive). Google no admite registro dinámico de clientes para ellos, así que la tarjeta del server en la consola del hub muestra «Usar credenciales de cliente propias» y la **URL de retorno** del hub. Este cliente es distinto del de la memoria:

1. En el mismo proyecto, habilitar además la variante MCP de cada producto (las APIs de Gmail, Calendar y Drive ya se habilitaron en el paso 3):

${apiList(GOOGLE_MCP_APIS)}

   \`\`\`bash
   gcloud services enable ${services(GOOGLE_MCP_APIS)} --project <id-del-proyecto>
   \`\`\`

2. Crear un cliente de tipo **Aplicación web** con la URL de retorno que muestra la tarjeta del server como **URI de redireccionamiento autorizado** (Google exceptúa a localhost y a las direcciones IP de loopback de la obligación de HTTPS) y **marcar la casilla «Use this client for an AI-powered agent»**. Desde el 11 de noviembre de 2026 los servidores MCP de Workspace rechazan los clientes sin esa marca, y desde el 12 de noviembre la marca no se puede cambiar: un cliente web creado antes sin marcar se reemplaza por uno nuevo. Un mismo cliente web sirve para los tres servers y no debe usarse para la memoria: Google pide clientes separados para el tráfico de agentes y el tradicional.
3. Pegar client ID y client secret en la tarjeta del server, en la consola del hub (no hay herramienta para esto: el secreto no debe pasar por el agente), y luego «Conectar cuenta».

Los ámbitos que cada server solicita los define Google en su documentación (Gmail: \`gmail.readonly\` y \`gmail.compose\`; Drive: \`drive.readonly\` y \`drive.file\`; Calendar: \`calendar.calendarlist.readonly\`, \`calendar.events.freebusy\` y \`calendar.events.readonly\`). La documentación oficial describe la configuración para claude.ai y Antigravity; el hub usa su propia URL de retorno local, así que si la autorización falla en este paso, informarlo como una limitación a confirmar y no como un error de la persona.

## Errores frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| \`memory_connect_google\` responde «Configurá el client ID…» | No hay cliente OAuth cargado | Paso 5 |
| Google muestra \`redirect_uri_mismatch\` | El cliente no es de tipo Aplicación de escritorio (o, en el paso 7, falta la URL de retorno en el cliente web) | Crear el cliente con el tipo correcto y reimportar |
| Google muestra \`access_denied\` o «Esta app no está verificada» sin botón para continuar | Audiencia Externa sin la cuenta en usuarios de prueba, o cuenta de otra organización con audiencia Interna | Paso 4, punto 2 |
| Un server MCP de Google responde «the client isn't marked as an AI agent» | El cliente web del paso 7 no está marcado como agente | Antes del 12 de noviembre de 2026, marcar la casilla en el cliente; después, crear un cliente web nuevo marcado y reemplazar client ID y secret en la tarjeta del server |
| Google muestra \`admin_policy_enforced\` | El administrador de Workspace bloquea apps de terceros o estos ámbitos | Pedir al administrador que confíe en el cliente (por su client ID) en la consola de administración |
| \`last_error\` con «Falta habilitar <servicio> en el proyecto de Google Cloud: <enlace>» | Esa API no está habilitada en el proyecto | Abrir el enlace y pulsar **Habilitar** (paso 3); esperar unos minutos y \`memory_sync_connector\` |
| \`last_error\` con «Volvé a conectar Google para renovar el acceso» o \`invalid_grant\` | Token de actualización vencido (7 días en audiencia Externa en prueba) o revocado | \`memory_connect_google\` de nuevo; considerar audiencia Interna |
| Meet devuelve 403 o no trae transcripciones | La cuenta no tiene una edición de Workspace con transcripciones, o no se generó transcripción en la reunión; las intervenciones sólo están disponibles 30 días | Verificar la edición y que la transcripción esté activada en las reuniones; importar históricos desde Docs |
| \`last_error\` con «Gmail: Reconectá Google y autorizá la lectura de Gmail», o \`gmail_authorized: false\` | La fuente se autorizó antes de que Gmail viniera activado, o la persona destildó Gmail al aceptar | Paso 6, punto 6 |
| Emails de participantes en «permission_required» | Falta People API o se autorizó sin los ámbitos de contactos y directorio | Paso 3 y paso 6, punto 6 |

## Fuentes

- Crear credenciales (cliente de escritorio): https://developers.google.com/workspace/guides/create-credentials
- Configurar la pantalla de consentimiento (Google Auth Platform, Interna vs Externa): https://developers.google.com/workspace/guides/configure-oauth-consent
- Cuándo no se requiere verificación (apps internas, límite de 100 usuarios en prueba): https://support.google.com/cloud/answer/13464323
- Vencimiento del token de actualización a los 7 días en audiencia Externa en prueba: https://developers.google.com/identity/protocols/oauth2#expiration
- Ámbitos restringidos de Drive (\`drive.readonly\`): https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Ámbitos de Gmail (\`gmail.readonly\` es restringido): https://developers.google.com/workspace/gmail/api/auth/scopes
- Sincronización de Gmail con \`history.list\` (historial disponible al menos una semana): https://developers.google.com/workspace/gmail/api/guides/sync
- Reglas de URI de redirección (excepción para localhost y loopback): https://developers.google.com/identity/protocols/oauth2/web-server
- Apps de escritorio y loopback: https://developers.google.com/identity/protocols/oauth2/native-app
- \`gcloud services enable\`: https://docs.cloud.google.com/sdk/gcloud/reference/services/enable
- Instalar Google Cloud CLI: https://cloud.google.com/sdk/docs/install
- Costo y cuotas de Calendar API: https://developers.google.com/workspace/calendar/api/guides/quota
- Meet REST API (transcripciones disponibles 30 días): https://developers.google.com/workspace/meet/api/guides/overview
- Ámbito \`meetings.space.readonly\` para transcripciones de Meet: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts/list
- Ediciones de Workspace con transcripciones de Meet: https://support.google.com/meet/answer/12849897
- People API, directorio (\`directory.readonly\`): https://developers.google.com/people/api/rest/v1/people/listDirectoryPeople
- MCP servers de Google Workspace (APIs, cliente web y ámbitos): https://developers.google.com/workspace/guides/configure-mcp-servers
- Clientes OAuth para agentes de IA (casilla «Use this client for an AI-powered agent», clientes separados): https://support.google.com/cloud/answer/15549257
`
}

export const googleSetupSkill = { slug: GOOGLE_SETUP_SKILL_SLUG, display_name: GOOGLE_SETUP_SKILL_DISPLAY_NAME, description: GOOGLE_SETUP_SKILL_DESCRIPTION, get body() { return renderGoogleSetupSkill() } }
