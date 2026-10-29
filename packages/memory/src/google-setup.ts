import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { check, localPath } from './contracts.js'
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_SCOPES, type GoogleAuth } from './google-auth.js'
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
  { service: 'calendar-json.googleapis.com', name: 'Google Calendar API', purpose: 'Meeting invites, guests and times' },
  { service: 'meet.googleapis.com', name: 'Google Meet REST API', purpose: 'Conference records, participants, recent transcripts' },
  { service: 'drive.googleapis.com', name: 'Google Drive API', purpose: 'List docs in configured folders' },
  { service: 'docs.googleapis.com', name: 'Google Docs API', purpose: 'Read docs and kept transcripts' },
  { service: 'people.googleapis.com', name: 'People API', purpose: 'Participant emails via contacts and directory' },
  { service: 'gmail.googleapis.com', name: 'Gmail API', purpose: 'Mail sent and received, Gmail-enabled sources' },
]

/**
 * APIs adicionales para los MCP servers remotos de Google Workspace que el hub puede
 * proxear (Gmail, Calendar y Drive); cada producto exige su API, ya incluida en
 * GOOGLE_SETUP_APIS, y su variante MCP.
 */
export const GOOGLE_MCP_APIS: readonly GoogleApi[] = [
  { service: 'gmailmcp.googleapis.com', name: 'Gmail MCP', purpose: 'Remote Gmail MCP server' },
  { service: 'calendarmcp.googleapis.com', name: 'Google Calendar MCP', purpose: 'Remote Calendar MCP server' },
  { service: 'drivemcp.googleapis.com', name: 'Google Drive MCP', purpose: 'Remote Drive MCP server' },
]

export const GOOGLE_SETUP_SCOPES: readonly string[] = [...GOOGLE_SCOPES, GMAIL_SCOPE, GMAIL_SEND_SCOPE]

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
 * Returns the oldest Google source, creating it when none exists: Calendar (`primary`), Meet, Gmail and sending to the own account on,
 * paused until its account is authorized (see activateGoogleSource).
 */
