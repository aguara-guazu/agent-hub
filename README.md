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

**Actualizaciones automáticas.** La app revisa las releases de GitHub al arrancar y cada seis horas. En macOS, con el instalador de Windows y con el AppImage de Linux baja la versión nueva y se reinstala sola: si la ventana está cerrada lo hace en el acto, y si está abierta espera a que la cierres o a que elijas «Reiniciar para actualizar» en el menú de la barra. El zip portable de Windows y el `.deb` sólo avisan con un enlace a la release. `AGENTHUB_NO_AUTO_UPDATE=1` lo desactiva.

**Actualizar a mano y desinstalar.** Instalá la versión nueva encima; los datos quedan. Para desinstalar, borrá la app y su directorio de estado: `~/Library/Application Support/Agent Hub` en macOS, `%APPDATA%\Agent Hub` en Windows y `~/.config/Agent Hub` en Linux. La entrada `hub` de cada cliente se puede quitar a mano de su configuración.

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

## Proyectos y memoria local

El hub incorpora proyectos, empresas, personas, reuniones, documentos, conversaciones y tareas. **Proyectos** muestra el contexto de cada cliente; **Memoria** permite explorar, buscar, seguir citas hasta la intervención original y administrar fuentes. Las colecciones permiten crear tablas con columnas tipadas y reglas persistentes de extracción.

La memoria usa PostgreSQL 17 con pgvector y conserva versiones de los originales en disco. El SQLite del hub mantiene su catálogo y sus políticas. El MCP **Memoria de proyectos** se registra al configurar la base y sus herramientas pasan por los mismos permisos del gateway.

Para probar con datos ficticios y abrir la UI en el navegador:

```bash
npm run memory:dev
```

Requiere Docker con el motor iniciado, o PostgreSQL y pgvector instalados. Se puede elegir `-- --backend native` o `-- --backend docker`. La demostración guarda su estado en `.agenthub/memory-development`, usa la UI en `127.0.0.1:8876` y no ejecuta el daemon que modifica configuraciones de clientes. PostgreSQL usa `54349` para una demostración nueva, `54339` para pruebas y `54329` para la memoria normal; una instalación existente conserva su puerto.

Para preparar la memoria de la aplicación de escritorio:

```bash
npm run memory:up
npm run dev
```

`memory:up` guarda la configuración en el directorio de estado de Agent Hub. También admite `--dir`, `--port` y `--backend`. Para un directorio personalizado, configurá `AGENTHUB_MEMORY_DIR` al iniciar el hub. El worker reanuda trabajos e inicia el servicio administrado junto con el core; el inicio al login depende del autostart existente del hub y, con Docker, del motor Docker. `memory:down` detiene PostgreSQL sin borrar datos; cerrá antes el hub que lo supervisa.

En **Memoria → Fuentes y ajustes** se configuran Google (Calendar, Meet y Docs/Drive), Notion, Slack y Jira Cloud, sus credenciales y su alcance. Google usa OAuth con un cliente de escritorio propio. Habilitá también **People API** para obtener emails por el identificador del participante de Meet; OAuth solicita lectura de contactos, otros contactos y directorio. Si Google ya estaba conectado, reconectalo para conceder esos permisos y usá **Actualizar hablantes y emails** para reparar lo importado. Las credenciales se guardan en archivos privados y no se exportan en los respaldos. Los conectores leen las fuentes; los cambios de la memoria permanecen locales.

La búsqueda textual funciona sin IA. Para búsqueda semántica, instalá Ollama y un modelo de embeddings, por ejemplo `ollama pull nomic-embed-text`, y habilitalo en Ajustes. La extracción puede usar un modelo de Ollama o DeepSeek. **DeepSeek procesa contenido fuera de la computadora** y requiere habilitación explícita; cada proyecto o fuente también puede excluirse. Las propuestas extraídas conservan evidencia y se revisan en la UI. Al cambiar o actualizar un modelo de embeddings, reprocesá las fuentes.

En **Memoria → Procesamiento** se ve la fuente, proveedor y modelo de cada trabajo, etapa, lotes completados, fragmentos, tokens registrados, propuestas, duración, errores y controles para cancelar o reintentar. La pantalla se actualiza cada tres segundos y distingue indexación local de extracción con IA. Los resultados son propuestas con evidencia, pendientes de revisión.

La IA también puede **inferir vínculos de hablantes sin email** comparando sus intervenciones con personas conocidas y los invitados de Calendar de esa reunión. Sólo puede elegir correos presentes en esos datos; se guarda la propuesta, el motivo, la confianza declarada por el modelo y sus citas. En la fuente, la persona o **Por revisar → Vínculos sugeridos por IA** se puede confirmar el email o descartar el vínculo. Confirmar completa el registro de la persona y conserva la corrección; si ese email ya pertenece a una persona conocida, el hablante se **unifica** con ella (intervenciones, identidades externas y vínculos pasan al perfil vigente, con registro en el historial). Las inferencias pendientes no se utilizan como identidades confirmadas para generar nuevas inferencias. El procesamiento habitual incluye esta etapa; **Inferir emails pendientes** permite ejecutarla sobre el histórico sin regenerar embeddings ni resúmenes. Las exclusiones de procesamiento remoto siguen aplicándose.

