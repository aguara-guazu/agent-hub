# Colaboración local de agentes

La sección **Proyectos → Colaboración** permite observar conversaciones privadas de esta computadora. Los canales sin proyecto están en **Memoria → Colaboración sin proyecto**. No replica contenido al foro de proyectos compartidos. Las personas pueden buscar, leer, expulsar participantes, designar coordinadores y aprobar planes exactos desde los controles específicos de la UI; el servidor rechaza publicaciones, registros de agente, cierres de hilo y acknowledgements de mensajes enviados por la API de la interfaz.

## Organización

- **Proyecto:** se resuelve por sus carpetas configuradas. Los worktrees externos también pueden heredar el proyecto de su repositorio Git principal.
- **Canal:** ámbito explícito de una tarea, independiente de carpetas, worktrees Git y espacios de Orca. El master lo crea con `memory_chat_create_channel` después de preguntar a la persona y obtener autorización. Varias sesiones pueden trabajar en la misma carpeta con canales distintos. Las rutas y los identificadores de ejecución son metadatos.
- **Hilo:** una tarea o revisión, con título, estado abierto/resuelto y vínculo opcional a una tarea del proyecto. No hay subhilos anidados. `reply_to` referencia un mensaje del mismo hilo.
- **Participante:** una conversación concreta. Dos terminales de la misma CLI tienen identidades distintas. Reanudar la misma conversación nativa conserva su identidad. Los autores, mensajes y recibos históricos permanecen al cerrar las terminales.

Al inicio de cada tarea, la skill obliga al agente principal a preguntar si se usará el grupo multiagente del Hub o sólo el agente normal. Una elección explícita en el pedido ya responde esa pregunta; no se repite durante la misma tarea. En modo individual no se registra nick ni se consulta inbox. Los workers con invitación aprobada siguen su asignación.

El master pregunta además si puede crear el canal, indicando nombre y objetivo; ambas decisiones pueden consultarse juntas. Elegir multiagente por sí solo no autoriza crear canales. Los hooks mantienen conexiones privadas, pasivas e invisibles, también en Git y Orca. Elegir un nick no activa el canal ni incorpora otras sesiones.

`memory_chat_create_channel(task_key, name)` conserva la identidad y clave, mueve sólo al solicitante y lo designa coordinador. La clave permite reintentar el canal actual; otra sesión puede usar el mismo ticket sin apropiarse de ese canal. Sin `task_key` se usa `name` o `default`. No permite abandonar equipos ni trabajos pendientes. `memory_team_prepare` requiere un canal activo y nunca lo crea ni activa implícitamente. Los workers se incorporan mediante invitaciones del plan aprobado.

Separar canales no separa archivos: las ediciones paralelas pueden requerir worktrees distintos. La ruta de ejecución se valida al preparar o lanzar un equipo; eliminar el worktree no deshabilita el chat ni su historial. Los canales anteriores y sus membresías se conservan al actualizar; las conexiones nuevas ya no se agrupan por ruta. El líder puede cerrar su canal por pedido de la persona: se cancelan entregas, se cierran sesiones y se conserva el historial.

La búsqueda incluye texto de títulos y mensajes, estado, proyecto, canal y autor histórico. Lecturas y listados se paginan. Las menciones se dirigen a IDs concretos del mismo canal; consultar otros canales no concede participación en ellos. Un mensaje sin menciones queda en el historial y no despierta a nadie.

Al registrar una conversación nueva, el Hub comprueba que su directorio real esté dentro de la ruta del espacio de Orca. Un identificador heredado que apunta a otro proyecto se descarta: la conexión conserva un ámbito privado con su carpeta real como contexto de ejecución. Se admiten subcarpetas y enlaces simbólicos equivalentes, pero no rutas que sólo comparten un prefijo. Esta comprobación no cambia la asociación persistida de conversaciones reanudadas ni mueve su historial.

## Nicks y navegación

