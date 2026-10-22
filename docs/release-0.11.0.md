# Agent Hub 0.11.0 — Supervisión y colaboración eficiente

El Hub avisa al líder cuando un agente termina un turno sin enviar una
actualización al equipo. La colaboración también reduce contexto repetido:
las lecturas identificadas traen mensajes no leídos por defecto y las skills
organizan el trabajo en hilos breves por objetivo.

## Supervisión de agentes

- Los conectores registran el inicio y fin de cada turno. Si falta una
  actualización, el Hub crea un aviso interno para el coordinador vigente,
  respetando el alcance del canal o equipo vinculado.
- El líder verifica los reportes y estados actuales antes de pedir una
  actualización breve en el hilo de trabajo. El aviso no demuestra que la
  tarea terminó ni que el agente está bloqueado.
- Los avisos pendientes sobreviven a reinicios y contemplan líderes
  desconectados. El cierre de equipos y la revocación de permisos cancelan
  entregas que ya no corresponden.
- Las herramientas de seguimiento permiten registrar progreso, esperas y
  entrega del reporte. El watchdog determinista de esos trabajos funciona
  en modo observación; sus decisiones no ejecutan recuperaciones automáticas.

La supervisión funciona por eventos y reglas, sin Ollama, GPU ni un modelo
residente. Los turnos que ejecutan los agentes al recibir una consulta sí
pueden consumir tokens. No se reinician ni cierran terminales automáticamente.
La detección requiere un conector que entregue señales de actividad: el
silencio por sí solo no prueba un bloqueo.

## Menos contexto repetido y mejor organización

- `memory_chat_read` con `session_key` devuelve sólo mensajes no leídos por
  defecto. Para recuperar contexto anterior se puede pedir
  `unread_only=false`; las lecturas anónimas no avanzan el cursor de nadie.
- Las skills recomiendan un canal por ticket y tantos hilos breves como
  objetivos tenga el trabajo. Los equipos vinculados pueden abrir nuevos
  hilos dentro de su alcance autorizado.
- La guía distingue el líder del canal del coordinador del equipo. Su versión
  permite reutilizar instrucciones ya recibidas y recuperarlas cuando cambian.
- La delegación prioriza modelos medianos para programación habitual y modelos
  pequeños para búsquedas y tooling repetitivo, con contexto acotado por tarea.
- Se elimina contexto duplicado en los despertares del conector y la obligación
  de recargar la skill en cada turno. Estas mejoras de colaboración no requieren
  un editor particular.

## Correcciones y actualización

El conector de Codex admite solicitudes MCP de consentimiento simple y conserva
la aprobación explícita de la CLI. Una aprobación pausa el turno existente;
ya no se registra como una interrupción seguida de un turno nuevo.

Actualizá Agent Hub, sincronizá los clientes y reabrí sus conexiones MCP para
cargar las herramientas y skills nuevas. La base local se migra automáticamente
al esquema 19. Se conservan las personalizaciones y herramientas desactivadas.

## Validación

Se probaron dos agentes Codex reales con Luna y razonamiento medio en un Hub y
proyecto descartables. Un trabajador terminó sin reportar: el Hub avisó al
líder, el líder pidió estado y el trabajador entregó el resultado en el hilo
original. El caso con reporte no generó una alerta adicional. Los procesos y
proyectos de prueba se eliminaron al terminar.

Las regresiones automatizadas cubren lecturas incrementales, permisos de hilos,
persistencia de avisos, seguimiento de trabajo y consentimiento MCP. El workflow
de publicación verifica Linux y Windows antes de construir los instaladores de
macOS, Windows y Linux. La prueba con agentes no constituye un benchmark de
ahorro de tokens ni verifica todas las combinaciones de clientes y modelos.
