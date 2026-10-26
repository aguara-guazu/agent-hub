# Cuotas de uso y planificación de equipos

Agent Hub conserva observaciones nativas de las cuotas de las CLI para que un líder pueda elegir un equipo y conservar su progreso antes de quedarse sin capacidad. `memory_usage_status` consulta el estado guardado, sus ventanas, origen, fecha de lectura y vencimiento; no inicia una conversación ni consume inferencia para medir. El panel **Clientes → Cuotas de uso** muestra la misma información.

## Cobertura inicial

| CLI | Fuente | Alcance y limitación |
| --- | --- | --- |
| Codex CLI | App-server: `account/read` y `account/rateLimits/read` | Ventanas nativas, duración y reinicio cuando existen. Identidad de cuenta verificada mediante routing ID opaco. El pool `codex` tiene alcance global; pools sin correspondencia documentada a modelos conservan alcance desconocido. |
| Claude Code | Control nativo `get_usage` y JSON de statusline como complemento | Ventanas de cinco horas y siete días, más ventanas específicas cuando existen. `get_usage` es experimental: se valida su respuesta y una versión incompatible queda desconocida. Cuenta sin verificar: lectura limitada al perfil. |
| Kiro | ACP `_kiro/account/getUsage` | Consulta de créditos aun si la CLI omite el método en capabilities. Valida used/limit y reinicio; bonus y sobreconsumo quedan con alcance incierto. Un rate limit temporal no equivale a agotamiento mensual. |
| Gemini CLI | Code Assist `retrieveUserQuota` | OAuth del cliente, porcentajes por modelo y tipo de token; preserva 100% restante aunque falte remainingAmount. Requiere cuenta Google y proyecto Code Assist. |
| Antigravity | JSON nativo de statusline | Porcentajes y reinicios por bucket. Instala un observador sólo si la barra no está personalizada; no consume inferencia. Abrir `/usage` refresca el dato. No asume que un bucket sea un modelo exacto. |
| OpenCode Go | GET `/zen/go/v1/usage` | Lee ventanas de cinco horas, semana y mes con la autenticación Go de OpenCode. No aplica ese saldo a proveedores externos. Sin conexión Go informa el acceso faltante. |
| Claude Desktop y proveedores externos de OpenCode | Sin adaptador de cuota validado | Estado desconocido. No se les atribuye el saldo de otra CLI ni se inventan porcentajes o reinicios. |