Cada agente elige su propio nick mediante `memory_chat_set_nick({nickname, session_key})`. Los hooks registran la sesión automáticamente, pero no inventan el nombre por él. Hasta elegirlo, la respuesta al agente contiene sólo su ID, clave y estado de registro: no recibe canal, ruta, nombre del líder, participantes ni mensajes. Las consultas MCP de colaboración, incluso históricas sin clave, se rechazan para agentes sin nick. La UI del dueño conserva sus lecturas. Los conflictos de nick no revelan quién lo ocupa ni sugieren alternativas. Los hooks siguen el mismo filtro; al reanudar se conserva la identidad. `chat_join` devuelve `needs_nickname` para distinguir una sesión nueva de una reanudada. El nick admite de 2 a 40 caracteres Unicode visibles; no acepta UUIDs ni identificadores nativos. Se normalizan espacios, compatibilidad Unicode y mayúsculas para comprobar unicidad atómica en todo el Hub, también frente a sesiones desconectadas. Un conflicto solicita al agente elegir otro nick, sin agregar sufijos automáticamente.

El agente puede redefinir su nick usando su misma clave; sus mensajes anteriores muestran el nombre actual. Al reanudar conserva el nick. Los IDs internos se mantienen para enrutar menciones y conservar autores y recibos sin ambigüedad. Las personas sólo observan y no pueden elegir ni cambiar nombres desde la UI.

La navegación mantiene los canales en el panel izquierdo. El panel central muestra los hilos del canal con búsqueda, filtros, participantes e historial. **Abrir hilo** reemplaza ese listado por la conversación completa y sus mensajes; **Volver al canal** recupera el listado y sus filtros. Canal, hilo y paginación se reflejan en la URL para enlaces directos y navegación del navegador.

La lista de agentes empieza oculta. **Mostrar agentes** abre una columna derecha con scroll propio; **Ocultar agentes** devuelve ese espacio a la conversación. Los expulsados desaparecen del listado vigente, incluidos sus totales y páginas, mientras sus mensajes y autoría permanecen en el historial. Los agentes desconectados que siguen siendo miembros se conservan en la lista. En pantallas estrechas, los paneles se apilan.

## Expulsar participantes

En **Proyectos → Colaboración**, cada tarjeta permite **Expulsar del canal**. La persona confirma el destinatario y puede agregar un motivo. También puede ordenárselo al líder reconocido, que usa:

```json
{"session_key":"CLAVE_DEL_LIDER","channel_id":"ID_DEL_CANAL","participant_id":"ID_DE_LA_SESION","reason":"La persona pidió retirar a este agente de la tarea"}
```

La herramienta es `memory_chat_kick`. El servidor verifica el liderazgo vigente, la identidad del solicitante y que ambos pertenezcan al mismo canal. Un miembro no puede expulsar, el líder no puede expulsarse a sí mismo y el acceso de la UI requiere la sesión autenticada del dueño local, no un token de daemon. El motivo queda registrado con fecha y autor de la expulsión; reintentar no cambia ese registro.

La sesión pasa a **Expulsado**, se cancelan sus menciones pendientes sin marcarlas leídas o atendidas, se cierran sus escuchas y se rechazan nuevos mensajes, menciones hacia ella, herramientas de chat y reconexiones de esa conversación. Sus mensajes y nick quedan en el historial, que la persona y los demás agentes pueden seguir consultando. Una conversación nueva es otra identidad; no es una prohibición de usar esa CLI. El agente no debe crear sesiones o cambiar claves para eludir una expulsión.

La expulsión no mata procesos, no revierte cambios y no interrumpe tareas ya iniciadas. Un aviso aceptado antes de la expulsión puede haber llegado a la CLI, pero las siguientes operaciones del chat se rechazan. Si la persona expulsa al líder desde la UI, el canal queda sin líder hasta el siguiente pedido humano o registro explícito de una sesión habilitada.

## Entrega y presencia

`chat_sessions`, `chat_channels`, `chat_threads`, `chat_messages` y `chat_deliveries` viven en SQLite. Los canales virtuales guardan estado pendiente, fecha de activación y fecha de cierre; los pendientes no aparecen en el listado de canales. El envío y sus destinatarios se guardan en una transacción. Cada autor proporciona un `request_id`: reintentar el mismo contenido devuelve el mismo mensaje; reutilizarlo para otro contenido falla. La clave de sesión distingue conversaciones incluso cuando dos llamadas MCP concurrentes serían indistinguibles para el gateway. La base guarda su hash y la auditoría del gateway sólo guarda hashes de argumentos.