**Deduplicación de personas.** Con la opción **Unificar automáticamente… con confianza alta** (activa por defecto en Fuentes y ajustes), las inferencias de confianza alta se aplican sin revisión: si el candidato es una persona conocida con nombre compatible, se unifican; si es sólo un invitado del calendario, se completa el email marcado como confirmado por IA, y un email verificado por el proveedor lo reemplaza después. Los perfiles con el **mismo email verificado** se unifican siempre, salvo que sus nombres no se parezcan: entonces queda un conflicto para revisar. Además, el trabajo **Unificación de personas duplicadas** (se encola tras cada procesamiento y con **Buscar personas duplicadas**) pide al modelo comparar homónimos y nombres relacionados con su contexto: tipo de identidad (usuario de Meet, etiqueta de un documento, anónimo), reuniones, documentos vinculados y muestras de intervenciones. Un par con confianza alta se unifica solo, y uno con confianza media también cuando el nombre completo es idéntico y un lado es sólo una etiqueta de documento sin email; nunca cuando ambos tienen emails verificados distintos o hablan como personas distintas en la misma transcripción. El resto aparece en **Por revisar → Personas duplicadas** para unificar o marcar como distintos; las propuestas pendientes se releen en cada corrida, así que activar la opción más tarde las aplica sin volver a consultar al modelo. Las decisiones humanas no se vuelven a preguntar y cada par se consulta una sola vez por contexto. Las respuestas del modelo se validan ítem por ítem: una entrada malformada se descarta y se cuenta, sin perder el lote.

Las intervenciones recientes se obtienen desde Meet; su disponibilidad está limitada por Google. Los documentos históricos conservados se importan desde Drive/Docs o desde archivos TXT, Markdown, VTT, SRT y JSON. En Docs se reconocen pestañas y secciones de transcripción, separando diálogos de notas y conservando las marcas de sección sin tratarlas como tiempos exactos. Sus hablantes se vinculan por nombre único dentro de las reuniones asociadas al documento; los homónimos quedan pendientes. Calendar aporta invitados y contexto, y no demuestra asistencia. Los emails que el proveedor no entrega quedan sin resolver hasta corregir o vincular la persona. Las correcciones manuales se conservan al sincronizar. Los adjuntos binarios, PDF/OCR y la transcripción de audio todavía no se procesan.

Calendar revisita el período entre la fecha elegida y el momento de sincronización (90 días hacia atrás por defecto), con un límite superior explícito para no expandir recurrencias hacia años futuros. Las importaciones repetidas conservan los identificadores y sólo generan versiones si cambió el contenido. Esta ventana usa consultas completas paginadas: Google no permite combinar `timeMax` con `syncToken`. [Referencia de Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

La UI ofrece respaldo y restauración en una memoria vacía. El respaldo incluye versiones, relaciones, vectores y originales; requiere volver a configurar credenciales e IA en el destino. La importación por archivo admite 5 MB y la restauración HTTP 128 MB. La búsqueda por relevancia toma hasta 200 candidatos por índice; las consultas sin texto y las colecciones permiten recorrer todos los registros mediante paginación.

Verificación específica, además de `npm test`:

```bash
npm run test:memory
npm run memory:dev -- --smoke
```

La primera usa una base dedicada terminada en `_test`. La segunda recorre la UI con Playwright, API y PostgreSQL reales; guarda capturas locales y elimina las entidades que crea. Si falta Chromium: `npm exec --workspace @agenthub/frontend -- playwright install chromium`. Las pruebas de conectores usan respuestas simuladas; la verificación contra cuentas reales requiere sus credenciales.

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

Al configurar la memoria, el hub instala la skill de fábrica **`memory`** («Memoria de proyectos») y la expone a todos los clientes: explica cuándo consultar la memoria, cómo resolver el alcance por proyecto o persona, cómo buscar y paginar de forma exhaustiva, cómo citar evidencia y distinguir hechos revisados de propuestas, cómo guardar conocimiento nuevo y cómo tratar identidades, con una referencia de todas las herramientas `memory_*` generada desde las operaciones reales. Se actualiza con cada versión de la app mientras no se edite; una copia editada se conserva y una borrada no vuelve.

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

Artefactos por release: `AgentHub-arm64.dmg`, `AgentHub-x64.dmg`, `AgentHub-Setup-x64.exe`, `AgentHub-Setup-arm64.exe`, `AgentHub-x64.zip`, `AgentHub-arm64.zip` (Windows portable), `AgentHub-x86_64.AppImage`, `AgentHub-arm64.AppImage`, `AgentHub-amd64.deb` y `AgentHub-arm64.deb`. `workflow_dispatch` corre la misma compilación sin publicar, para probar el pipeline. Publicar el tag es todo lo que hace falta para que las instalaciones existentes se actualicen: el updater (`desktop/src/updater.ts`) lee `releases/latest` de la API de GitHub y baja el artefacto de su plataforma por nombre, así que los nombres de arriba no deben cambiar. `ci.yml` corre lint, typecheck y todas las pruebas en cada push a `main` y en cada pull request.

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
