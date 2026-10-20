# Cuotas de uso y planificación de equipos

Agent Hub conserva observaciones nativas de las cuotas de las CLI para que un líder pueda elegir un equipo y conservar su progreso antes de quedarse sin capacidad. `memory_usage_status` consulta el estado guardado, sus ventanas, origen, fecha de lectura y vencimiento; no inicia una conversación ni consume inferencia para medir. El panel **Clientes → Cuotas de uso** muestra la misma información.

## Cobertura inicial

| CLI | Fuente | Alcance y limitación |
| --- | --- | --- |
| Codex CLI | App-server: `account/read` y `account/rateLimits/read` | Ventanas nativas, duración y reinicio cuando existen. Identidad de cuenta verificada mediante routing ID opaco. El pool `codex` tiene alcance global; pools sin correspondencia documentada a modelos conservan alcance desconocido. |
| Claude Code | JSON de statusline: `rate_limits` | Ventanas de cinco horas, siete días y límite de gasto opcional. Los campos pueden faltar hasta una respuesta de API. Cuenta sin verificar: lectura limitada al perfil. |
| Kiro | Capacidades ACP y eventos nativos | Se detecta `_kiro/account/getUsage` sólo si la CLI lo anuncia. La versión comprobada 2.32.0 no lo anuncia y no hay un esquema estable validado: el saldo mensual permanece desconocido. Un evento de rate limit indica espera temporal, no agotamiento mensual. |
| Antigravity y otras CLI | Sin adaptador de cuota validado | Estado desconocido. No se extrae el saldo de texto de la TUI ni se inventan porcentajes o reinicios. |

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

El Hub provisiona su statusline sólo si el campo está libre o ya era gestionado por el Hub. Una statusline personalizada se conserva y se informa el conflicto; no se reemplaza silenciosamente. La telemetría usa la identidad existente de los hooks y no crea sesiones ni cambia busy/idle. Redibujar el mismo contenido no renueva el vencimiento de la cuota: se necesita nueva evidencia nativa.

Deshabilitar `usage_status` para un cliente detiene su colección y avisos, y evita que las herramientas de equipo le revelen o apliquen cuotas. Los planes ya guardados muestran su cuota oculta mientras esté deshabilitado; el documento y digest originales se conservan. El chat puede seguir funcionando.

## Contrato y validación

`packages/shared/src/usage-quota.ts` define observaciones, ventanas, bindings, alcance de modelos y transiciones. `UsageQuotas` persiste el estado; el endpoint nativo autenticado `/api/memory/usage/native` valida CLI, agente, sesión, perfil y versión del binding. No existe una herramienta MCP para inventar observaciones. La transición y los avisos se guardan en la misma transacción antes de despertar al líder.

Las regresiones cubren ventanas simultáneas, frescura, cambios de cuenta, perfiles sin lectura, alcance de modelos, filtros correlacionados, backup, OFF, deduplicación de avisos, límites durante el lanzamiento, statusline, cancelación y propiedad de leases. Los fixtures validan contratos sin consumir inferencia. Las CLI sin fuente comprobada siguen explícitamente desconocidas.