El proceso HTTP del Hub atiende eventos y revisa entregas persistidas cada cinco segundos. No consume turnos de modelo para escuchar. Reiniciar el Hub no pierde mensajes. Una reclamación atómica evita notificaciones simultáneas de una misma entrega; hay hasta cinco intentos con espera creciente. Una nueva apertura de la sesión reinicia los intentos de sus mensajes sin leer. Se conservan por separado:

1. **Pendiente:** guardado para el destinatario.
2. **Notificado:** el transporte aceptó el aviso, sin demostrar lectura.
3. **Leído:** el destinatario recibió el contenido mediante inbox o lectura del hilo.
4. **Atendido:** el destinatario lo confirmó explícitamente después de actuar o responder.

La UI nunca consume esos recibos. La entrega es al menos una vez: un cierre entre aceptación nativa y registro del recibo puede repetir el aviso. La bandeja y la clave idempotente del envío permiten evitar acciones y respuestas duplicadas. Un aviso no garantiza que el modelo haya leído, que tenga aprobación para usar la herramienta ni que haya completado una tarea.

Los hooks informan inicio, actividad, parada, interrupción y cierre. Cuando se identifica un proceso CLI propio, el Hub verifica PID y fecha de creación; un PID reciclado no mantiene una sesión viva. Sin testigo válido ni evento reciente, la UI indica **Sin señal reciente**, no inventa que sigue conectado. Un daemon compartido no es un testigo de vida suficiente para todas sus conversaciones. El helper usa `ps` en macOS/Linux y una consulta de proceso en Windows.

## Clientes y terminales

Los lanzadores `agenthub-claude`, `agenthub-codex`, `agenthub-gemini`, `agenthub-kiro`, `agenthub-opencode` y `agenthub-agy` abren **la TUI original de cada CLI**, dentro de una pseudoterminal propia del Hub. Pasan teclado, colores, ratón, tamaño y argumentos al cliente. Kiro se abre con `chat --tui`. No reemplazan sus ejecutables ni dependen de Orca.

```sh
cd /ruta/del/worktree
agenthub-codex
agenthub-kiro --model TU_MODELO --effort high
# Si elegís desactivar las confirmaciones de Kiro:
agenthub-kiro --trust-all-tools --model TU_MODELO --effort high
# Reanudación con la sintaxis nativa del cliente:
agenthub-kiro --resume-id ID_NATIVO
agenthub-codex resume ID_NATIVO
```

No hace falta un `--` adicional en los lanzadores. El comando interno sí separa sus opciones de las nativas: `agenthub chat --agent ID --state-dir RUTA -- OPCIONES_NATIVAS`. Los lanzadores incluyen ese separador, el ID instalado y la ruta del estado; no contienen credenciales.

El Hub registra cada terminal antes del primer prompt y mantiene una espera HTTP local. Sólo entrega su aviso fijo cuando reconoce el compositor vacío y estable. Si hay texto de la persona, un turno activo, un menú de permisos o una pantalla desconocida, espera. El aviso pide consultar la bandeja: no pega el cuerpo de mensajes ajenos ni responde aprobaciones. El modelo, esfuerzo, sandbox y permisos los interpreta la CLI original. Las opciones de confianza se pasan sólo si la persona las proporciona.

Una versión nueva de la CLI que cambie su compositor puede necesitar actualizar el detector. En ese caso la entrega se difiere; la bandeja sigue accesible por herramientas. La conexión sin trabajo pendiente no usa inferencia. Incorporarse al equipo y atender menciones sí ejecuta turnos del modelo. Cerrar la TUI cierra su conexión; PID y fecha de inicio permiten detectar cierres abruptos.

El daemon instala estos comandos al sincronizar un cliente con `chat_join` habilitado: `~/.local/bin` en macOS/Linux y `~/.agenthub/bin/*.ps1` en Windows. Se preservan las ediciones personales mediante el manifiesto de archivos administrados. La autenticación y confianza inicial del cliente siguen a cargo de su TUI. `--help`, `--version` y las ejecuciones con entrada/salida redirigidas conservan su comportamiento nativo sin registrar agentes fantasma.

Las identidades del Hub se enlazan con el ID nativo cuando el cliente lo informa por hooks o entorno MCP. Reabrir ese ID explícito conserva el nick. Los selectores interactivos de historial, `--continue`/`--last` y los clientes que no informan ese ID todavía no permiten recuperar el vínculo de forma fiable: pueden registrar un participante nuevo. El historial anterior sigue accesible. No se confunde un ID de la CLI con un nick ni se elige una identidad por compartir carpeta.

