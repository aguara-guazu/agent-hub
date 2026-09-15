import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, extname } from 'node:path'
import { check } from './contracts.js'
import { GOOGLE_SCOPES } from './google-auth.js'

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

/** APIs que usa el conector Google de la memoria (Calendar, Meet, Drive, Docs y People). */
export const GOOGLE_SETUP_APIS: readonly GoogleApi[] = [
  { service: 'calendar-json.googleapis.com', name: 'Google Calendar API', purpose: 'Invitaciones, invitados y horarios de las reuniones' },
  { service: 'meet.googleapis.com', name: 'Google Meet REST API', purpose: 'Registros de conferencias, participantes y transcripciones recientes' },
  { service: 'drive.googleapis.com', name: 'Google Drive API', purpose: 'Listar documentos de las carpetas configuradas' },
  { service: 'docs.googleapis.com', name: 'Google Docs API', purpose: 'Leer documentos y transcripciones conservadas' },
  { service: 'people.googleapis.com', name: 'People API', purpose: 'Resolver emails de participantes por contactos y directorio' },
]

/**
 * APIs adicionales para los MCP servers remotos de Google Workspace que el hub puede
 * proxear (Gmail, Calendar y Drive); cada producto exige su API y su variante MCP.
 */
export const GOOGLE_MCP_APIS: readonly GoogleApi[] = [
  { service: 'gmail.googleapis.com', name: 'Gmail API', purpose: 'MCP server remoto de Gmail' },
  { service: 'gmailmcp.googleapis.com', name: 'Gmail MCP', purpose: 'MCP server remoto de Gmail' },
  { service: 'calendarmcp.googleapis.com', name: 'Google Calendar MCP', purpose: 'MCP server remoto de Calendar' },
  { service: 'drivemcp.googleapis.com', name: 'Google Drive MCP', purpose: 'MCP server remoto de Drive' },
]

