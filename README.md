# Agent Hub

Agent Hub es una aplicación de escritorio para administrar los MCP servers y skills de una persona y decidir en qué cliente aparece cada herramienta. Se instala una vez, corre en segundo plano desde el tray y configura Claude Code, Codex CLI, Gemini CLI y Kiro con una única entrada `hub`.

La propiedad central sigue siendo verificable: **si apagás una herramienta, la llamada siguiente se deniega aunque la sesión MCP ya estuviera abierta y nunca alcanza al upstream**.

## Instalación

Cada versión publica instaladores para macOS, Windows y Linux en la [página de releases](https://github.com/aguara-guazu/agent-hub/releases/latest). La app no está firmada con certificados de distribuidor, así que cada sistema avisa la primera vez; abajo está el paso extra de cada uno.

**macOS** (Apple Silicon o Intel), en una terminal:

```bash
curl -fL "https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-$(uname -m | sed s/x86_64/x64/).dmg" -o /tmp/AgentHub.dmg && open /tmp/AgentHub.dmg
```

Arrastrá **Agent Hub** a Aplicaciones. Al abrirla por primera vez macOS la bloquea por no estar notarizada: en **Ajustes del Sistema → Privacidad y seguridad**, bajá hasta el aviso y elegí **Abrir de todos modos** ([instrucciones de Apple](https://support.apple.com/es-es/102445)). La app vive en la barra de menú, no en el Dock.

**Windows**, en PowerShell:

```powershell
irm https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-Setup-x64.exe -OutFile "$env:TEMP\AgentHub-Setup.exe"; & "$env:TEMP\AgentHub-Setup.exe"
```

El instalador no pide permisos de administrador y deja la app en el menú Inicio. En equipos ARM reemplazá `x64` por `arm64`. Si Windows muestra el aviso de SmartScreen por tratarse de un ejecutable sin firma, elegí **Más información → Ejecutar de todas formas**.

**Linux**, en una terminal:

```bash
curl -fL "https://github.com/aguara-guazu/agent-hub/releases/latest/download/AgentHub-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/').AppImage" -o ~/AgentHub.AppImage && chmod +x ~/AgentHub.AppImage && ~/AgentHub.AppImage
```

Es la versión portable, sin instalar nada. Para Debian y Ubuntu hay `.deb` (`AgentHub-amd64.deb` y `AgentHub-arm64.deb`) que se instalan con `sudo apt install ./AgentHub-amd64.deb`. El ícono queda en la bandeja del sistema.

**Primer arranque.** La app deja un catálogo inicial de MCP servers públicos listos para «Conectar cuenta», detecta los clientes instalados (Claude Code, Codex CLI, Gemini CLI y Kiro) y escribe en cada uno una única entrada `hub`. No hace falta cuenta ni otro equipo.

**Actualizar y desinstalar.** Para actualizar, instalá la versión nueva encima; los datos quedan. Para desinstalar, borrá la app y su directorio de estado: `~/Library/Application Support/Agent Hub` en macOS, `%APPDATA%\Agent Hub` en Windows y `~/.config/Agent Hub` en Linux. La entrada `hub` de cada cliente se puede quitar a mano de su configuración.

## Un solo producto y un solo stack

Todo el producto usa TypeScript/JavaScript sobre Node.js y Electron:

```text
Electron main + tray
├── renderer React/Vite
├── core Fastify + node:sqlite en 127.0.0.1
├── daemon de sincronización y adaptadores
└── entrypoint headless MCP por stdio
    └── upstreams stdio o Streamable HTTP
```

Son procesos separados por responsabilidad, pero pertenecen al mismo instalador:

- **Electron** mantiene la app en background, abre la consola y gestiona autostart.
- **Core** guarda catálogo, clientes, preferencias y actividad en SQLite y sirve `/api` más el renderer compilado. Un MCP server que no conecta se vuelve a sondear solo cada 30 segundos mientras esté habilitado y configurado.
- **Daemon** detecta clientes, baja snapshots, escribe configuraciones de forma atómica, materializa skills y resuelve secretos.
- **Gateway** es el único MCP server que conocen los clientes. `tools/list` y `tools/call` consultan la política vigente en el servicio local antes de exponer o ejecutar herramientas. El snapshot en disco permite continuar si el servicio está temporalmente fuera de línea.

Cerrar la ventana la oculta. La opción **Salir** del tray detiene core y daemon ordenadamente. En macOS y Windows se usa el login item del sistema; en Linux se administra `~/.config/autostart/agent-hub.desktop`.

La primera vez que arranca, la app deja cargado un **catálogo inicial** (`packages/core/src/catalog/starter.ts`): servers remotos públicos con OAuth y registro dinámico comprobado (Atlassian, Notion, Supabase, Cloudflare, Datadog, Canva, Port, Tactiq, diio). Aparecen habilitados y sólo piden «Conectar cuenta». Se siembra una vez por versión del catálogo y no repone lo que la persona borre; `AGENTHUB_STARTER_CATALOG=0` lo desactiva.

Los MCP servers http que piden OAuth (Notion, Slack, Atlassian, Google y similares) se agregan con **Autenticación: OAuth** y se autorizan con «Conectar cuenta»: se abre el navegador, el proveedor vuelve al core en `127.0.0.1` y el token queda en un archivo privado (`0600`) de esta computadora, nunca en la base. El gateway lo refresca solo. Requiere que el proveedor admita registro dinámico de clientes ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)), como pide la [especificación MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization); si no lo admite (Google, Slack y HubSpot, por ejemplo), la consola muestra el motivo y permite cargar un client ID y secreto de una app OAuth creada por la persona en ese proveedor, con la URL de retorno que indica la propia tarjeta.

En macOS la app es de barra de menú (`LSUIElement`): no ocupa lugar en el Dock ni aparece en Cmd+Tab, y se vuelve a abrir desde el ícono de la barra o abriendo de nuevo `Agent Hub.app`. El gateway que lanza cada CLI corre con `ELECTRON_RUN_AS_NODE=1`, como Node puro: no crea ícono ni se registra como instancia de la app, así que tener sesiones de Claude Code o Codex abiertas nunca impide abrir la app.

Instalar o reinstalar en macOS:

```bash
make install-app
```

Empaqueta, cierra la app si está corriendo, la copia a `/Applications`, corrige el ítem de inicio de sesión si apuntaba a otra copia y la abre.

## Desarrollo

Requisitos: Node.js 22.12 o superior y npm.

```bash
npm ci
npm run build
npm test
npm run test:e2e
npm run dev
```

Atajos equivalentes:

```bash
make install
make build
make test
make dev
```

`npm run dev` compila todos los workspaces y abre Electron. El estado local vive en el directorio `userData` de la aplicación; la base es `hub.db`, el secreto de sesión queda en un archivo `0600` y los secretos de upstream nunca entran en la base.

## Comandos headless

El instalador incluye el CLI `agenthub`:

```bash
agenthub status
agenthub plan
agenthub sync --once
agenthub why mcp__hub__ops_restart_service
agenthub gateway --agent <agent-instance-id> --state-dir <estado>
```

La aplicación prepara la sesión local y detecta clientes automáticamente, también si se instalan después del arranque. No requiere cuentas ni otro equipo. Desde el repositorio se pueden ejecutar estos comandos con `npm run agenthub -- <comando>`.

## Configuración de los clientes

Cada adaptador preserva el contenido ajeno y administra sólo la entrada `hub`. Un ejemplo stdio:

```json
{
  "mcpServers": {
    "hub": {
      "command": "/Applications/Agent Hub.app/Contents/MacOS/Agent Hub",
      "args": [
        "/Applications/Agent Hub.app/Contents/Resources/app/desktop/dist/entry.js",
        "--agenthub-headless", "gateway", "--agent", "<id>", "--state-dir", "<estado>"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE=1` hace que el ejecutable de Electron corra `entry.js` como Node: sin Chromium, sin ícono y sin registrarse ante el sistema como una instancia abierta de la app.

Rutas administradas:

| Cliente | Configuración MCP | Skills |
|---|---|---|
| Claude Code | `~/.claude.json` | `~/.claude/skills/` |
| Codex CLI | `~/.codex/config.toml` | `~/.codex/skills/` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/skills/` |
| Kiro | `~/.kiro/settings/mcp.json` | `~/.kiro/skills/` |

Las skills se guardan una vez en `~/.agenthub/skills/` y se enlazan a cada cliente. Si el sistema no permite symlinks, el materializador usa una copia administrada por manifiesto.

## Políticas y modo degradado

La precedencia es corta y explícita:

```text
default ON → regla de la persona → regla del cliente
```

El interruptor global aplica el mismo estado a todos los clientes y elimina excepciones previas. Las etiquetas de cada cliente permiten elegir excepciones individuales. Pausar un cliente vacía su catálogo efectivo. Las tools heredan la decisión de su server. Una tool cuya definición cambió queda en cuarentena hasta que la persona la acepte. Las conexiones creadas por el hub mantienen comandos, URLs y referencias de credenciales de upstream fuera de los archivos MCP de los clientes. Las conexiones independientes de proyectos u otras apps conservan su propia configuración.

Si el core no responde, el daemon conserva el último snapshot válido en disco. Sin snapshot no expone nada. El gateway observa el directorio de snapshots para soportar reemplazos atómicos sucesivos. Si se revoca su credencial, vacía el catálogo.

## Secretos

El catálogo guarda referencias, no valores:

```json
{ "secret_refs": { "GITHUB_TOKEN": "keychain://agenthub/github-token" } }
```

Backends:

- `keychain://`: Keychain en macOS o Secret Service en Linux. En Windows se pueden usar `env://` y `file://`.
- `env://`: variable del proceso local.
- `file://`: archivo absoluto con permisos `0600` en sistemas POSIX.

Tanto la prueba de conexión de la UI como el gateway resuelven las mismas referencias al conectar. Los valores no aparecen en snapshots, configuraciones de clientes, argumentos de proceso, auditoría ni mensajes de error.

## Interfaz local

- **MCP servers:** alta, edición, importación JSON, prueba de conexión, herramientas descubiertas y encendido global o por cliente.
- **Skills:** crear y editar instrucciones, distribuirlas y retirar sólo los archivos administrados por el hub.
- **Clientes:** detección automática, rutas de configuración y estado confirmado por el daemon.
- **Actividad:** llamadas ejecutadas, bloqueadas y errores de conexión.
- **Ajustes:** inicio automático y reinicio del servicio.

Los procesos MCP stdio corren localmente. No se necesita Docker ni un servicio remoto. El catálogo también acepta MCP por Streamable HTTP, incluidos servidores abiertos en localhost.

Codex y Gemini usan sus carpetas nativas separadas: compartir `.agents/skills` impedía apagarlas de forma independiente. La migración retira sólo enlaces creados previamente por Agent Hub. Se verificó la detección de `~/.codex/skills` con Codex 0.154.0. Las sesiones que ya cargaron instrucciones necesitan reiniciarse para descargarlas de su contexto.

## Pruebas y calidad

```bash
npm test             # core, daemon, gateway, desktop, testdata y React
npm run test:e2e     # procesos reales: core → daemon → config → gateway stdio
npm run typecheck    # TypeScript estricto
npm run lint         # ESLint
npm run build        # todos los workspaces
```

La verificación de Electron y Excalidraw de esta máquina está documentada en [docs/review-2026-09-10/FIXES.md](docs/review-2026-09-10/FIXES.md).

La prueba crítica mantiene la misma sesión MCP, cambia una tool de ON a OFF y comprueba que la siguiente llamada se deniega sin que crezca el archivo de auditoría del upstream.

## Empaquetado

```bash
npm run package        # bundle sin instalador para esta máquina, en release/
npm run dist           # instaladores de esta plataforma, en release/
npm run dist:mac       # dmg arm64 y x64 (sólo desde macOS)
npm run dist:win       # instalador NSIS y zip, x64 y arm64
npm run dist:linux     # AppImage y deb, x64 y arm64
```

El empaquetado usa [electron-builder](https://www.electron.build/) con la configuración de `electron-builder.yml` en la raíz. Los bundles van sin asar porque core, daemon y gateway corren como procesos Node separados desde `resources/app`.

### Publicar una versión

El workflow `.github/workflows/release.yml` compila cada plataforma en su propio runner y adjunta los artefactos a la release del tag:

```bash
npm version 0.3.0 --no-git-tag-version   # actualiza package.json
git commit -am "v0.3.0" && git tag v0.3.0 && git push origin main v0.3.0
```

Artefactos por release: `AgentHub-arm64.dmg`, `AgentHub-x64.dmg`, `AgentHub-Setup-x64.exe`, `AgentHub-Setup-arm64.exe`, `AgentHub-x64.zip`, `AgentHub-arm64.zip` (Windows portable), `AgentHub-x86_64.AppImage`, `AgentHub-arm64.AppImage`, `AgentHub-amd64.deb` y `AgentHub-arm64.deb`. `workflow_dispatch` corre la misma compilación sin publicar, para probar el pipeline. `ci.yml` corre lint, typecheck y todas las pruebas en cada push a `main` y en cada pull request.

Los artefactos no van firmados ni notarizados: eso requiere credenciales de distribuidor (Developer ID de Apple, certificado de firma de código en Windows) que se configurarían como secretos del repositorio.

## Estructura

```text
packages/shared/    contratos, hashes y nombres canónicos
packages/core/      SQLite, API, políticas, catálogo y auditoría
packages/daemon/    sync, estado, adaptadores, skills, secretos y CLI
packages/gateway/   MCP headless, política por llamada y runtimes
desktop/            Electron main/preload, tray, autostart y packaging
frontend/           renderer React/Vite
testdata/           upstreams MCP TypeScript reales
tests/e2e/          recorrido con procesos reales
docs/               contrato HTTP y arquitectura
```

El contrato HTTP y la forma exacta del snapshot están en [docs/API_CONTRACT.md](docs/API_CONTRACT.md). Las decisiones de procesos y persistencia están en [docs/TYPESCRIPT_ARCHITECTURE.md](docs/TYPESCRIPT_ARCHITECTURE.md).

## Variables principales

| Variable | Uso | Default |
|---|---|---|
| `AGENTHUB_DATABASE_PATH` | archivo SQLite del core | `./agenthub.db` |
| `AGENTHUB_JWT_SECRET` | firma de sesiones | generado por Electron |
| `AGENTHUB_LOCAL_MODE` | dueño local y bootstrap desktop | apagado |
| `AGENTHUB_CONSOLE_DIST` | renderer compilado servido por core | vacío |
| `AGENTHUB_HUB_HOST` / `AGENTHUB_HUB_PORT` | listener local | `127.0.0.1:8765` |
| `AGENTHUBD_URL` | core usado por daemon | según modo |
| `AGENTHUBD_HOME_DIR` | HOME donde se escriben configs | HOME del usuario |
| `AGENTHUBD_STATE_DIR` | credenciales y snapshots | directorio del SO |
| `AGENTHUBD_GATEWAY_TRANSPORT` | `stdio` o `http` | `stdio` |
| `AGENTHUB_ISOLATION` | `off` desactiva aislamiento | detección automática |