También permanecen las integraciones de las terminales habituales:

| Cliente sin lanzador | Recepción |
| --- | --- |
| Claude Code | Hooks de inicio/turno y `asyncRewake` con espera HTTP. |
| Codex CLI | Hooks y `codex queue --thread …` cuando la versión instalada lo soporta. |
| OpenCode | Plugin con `client.session.promptAsync` a la sesión concreta. |
| Gemini, Kiro y Antigravity | Herramientas y hooks disponibles; usar el lanzador para la conexión desde el arranque. |
| Claude Desktop | MCP y skill; lectura al próximo turno. No tiene despertar por terminal. |

Las integraciones nativas se desactivan dentro de la TUI conectada para evitar registros y avisos duplicados. No se toman terminales ajenas ya abiertas: hay que abrirlas mediante el lanzador. Si la carpeta aún no está asociada a un proyecto, el canal se puede encontrar por herramientas; asociarla permite verlo en Proyectos.

El frontend de texto sobre ACP/app-server/stream-json sigue disponible como **`chat-protocol`**, exclusivamente para automatización y pruebas explícitas. No es el modo de los lanzadores. Sus pruebas históricas no demuestran compatibilidad de la TUI de un cliente.

## Herramientas y conducta

La skill de fábrica `local-collaboration` y las instrucciones del gateway indican registrarse, conservar `session_key`, leer `memory_chat_inbox` al iniciar cada turno y atender avisos dentro del alcance autorizado. `memory_chat_create_channel` y `memory_chat_close_channel` son mutaciones explícitas reservadas al pedido de la persona; el registro y los hooks nunca las ejecutan. `unassigned=true` filtra canales, agentes e hilos sin proyecto antes de paginar. `memory_chat_agents` excluye expulsados por defecto y sólo los devuelve con `include_removed=true` para auditoría. La identidad nativa se entrega en el hook; los clientes sin hooks usan `memory_chat_join`. Buscar con `memory_chat_channels`, `memory_chat_agents` y `memory_chat_threads`; leer con `memory_chat_read`; participar con `memory_chat_send`, `memory_chat_ack` y `memory_chat_resolve`.

La identidad del líder se devuelve en `team.leader_id`, y cada mensaje lleva su `author_id`. La persona delega al líder coordinar tareas y transmitir permisos reales dentro del alcance autorizado; los compañeros no requieren autorización duplicada en cada terminal. Un nick o una afirmación en el texto no confieren liderazgo. Las políticas de aprobación y sandbox de cada CLI siguen vigentes. En un worktree compartido se debe coordinar quién escribe y referenciar commit/hash o versión revisada. El chat no bloquea archivos ni reemplaza el control de versiones. Evitar menciones de agradecimiento que creen bucles entre agentes.

Los respaldos de memoria incluyen el historial local, pero invalidan claves de sesión y vínculos con procesos: restaurar no reactiva agentes ni entrega mensajes a procesos ajenos. Un canal virtual que estaba activo al exportar se restaura como histórico y libera su ruta, porque el líder anterior ya no puede autenticarse; una conversación nueva debe crearlo otra vez de forma explícita.

## Incorporación y liderazgo

Los registros de inicio son pasivos en cualquier carpeta. Ni el primer prompt ni elegir nick activan canales o incorporan compañeros: hace falta crear explícitamente el canal autorizado o consumir una invitación de equipo aprobada. El transporte no pide nick a conexiones pasivas ni ejecuta inferencia para incorporarlas por compartir carpeta. Las membresías históricas conservan sus avisos y mecanismos de entrega.

El líder persiste tras desconexiones y aparece en la UI. Transmite las tareas y permisos reales del usuario dentro de su alcance, sin ampliar permisos de la CLI. Las menciones sin leer tienen reintentos independientes; una lectura de la persona no los consume.

## Equipos mixtos en worktrees hijos de Orca

Un líder activo en un canal de Orca puede consultar el catálogo local, preparar una composición y, después de que la persona elija el plan exacto, lanzar miembros en worktrees hijos. El flujo usa seis herramientas: `memory_team_catalog`, `memory_team_prepare`, `memory_team_launch`, `memory_team_status`, `memory_team_join` y `memory_team_close`.

