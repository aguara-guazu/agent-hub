# Local y remoto

Agent Hub Desktop es la autoridad sobre lo que se ejecuta en la computadora de la persona. Un servicio remoto opcional puede aportar identidad o contenido compartido, pero nunca puede encender una herramienta local ni saltarse el gateway.

## Regla

> Quien ejecuta, decide.

- MCP servers, skills, secretos y políticas de exposición viven localmente.
- El gateway evalúa cada llamada en la misma máquina que ejecutará el upstream.
- Un servicio de conocimiento remoto aplica sus propios permisos porque conserva el contenido.

## Producto local

Electron supervisa dos procesos internos:

1. `packages/core/dist/server.js`: Fastify, SQLite y renderer en loopback.
2. `packages/daemon/dist/cli.js run --local`: detección, sync, adaptadores y materialización.

Los clientes lanzan un tercer proceso por demanda:

```text
Agent Hub --agenthub-headless gateway --agent <id> --state-dir <estado>
```

Ese proceso sólo habla MCP por stdin/stdout. No abre puertos y no toma el lock de la aplicación Electron.

## Sesión local

Loopback no autentica. Al arrancar, Electron crea un bootstrap aleatorio en memoria y lo hereda al core y al daemon. El core sólo acepta ese valor en `/api/auth/desktop-session`, emite el JWT del dueño local y Electron abre la consola con `sso_token` una vez. La consola lo mueve a su almacenamiento y limpia la URL.

El bootstrap no se persiste. La clave JWT sí se conserva con permisos restrictivos para que la sesión sobreviva reinicios. El daemon intercambia la sesión por un token opaco de máquina y guarda únicamente ese token en su archivo `0600`.

## Persistencia

El directorio `userData` contiene:

```text
hub.db                 catálogo, políticas y auditoría
jwt.secret             firma de sesiones locales
credentials.json       token opaco del daemon
agents.json             clientes detectados
snapshots/<agent>.json último estado válido
managed.json            regiones y skills administradas
```

Antes de modificar un esquema reconocido, las migraciones crean una copia de seguridad. `schema_migrations` registra la versión aplicada.

## Background y autostart

Cerrar la ventana la oculta; core y daemon siguen activos. Salir desde el tray detiene primero daemon y luego core. El autostart usa:

- macOS/Windows: login item de Electron.
- Linux: entrada XDG en `~/.config/autostart`.

## Servicio remoto opcional

Un MCP remoto se configura como cualquier otro upstream:

```json
{
  "slug": "conocimiento",
  "transport": "http",
  "url": "https://kb.example/mcp",
  "secret_refs": { "Authorization": "keychain://agenthub/kb-token" }
}
```

Sin internet, los servidores y skills locales siguen funcionando. La llamada al remoto falla con un error acotado; la política local y la auditoría siguen aplicándose.

## Plataformas

El mismo código se compila para macOS, Windows y Linux. Las diferencias quedan detrás de adaptadores de rutas, keychain, autostart y symlinks. El empaquetado conserva core y daemon fuera de ASAR para ejecutarlos con `ELECTRON_RUN_AS_NODE` en las tres plataformas.