Fuentes de los protocolos: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code statusline](https://code.claude.com/docs/en/statusline). La cobertura depende de la versión y autenticación de cada CLI; estos datos no prueban que un modelo concreto esté habilitado por la suscripción.

## Interpretación

- `available`: las ventanas aplicables, completas y vigentes permiten uso.
- `low`: alguna ventana está baja; se conserva el estado nativo o se usa un umbral de 10 % restante.
- `exhausted`: una restricción aplicable indica agotamiento.
- `cooldown`: hay una espera temporal informada por la CLI.
- `unknown`: no hay lectura suficiente, venció, el alcance es incierto o no se puede determinar la cuenta que se usará.

Se consideran todas las ventanas aplicables. Una cuota semanal agotada no queda oculta por una ventana corta disponible. Una lectura parcial conserva las restricciones anteriores con su vencimiento original. La hora de reinicio nunca confirma por sí sola la recuperación: hace falta una lectura nueva. El saldo observado no reserva capacidad ni permite calcular cuánto durará una tarea.

Los perfiles se identifican mediante una huella estable de CLI, ejecutable y rutas de configuración. Las cuentas verificadas comparten sus pools entre agentes; cuatro agentes no equivalen a cuatro saldos. Perfiles con distintas cuentas o con identidad todavía desconocida producen incertidumbre al planificar. No se guardan tokens, correos, IDs de cuenta en claro ni transcripciones para medir cuotas.

## Flujo del líder

1. Consultar `memory_usage_status` y `memory_team_catalog` al proponer un equipo. No hacer polling con el modelo.
2. Explicar mezcla de modelos, cuotas conocidas, datos desconocidos y puntos de control del trabajo. La persona decide qué equipo autoriza.
3. `memory_team_prepare` incorpora la observación en la propuesta. `memory_team_launch` vuelve a comprobar la disponibilidad antes de crear y lanzar cada miembro. Agotamiento o cooldown conocidos bloquean el lanzamiento; unknown y low requieren planificar con incertidumbre.
4. Si la cuota cambia después de crear un worktree, el Hub conserva el worktree y los recibos, pausa el plan y evita lanzar ese agente. No repite automáticamente efectos pendientes.
5. Los cambios relevantes generan avisos informativos para los líderes activos del canal o equipo. Se leen con `memory_chat_inbox` o `memory_usage_status`; no llevan `memory_chat_ack`. No autorizan cambiar cuenta, modelo, gasto o comprar capacidad.

La consulta de estado no fuerza refrescos de proveedores. Los recolectores tienen un plazo absoluto, exclusión por perfil y backoff; los agentes comparten esas lecturas. Un cambio de cuenta invalida la asociación anterior. Restaurar un backup conserva evidencia histórica, pero exige nuevas asociaciones y lecturas antes de usar las cuotas.

## Claude Code y configuración existente

El daemon consulta el perfil predeterminado de Claude Code, Codex, Kiro, Gemini y OpenCode Go aun sin agentes registrados ni equipos lanzados. Las consultas comparten una exclusión por perfil y un intervalo mínimo de dos minutos; fallos aplican backoff. Claude recibe sólo solicitudes de control `initialize` y `get_usage(skip_behaviors: true)`, con hooks y MCP deshabilitados, sin prompt ni persistencia de sesión. `skip_behaviors` impide el recorrido de transcripciones. La interfaz muestra las ventanas específicas sin inventar su correspondencia con IDs de modelo.

El Hub provisiona su statusline sólo si el campo está libre o ya era gestionado por el Hub. Una statusline personalizada, incluida la de Orca, se conserva: la lectura nativa ya no depende de reemplazarla. La telemetría no crea sesiones de colaboración ni cambia busy/idle. Redibujar el mismo contenido no renueva el vencimiento de la cuota: se necesita nueva evidencia nativa.

Deshabilitar `usage_status` para un cliente detiene su colección y avisos, y evita que las herramientas de equipo le revelen o apliquen cuotas. Los planes ya guardados muestran su cuota oculta mientras esté deshabilitado; el documento y digest originales se conservan. El chat puede seguir funcionando.

## Contrato y validación

`packages/shared/src/usage-quota.ts` define observaciones, ventanas, bindings, alcance de modelos y transiciones. `UsageQuotas` persiste el estado; el endpoint nativo autenticado `/api/memory/usage/native` valida CLI, agente, sesión, perfil y versión del binding. La ruta `/api/memory/usage/installed` autentica daemon, máquina, cliente y política de cuotas sin exigir una conversación. No existe una herramienta MCP para inventar observaciones. La transición y los avisos se guardan en la misma transacción antes de despertar al líder.

Las regresiones cubren ventanas simultáneas, frescura, cambios de cuenta, perfiles sin lectura, alcance de modelos, filtros correlacionados, backup, OFF, deduplicación de avisos, límites durante el lanzamiento, statusline, cancelación y propiedad de leases. Los fixtures validan contratos sin consumir inferencia. Las CLI sin fuente comprobada siguen explícitamente desconocidas.

La consulta experimental de Claude se verificó con CLI 2.1.308 y el contrato publicado en [SDK 0.3.301](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.301/sdk.d.ts). Una incompatibilidad no habilita scraping de terminales ni consultas con inferencia.

Las consultas HTTP usan destinos fijos y rechazan redirecciones. Las credenciales permanecen dentro del colector, no se envían al Hub ni al modelo. Gemini refresca OAuth en memoria con los metadatos públicos de su CLI instalada, sin ejecutar su flujo de login ni sobrescribir sus credenciales. Si esos metadatos no están disponibles, sólo usa un token vigente; si venció, informa cuota desconocida hasta que la CLI lo renueve. Las pruebas sin cuenta validan el contrato; no equivalen a una lectura real del proveedor. Claude Desktop sigue requiriendo una conexión de cuenta propia: no se atribuye automáticamente la de Claude Code.