1. **Catalogar no autoriza.** El catálogo informa instalación, modelos, esfuerzos y capacidades con procedencia y fecha. Los candidatos `ExtractionCli` son Claude Code, Codex y Kiro. Claude Code y Codex usan `agent launch`; Orca rechaza selección de modelo para Kiro por esa ruta. El adaptador soporta Kiro inicialmente sólo en POSIX mediante `terminal create --command` con el launcher fijo `agenthub-kiro`; primero verifica plataforma y launcher, antes de crear el worktree. Windows queda no-launchable con error explícito hasta disponer de un runner seguro. Kiro expone `--model`, `--effort` y `--list-models`, pero su catálogo no relaciona efforts con modelos. Que un modelo figure no prueba inference, effort compatible, cuota, autorización de la cuenta ni disponibilidad futura. Un valor desconocido o vencido falla cerrado; no se reemplaza por otro cliente o modelo.
2. **Preparar no lanza.** `memory_team_prepare` persiste un plan inmutable y su digest con objetivo, tarea, roles, miembros y padre `{id, repo_id, path, head}`. La entrada es `objective`, `base_revision`, `members` y la identidad de sesión; el padre lo obtiene la herramienta desde Orca, no se envía como argumento. El plan se muestra completo para que la persona decida. Preparar no crea worktrees, procesos ni invitaciones utilizables.
3. **La orden es explícita y exacta.** `memory_team_launch` requiere el ID y digest del plan y una referencia textual a la instrucción de la persona, declarada por el líder. Esa referencia queda para auditoría pero no pretende ser autenticación humana ni un grant de UI; usa la misma frontera conversacional que otras acciones delegadas al líder. Antes de cada efecto, el servidor vuelve a comprobar líder y sesión abiertos/no expulsados, canales activos, catálogo y padre `{id, repo_id, path, head}`; discovery previo no reemplaza esa validación porque puede demorar. Las políticas de aprobación y sandbox de cada CLI siguen vigentes y el Hub no agrega flags de confianza.
4. **Cada efecto tiene estado.** La intención se guarda antes de pedir a Orca crear el worktree o lanzar la CLI. Los recibos distinguen `workspace_intent`, workspace creado, `launch_intent`, `launching`, aceptado, `unknown` e incorporación completada; una respuesta aceptada tardía nunca reemplaza `joined`. `memory_team_status` expone `launch_handle` y `operation_id` para inspección y reconciliación; no son secretos ni invitaciones. Un error después de crear la terminal conserva `launch_handle`, y un `TeamOrcaError` que incluya `operation_id` lo conserva al pasar a `unknown`. Al reiniciar, estados con efectos en vuelo pasan a incierto/paused y requieren recovery manual: no se reintentan automáticamente. El rollback no cierra terminales ni elimina worktrees.
5. **El hijo conserva su identidad.** Cada miembro abre una conversación nueva con ámbito privado en su worktree; la invitación activa su canal. `memory_team_join` vuelve a comprobar master/líder/canales activos y exige el `agent.orca_workspace_id` exacto del slot; no alcanza una ruta o symlink coincidente. Consume atómicamente una invitación con TTL y hash en reposo, ligada a plan, slot, miembro, workspace y CLI. Para Kiro, el adaptador espera `tui-idle`, lee un compositor vacío y envía una sola vez el prompt con `terminal send --text`; la invitación pasa en ese argv transitorio, no como comando de shell. No es una `session_key`; sólo su hash persiste y el valor no aparece en status, logs ni mensajes del equipo. No se mueve ni reenvincula una sesión nativa existente de canal.
6. **La coordinación es acotada.** El master conserva la coordinación del equipo; los canales hijos conservan sus propios líderes y permisos. El vínculo cross-channel sólo permite reportar en el hilo raíz del equipo, con autor, canal y worktree de origen. No habilita escribir o expulsar en todo el canal master. Cierre, expulsión, cancelación o restore revocan o pausan vínculos pendientes; el historial y la procedencia permanecen.
7. **Cerrar no destruye.** Cuando la persona termina la coordinación, sólo el master vigente llama `memory_team_close` con `plan_id`, digest y motivo. El plan queda cancelled/closed y se revocan invitaciones y ACL, pero procesos, terminales, worktrees e historial permanecen. Cada efecto revalida el cierre antes de empezar; un efecto ya iniciado puede guardar su recibo final sin reabrir el plan ni habilitar otro.

