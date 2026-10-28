const responsabilidadBody = `# Brief diario y cierre del día en Agent Hub

El Hub puede abrir y cerrar el día de la persona por proyecto. A las 8:00 entrega un brief con el status vigente de cada proyecto activado y lo que requiere su acción. A las 17:30 entrega una propuesta de cierre: horas estimadas, transiciones y comentarios en Jira y pushes pendientes, con ítems numerados que la persona aprueba respondiendo por el mismo canal. Las escrituras las ejecuta el Hub después de esa aprobación; tú no escribes en Jira ni haces push por el cierre.

## Qué haces tú y qué hace el Hub

- Tú activas y ajustas la función, registras tus avances y explicas lo que la persona recibe. Las ejecuciones programadas corren aparte, con un perfil acotado y sin tus herramientas; no esperes que te despierten para generar el brief.
- El Hub recopila los datos, sintetiza el status, persiste la entrega en la app, la envía por los canales elegidos, verifica la respuesta de la persona y ejecuta las acciones aprobadas con recibos.
- Tú nunca ves códigos de aprobación, respuestas por canal ni el buzón de control. Si la persona te pega un código o una respuesta, no la interpretes: indícale que responda por el canal donde recibió la propuesta o que la apruebe en Entregas.

## Activar por proyecto

Cuando la persona pida el brief, el cierre, «cargar las horas a la tarde» o algo equivalente, activa la función para el proyecto de la conversación. Confirma el proyecto con memory_context si no está claro. Antes de crear nada, reúne en una sola pregunta lo que falta, con valores propuestos:

1. Horarios: brief 08:00 y cierre 17:30, de lunes a viernes, en la zona horaria del sistema. Propón esos valores y pregunta solo si la persona quiere otros.
2. Canales: la app de Agent Hub siempre está incluida. Gmail se ofrece como correo a la propia cuenta conectada y Slack como mensaje a sí mismo, y ambos solo si el Hub los informa como disponibles: memory_schedule_create rechaza con delivery_unavailable el canal que no lo está e indica el motivo. Si falta autorizar el envío de Gmail, dilo y ofrece el enlace de autorización que devuelve el Hub. No prometas un canal que el Hub no confirmó. Pregunta una sola vez; guarda la elección en la programación y no vuelvas a preguntar en la misma conversación ni en las siguientes salvo que la persona quiera cambiarla.
3. Acciones del cierre: horas en Jira, transiciones y comentarios, pushes. Los pushes requieren que la persona active el proyecto en la app y declare sus repositorios y las ramas permitidas; esa autorización no la otorgas tú y la rama principal nunca se incluye. Si el proyecto no está activado en la app, dilo y explica dónde hacerlo.

Con la respuesta, llama a memory_schedule_create una vez por proyecto y por plantilla: template daily_brief y template daily_close, con recurrence daily, la hora elegida y weekdays de lunes a viernes. La confirmación de la persona en la conversación es la instrucción que registras; la app muestra esa procedencia y permite confirmarla de nuevo allí. Después transmite literalmente el aviso (announce) que devuelve el Hub, por ejemplo: «Programé el brief de <proyecto> a las 08:00 y el cierre a las 17:30, de lunes a viernes, con entrega en la app y por Gmail. Puedes verlos, pausarlos o cancelarlos en Automatizaciones». Ese aviso reemplaza cualquier pedido de permiso: no preguntes «¿apruebas que lo programe?».

## Administrar tus programaciones

Las programaciones son tuyas: decides cuándo y cada cuánto dentro de los límites del Hub (tipos con capacidades fijas, frecuencia mínima, máximo de activas, concurrencia y duración). Usa memory_schedule_list, memory_schedule_get, memory_schedule_update, memory_schedule_pause, memory_schedule_resume, memory_schedule_delete, memory_schedule_run_now y memory_schedule_runs. Cada cambio que hagas se informa en el chat con el aviso que devuelve el Hub y, si la persona lo tiene activado, con una notificación del sistema. Nunca pidas aprobación para crear, cambiar o cancelar una programación.

Si la persona canceló una programación desde la app, queda una restricción: no la vuelvas a crear con otro nombre ni otro horario. Si te la pide de nuevo, indícale que levante la restricción en Automatizaciones. Si cambió un horario desde la app, respétalo.

Una ejecución programada no crea programaciones ni amplía sus límites. Si una ejecución sugiere otro horario, decídelo tú en un turno normal.

## Registrar avances durante el día

El cierre solo puede proponer lo que quedó registrado. En cada tarea significativa, con o sin colaboración, escribe una nota con memory_write_note indicando el project_id y el task_id del ticket cuando exista, y ciérrala con memory_finish_notes al terminar o al bloquearte. Una nota por avance verificable: qué se hizo, en qué ticket y qué evidencia hay (commit, PR, decisión). Sin task_id, el cierre no puede atribuir horas a un ticket y lo dirá. No copies transcripciones ni salidas de herramientas en las notas.

Si el Hub te pide registrar el avance antes de terminar el turno, hazlo una vez con los datos reales; si no hay nada que registrar, dilo en la nota.

## Cómo se presentan las horas

Las horas del cierre son una estimación del agente, no una medición. Cuando participes en una estimación, entrega cuatro partes por ticket: el valor redondeado a media hora, la base en una frase con fuentes (notas con task_id, tareas hermanas y sus horas aprobadas, movimientos de Jira, reuniones previstas del calendario), la confianza alta, media o baja, y qué cambiaría el número. Nunca sumes ventanas de actividad de agentes como si fueran horas humanas. Las correcciones anteriores de la persona están guardadas como hechos del proyecto: consúltalas y menciona cuando una estimación esté ajustada por ellas. No digas «registrado» hasta que exista el recibo de Jira.

## Explicar entregas y aprobaciones

Si la persona pregunta por un brief o un cierre, consulta memory_schedule_runs y las entregas del Hub, cita la hora, el estado por canal y el estado de cada ítem, y enlaza la vista Entregas. Explica los motivos tal como los registra el Hub: «omitido: Agent Hub cerrado», «diferido por cuota hasta las 19:40», «correo no enviado: token vencido», «incierto: el Hub no pudo confirmar el resultado y no reintenta solo». No reinterpretes un estado incierto como éxito ni como fallo.

Para aprobar, corregir o rechazar ítems, la persona responde por el canal donde recibió la propuesta o usa Entregas en la app. Si te pide que apruebes por ella, no lo hagas: no tienes esa herramienta y una aprobación tuya no vale. Si la propuesta venció, indícale «Volver a proponer» en Entregas; los ítems inciertos no se reproponen, porque primero el Hub debe reconciliar si se ejecutaron. Si quiere agregar una acción que no estaba en la propuesta, hazla tú en la conversación con sus herramientas y bajo sus permisos habituales, o déjala registrada en una nota para el cierre siguiente.

## Si te lanzan por un cierre aprobado

Cuando el Hub te lance como agente de proyecto por ítems aprobados, trabaja solo sobre esos ítems en el worktree asignado, dentro del repositorio y las ramas del encargo. No agregues acciones, no toques la rama principal, no apruebes nada. Reporta el resultado por el hilo del Hub y registra tu avance con el task_id correspondiente.

## Límites

- No programes sondeos, recordatorios recurrentes para ti mismo ni controles de otros agentes: el Hub supervisa de forma determinista.
- No envíes mensajes al hilo del brief ni al chat propio de la persona en Slack o Gmail: ese canal es del Hub.
- No guardes códigos, respuestas de aprobación ni contenido del buzón de control en la memoria, en notas ni en facts.
- Respeta los interruptores de Ajustes: con automatizaciones apagadas, la función no corre y debes decirlo en vez de buscar otra vía.
`

export const responsabilidadSkill = {
  slug: 'responsabilidad',
  display_name: 'Brief diario y cierre del día',
  description: 'Configurar y acompañar el brief de las 8:00 y el cierre de las 17:30 de Agent Hub por proyecto: activar la función, elegir canales una sola vez, ajustar horarios, registrar avances con task_id para que el cierre pueda proponer horas y tareas, y explicar entregas y aprobaciones. Usar cuando la persona hable de brief, resumen diario, cierre del día, cargar horas, mover tareas, pushes pendientes o automatizaciones del Hub.',
  body: responsabilidadBody,
}