export const GOOGLE_SETUP_SCOPES: readonly string[] = GOOGLE_SCOPES

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
export function readGoogleClientFile(path: string): GoogleClientFile {
  check(isAbsolute(path), 'Indicá la ruta absoluta del archivo JSON descargado de Google Cloud')
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

export const GOOGLE_SETUP_SKILL_SLUG = 'google-setup'
export const GOOGLE_SETUP_SKILL_DISPLAY_NAME = 'Configurar Google para la memoria'
export const GOOGLE_SETUP_SKILL_DESCRIPTION = 'Instalación guiada de Google para la memoria de Agent Hub: proyecto de Google Cloud, APIs (Calendar, Meet, Drive, Docs, People), pantalla de consentimiento, cliente OAuth de escritorio, carga con memory_import_google_client y autorización de la cuenta. Usar cuando falte el cliente de Google, una fuente Google no conecte, haya errores de OAuth o de API deshabilitada, o al instalar Agent Hub en otra computadora.'

const apiList = (apis: readonly GoogleApi[]) => apis.map(api => `- \`${api.service}\` (${api.name}): ${api.purpose}.`).join('\n')
const services = (apis: readonly GoogleApi[]) => apis.map(api => api.service).join(' ')

export function renderGoogleSetupSkill(): string {
  return `# Configurar Google para la memoria de Agent Hub

La memoria de Agent Hub lee Calendar, Meet, Drive y Docs con un **cliente OAuth de escritorio** que la persona crea en su propio proyecto de Google Cloud. Esta skill es una instalación guiada: el agente ejecuta lo que se puede automatizar (comprobaciones, \`gcloud\`, herramientas \`memory_*\`), la persona hace en el navegador lo que Google sólo permite desde su consola, y el agente verifica cada paso antes de seguir.

Las herramientas llegan por el servidor \`hub\` con nombres \`memory_<operación>\` (según el cliente, con un prefijo como \`mcp__hub__\`). Si \`memory_google_setup_status\` no existe, la app de Agent Hub instalada es anterior a esta skill: pedir a la persona que la actualice y seguir con la UI del hub (Memoria → Fuentes y ajustes) como alternativa manual.

## Reglas de esta skill

- **Ningún secreto pasa por la conversación.** El client secret y los tokens viajan del archivo JSON descargado al hub con \`memory_import_google_client\`, o se pegan en la UI del hub. No pedir que peguen el secreto en el chat, no leer el JSON con herramientas de archivos, no escribirlo en notas ni en la memoria. Si aparece uno en pantalla, decir que no se guarda y seguir.
- **Un paso a la vez.** Explicar qué va a pasar, hacerlo o pedirlo, comprobar el resultado con una herramienta o un comando, y sólo entonces pasar al siguiente. Si algo falla, ir a «Errores frecuentes» antes de improvisar.
- **Preguntar antes de asumir** la cuenta a usar, el tipo de audiencia y si el proyecto de Google Cloud es nuevo o existente.
- La persona ejecuta en su terminal los comandos interactivos (por ejemplo \`gcloud auth login\`); en Claude Code puede escribirlos con el prefijo \`!\`.
- Citar la documentación de Google (enlaces al final) cuando se afirme un límite o un requisito.

## Paso 0. Diagnóstico

Llamar a \`memory_google_setup_status\`. Devuelve \`client_configured\` (si ya hay cliente OAuth), \`client_id\`, \`redirect_url\` (la URL de retorno que usa la memoria), \`apis\` y \`scopes\` requeridos, y \`connectors\`: cada fuente Google con \`enabled\`, \`connected\` (tiene token) y \`last_error\`.

- Si \`client_configured\` es \`true\` y la fuente está \`connected\` sin \`last_error\`: no hay nada que instalar; ofrecer \`memory_sync_connector\` y terminar.
- Si \`client_configured\` es \`true\` pero la fuente no está conectada: ir al paso 6.
- Si \`last_error\` menciona una API deshabilitada («accessNotConfigured», «has not been used in project»): ir al paso 3.
- Si no hay cliente: seguir con el paso 1.

Comprobar también si la memoria está lista (\`memory_processing_status\` responde) y si \`gcloud\` está instalado (\`gcloud --version\` en la terminal). Sin \`gcloud\`, cada paso tiene su alternativa en la consola web; ofrecer instalarlo sólo si la persona lo quiere.

## Paso 1. Cuenta y audiencia

Preguntar con qué cuenta de Google se van a leer las reuniones. La respuesta decide la **audiencia** de la pantalla de consentimiento:

- **Cuenta de Google Workspace de una organización** (por ejemplo el dominio de la empresa): elegir **Interna**. La app no pasa por verificación, no muestra la pantalla de «app no verificada» y no tiene el límite de 100 usuarios; los ámbitos restringidos como \`drive.readonly\` no requieren revisión. Es la opción recomendada.
- **Cuenta personal (@gmail.com)**: la única opción es **Externa**. En estado «Prueba» hay que agregar la cuenta como usuario de prueba, y Google emite tokens de actualización que **vencen a los 7 días**: la fuente dejará de sincronizar cada semana hasta reconectarla. Publicar la app a producción con \`drive.readonly\` (ámbito restringido) exige verificación y evaluación de seguridad. Decirlo antes de seguir y dejar que la persona decida.

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

Sin \`gcloud\`: crear el proyecto en https://console.cloud.google.com/projectcreate y pedir a la persona el **ID del proyecto** (no el nombre) para construir los enlaces siguientes.

## Paso 3. Habilitar las APIs

Las APIs que usa la memoria:

${apiList(GOOGLE_SETUP_APIS)}

Con \`gcloud\`, un solo comando (el agente puede ejecutarlo si la sesión ya está autenticada):

\`\`\`bash
gcloud services enable ${services(GOOGLE_SETUP_APIS)} --project <id-del-proyecto>
gcloud services list --enabled --project <id-del-proyecto> | grep -E 'calendar|meet|drive|docs|people'
\`\`\`

Sin \`gcloud\`: abrir cada una en la biblioteca de APIs y pulsar **Habilitar**: \`https://console.cloud.google.com/apis/library/<servicio>?project=<id-del-proyecto>\`, reemplazando \`<servicio>\` por cada identificador de la lista. Una API recién habilitada puede tardar unos minutos en aceptar llamadas.

## Paso 4. Pantalla de consentimiento (Google Auth Platform)

Sólo se puede hacer en la consola web; el agente entrega los enlaces con el proyecto ya seleccionado y verifica con la persona lo que ve.

1. **Branding**: https://console.cloud.google.com/auth/branding?project=<id-del-proyecto>. Si aparece «Comenzar», completar nombre de la app (por ejemplo «Agent Hub memoria»), email de asistencia y email de contacto del desarrollador.
2. **Audiencia** (https://console.cloud.google.com/auth/audience?project=<id-del-proyecto>): **Interna** o **Externa** según el paso 1. Si es Externa, agregar en **Usuarios de prueba** cada cuenta que se va a conectar.
3. **Acceso a los datos** (https://console.cloud.google.com/auth/scopes?project=<id-del-proyecto>): con audiencia Externa, agregar estos ámbitos con «Agregar o quitar permisos» (pegar la lista en el cuadro de entrada manual). Con audiencia Interna no es obligatorio listarlos, pero dejarlos declarados documenta qué pide la app:

${GOOGLE_SETUP_SCOPES.map(scope => `   - \`${scope}\``).join('\n')}