Orca es el proveedor local de discovery, creación de worktrees y launch. El lifecycle, las invitaciones y la coordinación pertenecen al Hub; este flujo no usa `worker-start`. Para Claude Code y Codex, el adaptador registra el outcome real (`structured` o `terminal`) decidido por **Chat UI**. Para Kiro, crea la terminal con `agenthub-kiro` y flags separados/quoted de `--model` y `--effort`, sin INPUT posicional; espera `tui-idle`, verifica el compositor vacío y hace un único `terminal send` del prompt. No agrega trust flags, cambia permisos ni elimina el modelo. El recibo `prompt_outcome: input-accepted` prueba aceptación del input, no inicio de inferencia ni join. Sus errores son sanitizados y nunca exponen stdout o stderr crudos. Los lanzadores y la colaboración ya iniciada siguen hablando directamente con el Hub: Orca no se convierte en transporte de mensajes.

`ORCA_WORKTREE_ID` es únicamente identidad del espacio. El transporte anterior por teclado de Orca fue retirado. Ninguno de los lanzadores necesita el ejecutable de Orca ni su runtime.

## Verificación

Los ensayos de orquestación usan un Hub aislado y worktrees temporales; nunca el daemon ni la memoria personal. Las pruebas unitarias del adaptador no demuestran por sí solas un equipo real: antes de declarar compatibilidad o publicar hay que instalar las nuevas tools en ese entorno aislado y completar catálogo → prepare → orden exacta → launch → join → status, incluidos resultado incierto y reconciliación. Mientras ese recorrido no exista, se informa como pendiente y no se lanza un equipo de ejemplo sobre el producto instalado.

- `npm test`, `npm run typecheck` y `npm run lint`: persistencia, autorización, identidad, nicks, reintentos, hooks, protocolos y UI.
- `node scripts/test-local-chat-e2e.mjs`: Hub aislado, MCP real y navegador; canal, hilo, búsqueda y recibos de lectura.
- `node scripts/test-local-chat-transports.mjs --tui-contracts`: seis lanzadores generados con CLIs simuladas dentro de PTYs reales. Verifica argumentos exactos, incorporación, aviso, espera ante permisos/borradores, tamaño y cierre. Sin Orca.
- `node scripts/test-local-chat-transports.mjs --kiro-tui`: TUI real de Kiro con modelo autenticado, perfil temporal y Hub aislado; incorporación y mención → lectura → respuesta → atención. No modifica la configuración personal.
- `node scripts/test-local-chat-transports.mjs --contracts`: contratos del frontend explícito `chat-protocol`. Las opciones `--kiro`, `--opencode` y `--gemini RUTA` prueban los transportes de protocolo, no la nueva TUI.
- `npm run build && node scripts/readme-screenshots.mjs`: capturas de la UI real con SQLite y datos ficticios aislados. No usa la memoria personal.

Los ensayos nativos se hacen en macOS. Windows/Linux tienen lanzadores y binarios PTY preparados por plataforma, pero no se validaron aquí con clientes reales. Gemini y Antigravity requieren validar despertar en su TUI con autenticación; los contratos simulados no reemplazan esa comprobación. Los detectores se limitan a compositores conocidos.

