# Prueba de chat local entre agentes

Fecha: 2026-10-19. Resultado: **el circuito de colaboración funciona con sesiones interactivas reales de Claude Code y Codex en macOS**. Este ensayo es independiente de la aplicación instalada y de los proyectos compartidos/P2P. No constituye una implementación de producción.

## Resultado observado

Versiones instaladas: Claude Code **2.1.303**, Codex CLI **0.163.0**. Se conservaron los modelos configurados por la persona; no se eligieron modelos alternativos.

| Comprobación | Resultado |
| --- | --- |
| Registro desde el hook de inicio, antes de pedirlo al modelo | Pasó en ambas CLI |
| Identidad conocida por el agente y usada como remitente | Pasó |
| Dos Codex simultáneos, con identidades distintas | Pasó |
| Mensaje dirigido sólo al segundo Codex | Pasó; una única lectura por el destinatario correcto |
| Mensaje a Claude inactivo que inicia otro turno | Pasó con `asyncRewake` |
| Mensaje a Codex inactivo que inicia otro turno en la misma sesión | Pasó con `codex queue` |
| Revisión → hallazgo → corrección → segunda revisión → aprobado | Pasó sin intervención en las terminales entre mensajes |
| Reanudar Codex con el mismo identificador nativo y binding del ensayo | Conservó identidad |
| Cierre normal | Evento `SessionEnd`, luego sin conexión |
| Cierre abrupto de un segundo Codex con SIGKILL | Sin conexión al vencer la ventana de pulso de 20 s; su último estado de actividad seguía siendo idle |
| Archivo corregido | 4/4 casos ejecutados por el controlador del ensayo |

El ejercicio partió de un archivo deliberadamente defectuoso, suministrado por el ensayo: `add(a,b)` devolvía `a-b`. Claude pidió revisión de la revisión 0; Codex leyó el archivo con una herramienta limitada al fixture y reportó el error con dos ejemplos. Claude cambió el retorno a `a+b`, solicitó revisión de la revisión 1 y recibió aprobación. Los agentes hicieron revisión por inspección, no afirmaron haber ejecutado tests. El controlador ejecutó cuatro casos después.

Identidades observadas: `claude-d043b1`, `codex-57ced8` y `codex-5ddfb4`. El ciclo principal generó cuatro mensajes entre agentes. Con el pedido inicial y el ensayo de enrutamiento fueron seis mensajes, todos leídos. No se enviaron mensajes a personas o al foro compartido real.

Del envío a la llamada de lectura del agente se observaron **2,7–3,3 s para Claude** y **11,1–14,6 s para Codex**. Esto incluye el arranque del turno y la inferencia; no es una garantía de latencia del transporte ni un benchmark general.

Evidencia original de esta ejecución:

- `/tmp/agenthub-local-chat-poc/events.jsonl`: registro de hooks, herramientas y mensajes.
- `/tmp/agenthub-local-chat-poc/review-completed.json`: estado al completar la revisión.
- `/tmp/agenthub-local-chat-poc/final-state.json`: estado después de cerrar las tres sesiones.
- `/tmp/agenthub-local-chat-poc/summary.json`: versiones, identidades, latencias y resultado.

## Mecanismo comprobado

Un broker HTTP ligado a `127.0.0.1`, autenticado con un token efímero en un archivo privado, recibe los eventos de inicio y asigna la identidad. Un servidor MCP de prueba por sesión expone sólo identidad, bandeja, envío y lectura/escritura del fixture. Un pulso de ese proceso informa su conectividad.

Claude instala un hook `Stop` con `asyncRewake`. El hook mantiene una petición HTTP pendiente; el broker la responde al llegar un mensaje. El hook devuelve un aviso con código 2 y Claude inicia otro turno. `inbox` devuelve el mensaje y registra la lectura. El siguiente `Stop` vuelve a armar la escucha.

Para Codex, el broker ejecuta `codex queue --thread <id-nativo> --message <aviso>` cuando tiene un destinatario idle. La CLI instalada entrega ese aviso a la sesión interactiva existente e inicia el turno, sin simular teclado. El aviso contiene IDs de pendientes; el contenido se recupera con `inbox`. No se creó un segundo proceso de inferencia para reemplazar a la sesión destinataria.

El modelo no pregunta periódicamente si hay mensajes. La espera ocurre en Node y HTTP. Las llamadas al modelo comienzan al entregar el aviso. En la primera preparación Codex bloqueó las herramientas MCP porque exigían aprobación con política `never`; se corrigió autorizando **sólo el MCP efímero `lab`**, en los argumentos del ensayo. Se mantuvo el sandbox de lectura de Codex. La escritura del fixture la realiza una herramienta acotada, disponible sólo para Claude.

## Reproducir

Requiere dependencias del repositorio instaladas, ambas CLI autenticadas y una versión compatible. El ensayo usa inferencia real y consume la cuota normal de los clientes. No configura modelos ni cambia el perfil global de Agent Hub.

Desde la raíz del repositorio, elegir una carpeta temporal nueva:

```sh
node scripts/local-chat-probe.mjs setup /tmp/agenthub-chat-new
node scripts/local-chat-probe.mjs broker /tmp/agenthub-chat-new
```

Dejar el broker ejecutándose y abrir otras dos terminales:

```sh
/tmp/agenthub-chat-new/codex-launch.sh
```

```sh
/tmp/agenthub-chat-new/claude-launch.sh
```

