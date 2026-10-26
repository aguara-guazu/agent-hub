# Prueba de despertar sin hooks en Claude Desktop Code

El 26 de octubre de 2026 se probó si una tarea en segundo plano podía recibir un
evento externo y reactivar una conversación que ya había terminado su turno.
La prueba usó Claude Desktop 3.6556.2, su modo Code y una suscripción existente.
No incorpora un transporte nuevo a Agent Hub.

## Procedimiento y resultado

Se creó un espacio temporal con `disableAllHooks: true` en
`.claude/settings.local.json`. Los hooks globales no se modificaron. Se abrió
una conversación nueva para que tomara esa configuración.

1. Se pidió ejecutar una tarea Bash en segundo plano que esperara 45 segundos e
   imprimiera un marcador. El agente debía terminar su turno con `WAITING`.
2. Se observó el turno finalizado y la tarea todavía activa. Al terminar la tarea,
   Code retomó la conversación y respondió con el marcador sin otro prompt humano.
3. Se repitió con un helper Python que escuchaba una sola conexión en un socket
   Unix dentro del espacio temporal, con timeout de 120 segundos. El helper
   aceptaba un JSON acotado a 4096 bytes, guardaba un recibo, imprimía el evento y
   terminaba. No consultaba el Hub ni ejecutaba comandos recibidos.
4. Después de observar el segundo `WAITING` y el turno finalizado, el evaluador
   generó un identificador aleatorio nuevo y lo envió al socket. Code retomó la
   conversación y devolvió exactamente ese identificador sin otro prompt.
5. Se comprobó que el helper había terminado y el socket se había eliminado.

En el caso externo, el helper recibió el evento aproximadamente un milisegundo
después del envío. La respuesta final se observó unos 28 segundos después; esa
medición de UI no es una garantía de latencia del transporte. El agente informó
haber recibido `task-notification` y leído una vez el resultado de la tarea.

## Alcance y límites

La evidencia observada muestra que **Code puede reanudar el agente al completar
una tarea en segundo plano**, incluso si esa tarea estaba esperando un evento
externo. El agente no tuvo que hacer polling ni usar otro agente para escuchar.
El helper sí permaneció activo hasta recibir el evento o vencer su timeout.

Una prueba anterior en Cowork terminó con el reporte de que su herramienta Bash
rechazaba `run_in_background`. Ese resultado no demuestra que todas las versiones
o mecanismos de Cowork carezcan de una alternativa equivalente.

El primer intento de Code con hooks habilitados no produjo una respuesta; una
sesión nueva con hooks deshabilitados sí respondió. No se aisló la causa exacta,
por lo que no se atribuye el problema a un hook específico.

No se verificaron reconexión, reinicio de Desktop, suspensión del sistema,
entrega durable, múltiples eventos, autenticación del listener ni otras CLI.
Tampoco se implementó todavía la asociación de eventos con canales del Hub.
Para un transporte de producto faltan esos controles y pruebas: el helper
descartable sólo demuestra la viabilidad del mecanismo de despertar.