export async function ensureGoogleSource(store: MemoryStore): Promise<{ id: string; config: Record<string, any> }> {
  const existing = (await store.db.query("SELECT id,config FROM connectors WHERE provider='google' ORDER BY created_at LIMIT 1"))[0]
  if (existing) return existing as { id: string; config: Record<string, any> }
  return (await store.db.query(`INSERT INTO connectors(id,provider,name,config,project_ids,enabled,interval_minutes) VALUES($1,'google','Google',$2,$3,$4,30)
    RETURNING id,config`, [randomUUID(), JSON.stringify({ calendars: ['primary'], gmail_send_enabled: true }), [], false]))[0] as { id: string; config: Record<string, any> }
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
export const GOOGLE_SETUP_SKILL_DESCRIPTION = 'Agent-run Google setup for Agent Hub memory via computer use or gcloud: Cloud project, APIs (Calendar, Meet, Drive, Docs, People, Gmail), consent screen, desktop OAuth client, memory_import_google_client, account connection. Use if the Google client is missing, a Google source fails to connect, on OAuth or disabled-API errors, or when installing elsewhere.'

const apiList = (apis: readonly GoogleApi[]) => apis.map(api => `- \`${api.service}\` (${api.name}): ${api.purpose}.`).join('\n')
const services = (apis: readonly GoogleApi[]) => apis.map(api => api.service).join(' ')

export function renderGoogleSetupSkill(): string {
  return `# Google setup for Agent Hub memory

Talk to the person in their language.

Memory reads Calendar, Meet, Drive, Docs and, where enabled, Gmail via a **desktop OAuth client** in the person's own Google Cloud project. You install it (\`memory_*\` tools, \`gcloud\`, Cloud console via computer use), verifying each step; the person only picks account and project and does what Google requires of them.

Tools: \`memory_<operation>\` on the \`hub\` server (maybe prefixed, e.g. \`mcp__hub__\`). No \`memory_google_setup_status\` means the installed Agent Hub app predates this skill: ask the person to update it; manual fallback: hub UI «Memoria → Fuentes y ajustes».

## Rules

- **No secrets in chat.** Client secret and tokens go from the downloaded JSON to the hub via \`memory_import_google_client\` or the hub UI. Never ask for the secret, read the JSON with file tools, or write it to notes or memory; if one shows on screen, say it isn't stored and go on.
- **Do, don't delegate.** Per Cloud step prefer: (1) **computer use** on the person's browser if the client offers it (e.g. Orca's \`orca computer\`; open URLs with \`open -a <browser> "<url>"\` on macOS, \`Start-Process "<url>"\` on Windows); (2) installed, authenticated \`gcloud\`; (3) last resort: the exact link and what to click. Ask once, upfront, for permission to operate the browser.
- **One step at a time:** act, verify (tool, screenshot or command), continue. On failure, check Common errors before improvising.
- Ask only the person's decisions: Google account; existing or new project. All else has defaults here.
- The person accepts Google's consent screen; click «Permitir» only if they asked you to do the whole connection.
- The person runs interactive commands (e.g. \`gcloud auth login\`) in their terminal (Claude Code: \`!\` prefix).
- Cite Google's docs (Sources) when stating limits or requirements.

## Step 0. Diagnosis

\`memory_google_setup_status\` returns \`client_configured\`, \`client_id\`, \`redirect_url\` (memory's return URL), required \`apis\` and \`scopes\`, and \`connectors\` (per Google source: \`enabled\`, \`connected\` = has token, \`last_error\`).

- Client configured, source connected, no \`last_error\`: nothing to install; offer \`memory_sync_connector\` and stop.
- Client configured but source not connected, or \`gmail_authorized: false\`: step 6.
- \`last_error\` set: see Common errors.
- No client: step 1.

Also check that memory is ready (\`memory_processing_status\` responds), whether computer use is available, and \`gcloud --version\` (not needed with computer use).

## Step 1. Account and audience

Ask which Google account will read meetings and mail; it fixes the consent audience:

- **Organization Workspace account** (e.g. company domain): always **Interna**: no verification, no «app no verificada» screen, no 100-user limit, no review for restricted scopes (\`drive.readonly\`, \`gmail.readonly\`). Recommended.
- **Personal @gmail.com**: only **Externa**. In «Prueba» status the account must be a test user and refresh tokens **expire after 7 days** (sync stops weekly until reconnected); production with \`drive.readonly\` or \`gmail.readonly\` (restricted) requires verification and a security assessment. Say so first; the person decides.

The project creator needs permission to create projects and enable services (project Propietario or Editor suffices); if the organization restricts project creation, ask its Google Cloud admin for one.

## Step 2. Project

Ask: existing or new? One project can also host the hub's Google MCP clients (step 7). With \`gcloud\` (the person runs the interactive parts):

\`\`\`bash
gcloud auth login
gcloud projects create agent-hub-memoria-<suffix> --name="Agent Hub memoria"
gcloud config set project agent-hub-memoria-<suffix>
\`\`\`

IDs are global and immutable; suggest one with the person's or team's name. Existing: \`gcloud projects list\`, then \`gcloud config set project <id>\`. No billing needed: standard use costs nothing extra (Calendar in Sources). Without \`gcloud\`: https://console.cloud.google.com/projectcreate (yourself with computer use); note the **project ID** (not the name) for the links below.

## Step 3. APIs

${apiList(GOOGLE_SETUP_APIS)}

With \`gcloud\` (you may run it once the session is authenticated):

\`\`\`bash
gcloud services enable ${services(GOOGLE_SETUP_APIS)} --project <project-id>
gcloud services list --enabled --project <project-id> | grep -E 'calendar|meet|drive|docs|people|gmail'
\`\`\`

PowerShell: \`Select-String -Pattern 'calendar|meet|drive|docs|people|gmail'\` instead of \`grep -E\`. Without \`gcloud\`: open \`https://console.cloud.google.com/apis/library/<service>?project=<project-id>\` for each → **Habilitar** («API habilitada» means already on). New APIs may take minutes to accept calls.

## Step 4. Consent screen (Google Auth Platform)

Console only, at \`https://console.cloud.google.com/auth/<page>?project=<project-id>\`: with computer use do it yourself, otherwise give the links and check what the person sees.

1. **Branding** (\`branding\`): if «Comenzar» appears, fill in app name (e.g. «Agent Hub memoria»), support email and developer contact email.
2. **Audiencia** (\`audience\`): **Interna** or **Externa** per step 1; with Externa, add each account to connect under **Usuarios de prueba**.
3. **Acceso a los datos** (\`scopes\`): with Externa, add these via «Agregar o quitar permisos» (paste into the manual entry box); optional with Interna, but it documents what the app requests:

${GOOGLE_SETUP_SCOPES.map(scope => `   - \`${scope}\``).join('\n')}