Estos son exactamente los ámbitos que la memoria solicita al autorizar; no pide escritura sobre ningún dato.

## Paso 5. Cliente OAuth de escritorio y carga en el hub

1. **Clientes**: https://console.cloud.google.com/auth/clients?project=<id-del-proyecto> → **Crear cliente** → Tipo de aplicación **Aplicación de escritorio** → nombre «Agent Hub memoria» → **Crear**.
2. En el cuadro de confirmación (o desde la fila del cliente), **Descargar JSON**. El archivo se llama \`client_secret_<...>.json\` y suele quedar en \`~/Downloads\`.
3. Pedir a la persona sólo la **ruta del archivo**, no su contenido. Si no la sabe, buscarla sin leer el archivo: \`ls -t ~/Downloads/client_secret*.json | head -1\`.
4. Llamar a \`memory_import_google_client\` con \`path\` absoluto. Devuelve \`client_type\` (debe ser \`installed\`), \`client_id\` y \`project_id\`: confirmar que el proyecto es el esperado. Si \`client_type\` es \`web\`, el cliente se creó con el tipo equivocado: crear uno de escritorio y repetir.
5. Recomendar borrar la descarga (\`rm <ruta>\`): la copia que usa el hub ya está en un archivo privado (\`0600\`) dentro del directorio de la memoria y no entra en los respaldos.

Alternativa manual: en el hub, Memoria → Fuentes y ajustes → **Configurar cliente OAuth** acepta el mismo JSON con un selector de archivos.

## Paso 6. Fuente Google y autorización

1. Si no existe una fuente Google, crearla con \`memory_save_connector\`: \`provider: "google"\`, un \`name\` (por ejemplo «Google del trabajo»), \`enabled: true\`, \`interval_minutes: 30\`, \`project_ids\` de los proyectos de la memoria a los que se vincula lo importado (puede quedar vacío), y \`config\` con \`calendars\` (por defecto \`["primary"]\`), \`since\` (ISO 8601; por defecto 90 días atrás) y opcionalmente \`folder_ids\` o \`document_ids\` de Drive con transcripciones históricas. Preguntar estos valores; no inventarlos.
2. Llamar a \`memory_connect_google\` con el \`id\` de la fuente y abrir la \`authorization_url\` en el navegador de la persona (\`open "<url>"\` en macOS). Vence a los 10 minutos.
3. La persona elige la cuenta del paso 1 y acepta los permisos. Google vuelve al hub en la \`redirect_url\` y muestra «Google conectado a Agent Hub». Con audiencia Externa en prueba aparece antes un aviso de app no verificada: «Continuar» es lo esperado.
4. Verificar con \`memory_google_setup_status\` que la fuente quedó \`connected: true\`.
5. Lanzar \`memory_sync_connector\` con el \`id\` y seguir el progreso con \`memory_list_jobs\` (\`kind: "sync"\`). Cuando termine, \`memory_list_connectors\` muestra \`last_success_at\`; si hay \`last_error\`, ir a «Errores frecuentes».
6. Si Google ya estaba conectado con menos permisos (por ejemplo sin People API), reconectar con \`memory_connect_google\` y luego \`memory_repair_google\` para completar emails y hablantes de lo ya importado.

## Paso 7 (opcional). MCP servers de Google del hub

Agent Hub también puede proxear los MCP servers remotos de Google Workspace (Gmail, Google Calendar y Google Drive). Google no admite registro dinámico de clientes para ellos, así que la tarjeta del server en la consola del hub muestra «Usar credenciales de cliente propias» y la **URL de retorno** del hub. Este cliente es distinto del de la memoria:

1. En el mismo proyecto, habilitar además las APIs de cada producto y su variante MCP:

${apiList(GOOGLE_MCP_APIS)}

   \`\`\`bash
   gcloud services enable ${services(GOOGLE_MCP_APIS)} --project <id-del-proyecto>
   \`\`\`

2. Crear un cliente de tipo **Aplicación web** con la URL de retorno que muestra la tarjeta del server como **URI de redireccionamiento autorizado** (Google exceptúa a localhost y a las direcciones IP de loopback de la obligación de HTTPS). Un mismo cliente web sirve para los tres servers.
3. Pegar client ID y client secret en la tarjeta del server, en la consola del hub (no hay herramienta para esto: el secreto no debe pasar por el agente), y luego «Conectar cuenta».

Los ámbitos que cada server solicita los define Google en su documentación (Gmail: \`gmail.readonly\` y \`gmail.compose\`; Drive: \`drive.readonly\` y \`drive.file\`; Calendar: \`calendar.calendarlist.readonly\`, \`calendar.events.freebusy\` y \`calendar.events.readonly\`). La documentación oficial describe la configuración para claude.ai y Antigravity; el hub usa su propia URL de retorno local, así que si la autorización falla en este paso, informarlo como una limitación a confirmar y no como un error de la persona.

## Errores frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| \`memory_connect_google\` responde «Configurá el client ID…» | No hay cliente OAuth cargado | Paso 5 |
| Google muestra \`redirect_uri_mismatch\` | El cliente no es de tipo Aplicación de escritorio (o, en el paso 7, falta la URL de retorno en el cliente web) | Crear el cliente con el tipo correcto y reimportar |
| Google muestra \`access_denied\` o «Esta app no está verificada» sin botón para continuar | Audiencia Externa sin la cuenta en usuarios de prueba, o cuenta de otra organización con audiencia Interna | Paso 4, punto 2 |
| Google muestra \`admin_policy_enforced\` | El administrador de Workspace bloquea apps de terceros o estos ámbitos | Pedir al administrador que confíe en el cliente (por su client ID) en la consola de administración |
| \`last_error\` con «accessNotConfigured» o «API has not been used in project» | Falta habilitar una API | Paso 3; esperar unos minutos y \`memory_sync_connector\` |
| \`last_error\` con «Volvé a conectar Google para renovar el acceso» o \`invalid_grant\` | Token de actualización vencido (7 días en audiencia Externa en prueba) o revocado | \`memory_connect_google\` de nuevo; considerar audiencia Interna |
| Meet devuelve 403 o no trae transcripciones | La cuenta no tiene una edición de Workspace con transcripciones, o no se generó transcripción en la reunión; las intervenciones sólo están disponibles 30 días | Verificar la edición y que la transcripción esté activada en las reuniones; importar históricos desde Docs |
| Emails de participantes en «permission_required» | Falta People API o se autorizó sin los ámbitos de contactos y directorio | Paso 3 y paso 6, punto 6 |

## Fuentes

- Crear credenciales (cliente de escritorio): https://developers.google.com/workspace/guides/create-credentials
- Configurar la pantalla de consentimiento (Google Auth Platform, Interna vs Externa): https://developers.google.com/workspace/guides/configure-oauth-consent
- Cuándo no se requiere verificación (apps internas, límite de 100 usuarios en prueba): https://support.google.com/cloud/answer/13464323
- Vencimiento del token de actualización a los 7 días en audiencia Externa en prueba: https://developers.google.com/identity/protocols/oauth2#expiration
- Ámbitos restringidos de Drive (\`drive.readonly\`): https://developers.google.com/workspace/drive/api/guides/api-specific-auth
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
`
}

export const googleSetupSkill = { slug: GOOGLE_SETUP_SKILL_SLUG, display_name: GOOGLE_SETUP_SKILL_DISPLAY_NAME, description: GOOGLE_SETUP_SKILL_DESCRIPTION, get body() { return renderGoogleSetupSkill() } }