Referencias: [hooks y asyncRewake de Claude Code](https://code.claude.com/docs/en/hooks), [hooks de Codex](https://developers.openai.com/codex/hooks), [TUI de Kiro](https://kiro.dev/docs/cli/reference/settings/). Las opciones nativas también se verifican con la ayuda de la CLI instalada.


Para recomendar la composición, la skill usa descripciones nativas y `role_hints`
marcados como heurísticos: razonamiento/diseño, implementación, revisión y
exploración rápida. Presenta por miembro CLI, modelo exacto, esfuerzo, rol, tarea
 y worktree; puede ofrecer una opción pequeña y otra con más paralelismo. Una
orden previa que ya define y autoriza ese equipo sigue siendo válida: no exige
repetir la autorización. Cambiar la composición sí requiere la elección de la
persona. “El más nuevo” se resuelve con el catálogo disponible o se aclara si la
CLI no aporta evidencia suficiente.

## Preparación y recuperación de equipos

El agente consulta `memory_team_catalog` antes de investigar extensamente el ticket. `launch_context.readiness` devuelve todos los bloqueos detectados con código, explicación y siguiente acción; `preferred_backend` conserva la preferencia del dueño (Hub por defecto). Un impedimento no autoriza cambiar silenciosamente a subagentes nativos o resolver individualmente el pedido de equipo.

Para un equipo nuevo, con o sin Git, `readiness.task_channel_available` indica que se puede crear un canal de tarea con `memory_chat_create_channel(session_key, task_key, name)` después de preguntar a la persona y obtener autorización. No requiere reemplazar al líder del canal de entrada, esté conectado o no. El canal virtual conserva el contexto conversado; no copia ni aísla archivos.

Para continuar el trabajo del canal existente, la persona puede designar un coordinador desde el panel de agentes. La operación compara el líder que se mostró con el vigente para evitar sobrescribir una elección concurrente. Pausa planes anteriores, revoca invitaciones y vínculos, cancela entregas y detiene trabajadores del Hub; si no confirma una detención lo informa. Una desconexión temporal no cambia el liderazgo automáticamente. Los procesos ajenos al Hub no se detienen.

`memory_team_prepare` admite `repository_path` sin trasladar la sesión coordinadora. La revisión base es opcional: por defecto usa HEAD, pero acepta el hash completo de cualquier commit local verificado del repositorio. Conserva el HEAD observado del origen por separado; no cambia su rama, índice ni archivos. Los worktrees hijos nacen del commit aprobado, aunque una referencia como origin/develop avance después. Si la carpeta es realmente ajena a Git, el Hub ofrece un espacio virtual con revisión `virtual`. No inicializa Git: crea directorios propios y guarda su procedencia bajo su estado local. No copia ni aísla los archivos originales. Un Git ausente, roto o inaccesible no habilita esta alternativa automáticamente.

Los trabajadores arrancan sólo con instrucciones de registro y una invitación opaca. Después de elegir el nick, `memory_team_join` entrega tarea, instrucciones y espacio de origen. La invitación aprobada activa también el canal virtual del miembro.

El plan devuelve `approval_url`: la UI permite revisar composición, instrucciones, permisos, ubicación y revisión, y aprobar ese digest exacto sin copiarlo. La ruta sólo acepta credenciales del dueño. El hilo del equipo incluye «Revisar y aprobar equipo»; no hace falta conocer la URL ni copiar un digest. Los recibos separan espacios creados, procesos iniciados e incorporaciones; ninguno equivale a trabajo entregado. El historial permanece disponible.


## Liderazgo y operadores

El coordinador actúa como TL: toma decisiones técnicas dentro del alcance aprobado, reparte responsabilidades junior/ssr/senior, integra y pide evidencia. Escala decisiones de producto, permisos o accesos faltantes. Conserva autorizaciones previas y respeta gates que la persona pidió; no agrega aprobaciones por cada cambio de texto.

Los modelos chicos operan herramientas de alto volumen (browser, comandos largos, búsquedas, extracción de archivos), dirigidos por el TL o por pares responsables de implementación/revisión. Responden al solicitante en el hilo del equipo con resultados y evidencia suficiente; los conflictos vuelven al TL. El tamaño del output no determina la dificultad del razonamiento: la interpretación ambigua se escala. Esperas como “hasta que exista PR” se registran como trabajo waiting, en lugar de inferirse de idle.

Después del nickname, `memory_team_join` entrega `peers` y `authorization` con plan/digest, alcance, encargo originalmente aprobado, instrucción y procedencia. `owner_ui` es autorización autenticada de la persona; `coordinator_declaration` es la declaración auditable del líder; `legacy_record` no identifica una procedencia verificada. Ninguna levanta restricciones de la CLI ni autoriza ampliar alcance. Ante un bloqueo, el miembro informa acción, permiso recibido, regla/error concreto y qué falta al TL. No exige repetir directamente en su terminal una autorización que ya recibió dentro de ese alcance.

Para reemplazar un worker se usa `memory_team_control` con generación vigente, `edit` si corresponde y `clear`. Se confirma primero la detención, se cierra la identidad anterior, se cancelan sus avisos y se rota la invitación conservando worktree y modelo. `chat_kick` no administra workers de canales hijos. Reemplazar una conversación no elimina restricciones reales.

## Papelera de canales

`memory_chat_delete_channel(channel_id, reason)` mueve el canal propio a papelera por pedido de la persona; sólo su líder puede usarla. La UI del dueño puede eliminar cualquier canal y restaurar el historial. Eliminar cierra sesiones, cancela equipos coordinados por el canal, revoca invitaciones y entregas e intenta detener workers Hub. Una detención no confirmada devuelve `uncertain_members`, sin afirmar que el proceso terminó. Un canal de un worker todavía vinculado requiere cerrar primero su equipo.

La papelera se consulta con `chat_channels(deleted=true)`. Los canales eliminados desaparecen de listados y búsquedas habituales; las claves anteriores no permiten reincorporarse. Se libera la asociación del espacio para una nueva conversación. Restaurar recupera sólo el historial cerrado: no reactiva equipos, claves o procesos ni recupera la asociación del espacio. No se borran archivos ni worktrees. El contenido permanece en almacenamiento y respaldos; no es un borrado físico de datos.

### Canal visible del equipo y tareas de cada miembro

Los espacios de los trabajadores conservan su aislamiento y su identidad, pero no aparecen como canales independientes en la navegación habitual. `chat_channels` los agrupa bajo el canal coordinador; `include_workers=true` o un `channel_id` concreto permite inspeccionarlos. La agrupación usa la asociación persistida al equipo, no el aspecto de la ruta ni del nombre. `chat_agents(channel_id=<coordinador>)` incluye a los miembros incorporados con `team_role`, `master_channel_id` y `work_thread_id`.

La lista de agentes de la app usa `include_team_history=true`: conserva a los miembros desconectados y de equipos cerrados, con `team_state` y `member_state`, y enlaza a su conversación. El cierre no los hace desaparecer ni los presenta como trabajando. Esta opción no devuelve permisos ni reactiva procesos; `active_only` sigue filtrando actividad real y las sesiones expulsadas o sin nickname permanecen ocultas. Sin esa opción, `chat_agents` mantiene su filtro habitual de sesiones abiertas.

Al preparar un plan se crea un hilo de tarea por miembro, además del hilo de coordinación general. `team_join` devuelve `work_thread_id` y los hilos de los pares; los avisos por falta de reporte apuntan al hilo de la tarea. Si un trabajador vinculado abre un tema desde su canal interno, `chat_send` lo ubica en el canal coordinador con `team_root_thread_id`. Las respuestas, menciones y permisos siguen comprobándose contra ese equipo. Los hilos internos anteriores siguen apareciendo al buscar desde el canal principal.

La app abre las conversaciones y permite cambiar a «Equipo y avances». El estado del proceso, la espera registrada y el último mensaje son evidencias separadas: un proceso iniciado, en reposo o finalizado nunca implica que el trabajo esté entregado. Las tarjetas enlazan al hilo de tarea y, cuando corresponde, al hilo distinto donde se publicó el último reporte. Los planes previos reciben hilos de tarea vacíos al migrar; no se inventan mensajes ni se mueve su conversación histórica.

Para repetir la validación HTTP/MCP y visual: `npm run build && node scripts/test-collaboration-ux.mjs`. Usa una base aislada, el renderer real de Electron, clics, capturas y ventanas de distinto ancho. El lanzamiento de workers y el catálogo son fixtures controladas; esta prueba no valida inferencia de los modelos.

### Pedidos y respuestas verificables

Un pedido de acción o decisión se envía con `response_required=true`, destinatarios y `request_id`. La respuesta usa el mismo `thread_id` y `reply_to` con el mensaje recibido. El Hub notifica al autor aunque falte `mentions`, marca solamente la entrega del agente que respondió y conserva las de sus compañeros. Una mención informativa no genera una obligación de contestar.

Un pedido pendiente no se puede atender con `chat_ack` ni ocultar resolviendo el hilo. Después de cinco minutos sin respuesta, si el receptor no está trabajando, el Hub envía una sola notificación privada al solicitante, ligada al hilo original. La respuesta cancela el aviso pendiente; no se crean hilos, respuestas ficticias ni reinicios. La lista muestra cuántas respuestas faltan y quién debe responder. El estado de entrega distingue lectura, respuesta y atención.

Los reportes de un miembro sin menciones se entregan al coordinador; las instrucciones del coordinador en un hilo de trabajo asignado se entregan a su responsable. Los mensajes a pares usan menciones explícitas y las respuestas conservan el hilo.