Memory may request these when authorizing (\`gmail.readonly\` only for sources with Gmail on; \`gmail.send\` only with sending enabled, and the Hub sends only to the connected account itself). No other scope writes data.

## Step 5. Desktop client and import

1. **Clientes** (\`clients\`) → **Crear cliente** → Tipo de aplicación **Aplicación de escritorio** → name «Agent Hub memoria» → **Crear**. Keep «Use this client for an AI-powered agent», if shown, **unchecked**: memory calls Workspace REST APIs, not MCP servers, and Google says such apps don't need it. From November 12, 2026 it can't be changed on existing clients; if checked by mistake, create another client and redo this step.
2. **Descargar JSON** (confirmation dialog or client row): \`client_secret_<...>.json\`, usually in \`~/Downloads\`.
3. Locate it without reading it, instead of asking for the path: \`ls -t ~/Downloads/client_secret*.json | head -1\` (macOS, Linux); PowerShell: \`Get-ChildItem "$env:USERPROFILE\\Downloads\\client_secret*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1\`.
4. \`memory_import_google_client\` with the absolute \`path\` returns \`client_type\` (must be \`installed\`; \`web\` = wrong type, create a desktop client and repeat), \`client_id\`, \`project_id\` (confirm it's the expected one), the Google source \`connector_id\` (created if missing, with Calendar \`primary\`, Meet and Gmail) and \`authorization_url\`.
5. Delete the download (\`rm <path>\`; PowerShell \`Remove-Item <path>\`): the hub keeps a private copy in the memory directory (mode \`0600\` on macOS and Linux; on Windows, profile folder permissions), excluded from backups.
6. Continue at step 6.2 with that \`authorization_url\`.

No-agent path: hub «Memoria → Fuentes y ajustes» → **Configurar cliente OAuth** takes the same JSON; saving creates the source and opens authorization in the browser.

## Step 6. Source and authorization

1. The import creates the source with defaults: Calendar \`primary\`, Meet and Gmail on (received and sent mail minus Promotions, Social, Spam, Trash, drafts; then checked every 2 minutes). Don't create it by hand or ask anything for it. Regular sync always covers the **last 90 days** of Calendar and Gmail; no start date to set.
2. Open \`authorization_url\` in the person's browser (\`open "<url>"\` on macOS, \`Start-Process "<url>"\` on Windows). If expired (10 minutes) or to reconnect, \`memory_connect_google\` with the \`connector_id\` gives a new one.
3. The step 1 account is picked and permissions accepted (see Rules). Google returns to \`redirect_url\` showing «Google conectado a Agent Hub»: the source is **active** and Calendar, Meet and the first Gmail check start by themselves. Externa in testing first warns of an unverified app: «Continuar» is expected.
4. Verify with \`memory_google_setup_status\` (\`enabled\`, \`connected\` and \`gmail_authorized\` all \`true\`); track \`memory_list_jobs\` (\`kind: "sync,gmail"\`). On \`last_error\`, see Common errors.
5. Only once all works, offer optional \`memory_save_connector\` settings: \`project_ids\` to link imports to, Drive \`folder_ids\`/\`document_ids\` with historical transcripts, another \`name\`, or \`gmail_enabled: false\` for no mail. Ask for values; never invent them.
6. Authorized earlier with fewer permissions (e.g. no People API, or before Gmail came enabled: \`memory_list_connectors\` shows \`gmail_authorized: false\`): reconnect with \`memory_connect_google\`, then \`memory_repair_google\` to complete emails and speakers of imported data.
7. **Older than 90 days, only on request:** \`memory_sync_connector\` with \`id\`, \`since\` (\`YYYY-MM-DD\` or ISO 8601), optional \`until\` (default now) imports that period's Calendar events and Gmail; regular sync is unchanged. Meet keeps utterances ~30 days, so older periods only get transcripts attached to events as Docs. Warn first: every mail and invitation goes through the extraction model; long periods can take hours. Job: «Sincronización de un período anterior» in \`memory_list_jobs\`.

## Step 7 (optional). Hub's Google MCP servers

The hub can also proxy Google Workspace's remote MCP servers (Gmail, Calendar, Drive). They lack dynamic client registration, so their hub card shows «Usar credenciales de cliente propias» and the return URL. Use a client separate from memory's:

1. In the same project also enable the MCP variants (base APIs: step 3):

${apiList(GOOGLE_MCP_APIS)}

   \`\`\`bash
   gcloud services enable ${services(GOOGLE_MCP_APIS)} --project <project-id>
   \`\`\`

2. Create an **Aplicación web** client with the card's return URL as **URI de redireccionamiento autorizado** (localhost and loopback IPs are exempt from HTTPS) and **check «Use this client for an AI-powered agent»**: from November 11, 2026 Workspace MCP servers reject unflagged clients, and from November 12 the flag can't be changed, so replace older unflagged web clients. One web client serves all three servers; never use it for memory (Google requires separate clients for agent and traditional traffic).
3. Paste client ID and secret into the hub card (no tool: the secret must not pass through the agent), then «Conectar cuenta».

Scopes per Google's docs: Gmail \`gmail.readonly\`, \`gmail.compose\`; Drive \`drive.readonly\`, \`drive.file\`; Calendar \`calendar.calendarlist.readonly\`, \`calendar.events.freebusy\`, \`calendar.events.readonly\`. Google documents claude.ai and Antigravity; the hub uses its own local return URL, so report an authorization failure here as a limitation to confirm, not the person's error.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| \`memory_connect_google\`: «Configurá el client ID…» | No OAuth client loaded | Step 5 |
| \`redirect_uri_mismatch\` | Not Aplicación de escritorio (step 7: web client lacks the return URL) | Recreate with the right type, reimport |
| \`access_denied\` or «Esta app no está verificada» with no way on | Externa without the account as test user, or other organization's account with Interna | Step 4.2 |
| MCP server: «the client isn't marked as an AI agent» | Step 7 web client not flagged | Before November 12, 2026, check the box; after, a new flagged web client with its ID and secret on the card |
| \`admin_policy_enforced\` | Workspace admin blocks third-party apps or these scopes | Ask the admin to trust the client ID in the Admin console |
| \`last_error\` «Falta habilitar <servicio> en el proyecto de Google Cloud: <enlace>» | API not enabled | Link → **Habilitar** (step 3); wait minutes; \`memory_sync_connector\` |
| \`last_error\` «Volvé a conectar Google para renovar el acceso» or \`invalid_grant\` | Refresh token expired (7 days, Externa in testing) or revoked | \`memory_connect_google\`; consider Interna |
| Meet 403 or no transcripts | Workspace edition without transcripts, or none generated; utterances kept 30 days | Check edition and transcription; import history from Docs |
| \`last_error\` «Gmail: Reconectá Google y autorizá la lectura de Gmail» or \`gmail_authorized: false\` | Authorized before Gmail came enabled, or Gmail unchecked on consent | Step 6.6 |
| Participant emails «permission_required» | People API missing, or no contacts and directory scopes | Steps 3 and 6.6 |

## Sources

- Desktop client: https://developers.google.com/workspace/guides/create-credentials
- Consent screen, Internal vs External: https://developers.google.com/workspace/guides/configure-oauth-consent
- Verification exemptions (internal, 100 test users): https://support.google.com/cloud/answer/13464323
- 7-day refresh tokens (External, testing): https://developers.google.com/identity/protocols/oauth2#expiration
- Restricted Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Gmail scopes (\`gmail.readonly\` restricted): https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail \`history.list\` sync (≥1 week of history): https://developers.google.com/workspace/gmail/api/guides/sync
- Redirect URIs (loopback exception): https://developers.google.com/identity/protocols/oauth2/web-server
- Desktop apps and loopback: https://developers.google.com/identity/protocols/oauth2/native-app
- \`gcloud services enable\`: https://docs.cloud.google.com/sdk/gcloud/reference/services/enable
- Install gcloud: https://cloud.google.com/sdk/docs/install
- Calendar API cost and quotas: https://developers.google.com/workspace/calendar/api/guides/quota
- Meet REST API (30-day transcripts): https://developers.google.com/workspace/meet/api/guides/overview
- \`meetings.space.readonly\`: https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts/list
- Workspace editions with Meet transcripts: https://support.google.com/meet/answer/12849897
- People API directory (\`directory.readonly\`): https://developers.google.com/people/api/rest/v1/people/listDirectoryPeople
- Workspace MCP servers: https://developers.google.com/workspace/guides/configure-mcp-servers
- AI-agent OAuth clients: https://support.google.com/cloud/answer/15549257
`
}

export const googleSetupSkill = { slug: GOOGLE_SETUP_SKILL_SLUG, display_name: GOOGLE_SETUP_SKILL_DISPLAY_NAME, description: GOOGLE_SETUP_SKILL_DESCRIPTION, get body() { return renderGoogleSetupSkill() } }