Aceptar, si aparece, la confianza de la carpeta temporal que acaba de crear el ensayo. Los launchers cargan hooks y herramientas acotados a esta invocación. El launcher de Codex usa `--dangerously-bypass-hook-trust` para los hooks revisados del ensayo; **no es una propuesta de configuración global de producción**. Conserva sandbox de lectura y no activa bypass de permisos de comandos.

Esperar a que ambos agentes anuncien su identidad y terminen el primer turno. Desde otra terminal:

```sh
node scripts/local-chat-probe.mjs status /tmp/agenthub-chat-new
node scripts/local-chat-probe.mjs seed /tmp/agenthub-chat-new claude 'Begin the authorized review exercise. Discover the Codex peer with identity. Read fixture revision 0, then send Codex a request to independently review that revision against its specification. Do not fix it before review. Finish your turn. When Codex replies, fix with fixture_write and request a second review. When approved, stop without courtesy messages.'
```

Después, volver a consultar `status` y `events.jsonl`. Cerrar las dos sesiones y el broker. `seed` es una herramienta exclusiva del controlador del ensayo; los agentes se comunican mediante `send` con identidad exacta, no por nombre de producto.

Contrato del broker, sin inferencia:

```sh
node --test scripts/local-chat-probe.test.mjs
npx eslint scripts/local-chat-probe.mjs scripts/local-chat-probe.test.mjs
```

Comprueba autenticación, identidad idempotente, binding incompatible, dos identidades del mismo cliente, destino inexistente, rechazo de mensajes a uno mismo, entrega por evento, aislamiento de bandejas, recibo de lectura, rechazo de escrituras sobre revisiones viejas y cierre/reapertura. También cubre una corrección detectada durante el ensayo: el estado `closed` debe prevalecer sobre un pulso reciente para calcular `online`.

## Qué falta antes de integrarlo como función permanente

- **Persistencia y reintentos:** el broker del ensayo guarda evidencia en JSONL, pero sus sesiones y mensajes operativos viven en RAM. No reanuda una cola tras reiniciar. El envío de Codex tampoco tiene deduplicación durable ni reconciliación después de un resultado incierto.
- **Identidad nativa:** el ensayo correlaciona hook y MCP con un binding aleatorio incluido en cada launcher. En producción, resolver identidad por cliente, sesión nativa y ejecución; conservar la identidad al reanudar y distinguir dos procesos que abran la misma conversación. No atribuir por el `agent_instance_id` global del cliente ni adivinar entre llamadas iguales.
- **Canales:** el ensayo usa una única carpeta. La implementación debe resolver la ruta real y raíz del worktree; macOS presentó la misma carpeta como `/tmp/...` y `/private/tmp/...`. La branch es metadato, no identidad del canal. El contenido local no debe entrar automáticamente en P2P.
- **Escucha duradera de Claude:** este ensayo tiene una espera de 280 s y un timeout de hook de 290 s, deliberadamente acotados. Tras una espera sin mensajes deja de escuchar. Hay que probar renovación sin turnos vacíos o usar Channels según las capacidades y políticas del cliente. También probar una sesión abierta sin primer prompt: aquí el watcher se arma al terminar el primer turno.
- **Presencia precisa:** `online` indica conectividad, separada de `busy/idle/closed`. Tras SIGKILL no hubo evento de cierre: no se debe presentar el último `idle` como disponibilidad actual. Añadir ejecución/PID con fecha de inicio, expiración, reconexión y estados de espera de autorización. El pulso de un MCP por sí solo no demuestra que la terminal siga existiendo.
- **Bandeja durable:** separar recibido, leído, aceptado, bloqueado y resuelto. El ensayo sólo registra entrega/lectura; una lectura no demuestra resolución. Mantener IDs idempotentes y límites por hilo para evitar ciclos de mensajes.
- **Compatibilidad:** validar cada versión/superficie y Windows/Linux. No alterar políticas de aprobación del cliente para garantizar respuesta. El contenido de un peer no amplía el alcance autorizado por la persona.
- **Casos pendientes:** mensaje mientras el destinatario ejecuta una herramienta, reinicio del Hub, sesión en aprobación, sesión sin primer turno, desconexión larga, archivo cambiado durante revisión y reserva simultánea de archivos.

## Otros clientes

Estas filas son evaluación documental; **no equivalen a ensayos ejecutados**:

| Cliente | Base disponible | Qué falta comprobar |
| --- | --- | --- |
| OpenCode | Servidor con estado de sesiones, eventos y `prompt_async` | Vincular la instancia correcta y comprobar activación/cola mientras trabaja |
| Gemini CLI | Hooks SessionStart, BeforeAgent, AfterAgent | Entrega a una sesión completamente inactiva |
| Kiro | Hooks de inicio y turnos; diferencias entre 2.x y V3 | Detección de versión y mecanismo de activación en reposo |
| Antigravity | SessionStart, PreInvocation, PostInvocation, Stop | Activación externa de la conversación concreta en cada superficie |
| Claude Desktop | MCP local y skill accesible como contexto | Una skill puede indicar registro/lectura en el próximo turno, pero no crea por sí sola un turno externo ni identifica inequívocamente cada conversación |

Referencias oficiales consultadas: [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude Channels](https://code.claude.com/docs/en/channels), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [OpenCode server](https://opencode.ai/docs/server/), [Gemini hooks](https://geminicli.com/docs/hooks/reference/), [Kiro hooks migration](https://kiro.dev/docs/cli/v3/hooks-migration/), [Antigravity hooks](https://www.antigravity.google/docs/hooks), [Claude Desktop MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop). `codex queue` y sus parámetros se verificaron además contra `--help` y la CLI instalada.
