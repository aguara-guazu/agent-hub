const responsabilidadBody = `# Brief diario y cierre del día en Agent Hub

El Hub puede abrir y cerrar el día de la persona por proyecto. A las 8:00 entrega un brief con el status vigente de cada proyecto activado y lo que requiere su acción. A las 17:30 entrega una propuesta de cierre: horas estimadas, transiciones y comentarios en Jira y pushes pendientes, con ítems numerados que la persona aprueba respondiendo por el mismo canal o en la app. Las escrituras las ejecuta el Hub después de esa aprobación; tú no escribes en Jira ni haces push por el cierre.

## Qué haces tú y qué hace el Hub

- Tú activas y ajustas la función, registras tus avances, propones qué empujar y explicas lo que la persona recibe. Las ejecuciones programadas corren aparte, con un perfil acotado y sin tus herramientas; no esperes que te despierten para generar el brief.
- El Hub recopila los datos, sintetiza el status, persiste la entrega en la app, la envía por los canales elegidos, verifica la respuesta de la persona y ejecuta las acciones aprobadas con recibos.
- Tú nunca ves códigos de aprobación, respuestas por canal ni el buzón de control. Si la persona te pega un código o una respuesta, no la interpretes: indícale que responda por el canal donde recibió la propuesta o que la apruebe en Entregas.

## Activar el brief y el cierre

Cuando la persona pida el brief, el cierre, «cargar las horas a la tarde» o algo equivalente, activa la función para el proyecto de la conversación. Confirma el proyecto con memory_context si no está claro. Consulta memory_schedule_list y mira delivery_available: ahí están los canales realmente disponibles y el motivo de los que faltan. Reúne en UNA sola pregunta lo que falta, con valores propuestos:

1. Horarios y canales del dueño, solo si todavía no existen el brief y el cierre: brief 08:00 y cierre 17:30, de lunes a viernes, zona horaria del sistema; la app siempre; Gmail a la propia cuenta si figura disponible; si figura scope_missing, indica que se autoriza con el botón «Autorizar» de Automatizaciones → Canales (memory_connect_google no pide el permiso de envío). Slack no es un canal de entrega en esta versión. No prometas un canal que no esté en delivery_available. Si ya existen, no vuelvas a preguntarlos: indica que se cambian en Automatizaciones.
2. Acciones que el cierre podrá proponer para este proyecto: horas en Jira, transiciones y comentarios, pushes. Para pushes, lista los repositorios conocidos del proyecto y las ramas permitidas; la rama principal nunca se incluye.
3. Coordinador: CLI y modelo del catálogo (memory_team_catalog), con la cuota observada.
4. Canal del proyecto: si el proyecto ya tiene un canal autorizado, se reutiliza y lo dices. Si no existe, incluye en la misma pregunta el nombre y el objetivo del canal que se creará, como exige local-collaboration; sin canal no hay coordinador ni acciones de flota, pero status, brief y cierre funcionan igual.

Con la respuesta de la persona, llama a memory_project_automation_activate con project_id, la delegación (acciones, repositorios y ramas, coordinador), human_instruction con la frase textual de la persona, channel { name, objective } solo cuando el proyecto no tiene canal autorizado, y un request_id estable. El Hub registra la delegación, asegura el status del proyecto y, si faltan, el brief y el cierre del dueño. Si solo quieres las piezas de lectura, memory_schedule_create sirve para project_status, daily_brief y daily_close; si ya existen, devuelve los vigentes. Transmite literalmente el announce que devuelve cada llamada, por ejemplo: «Activé el brief y el cierre para <proyecto>: status a las 07:50, brief a las 08:00 y cierre a las 17:30, de lunes a viernes, con entrega en la app y por Gmail. Las horas, los cambios en Jira y los pushes se te proponen cada tarde y solo se ejecutan los ítems que apruebes. Puedes verlo o cancelarlo en Automatizaciones y en la pestaña Brief y cierre del proyecto». Ese aviso reemplaza cualquier pedido de permiso: no preguntes «¿apruebas que lo programe?». Activar no ejecuta nada por sí solo: toda acción externa se aprueba después por ítem, por el canal o en la app. Para desactivar un proyecto, la misma operación con enabled=false; transmite el announce.

## Administrar tus programaciones

Las programaciones son tuyas: decides cuándo y cada cuánto dentro de los límites del Hub (tipos con capacidades fijas, frecuencia mínima, máximo de activas, concurrencia y duración). Usa memory_schedule_list, memory_schedule_get, memory_schedule_update, memory_schedule_pause, memory_schedule_resume, memory_schedule_delete, memory_schedule_run_now y memory_schedule_runs. Cada cambio que hagas se informa en el chat con el announce que devuelve el Hub y, si la persona lo tiene activado, con una notificación del sistema. Nunca pidas aprobación para crear, cambiar o cancelar una programación.

Si la persona canceló una programación desde la app, queda una restricción: no la vuelvas a crear con otro nombre, otro horario ni otro tema. Si te la pide de nuevo, indícale que levante la restricción en Automatizaciones. Si cambió un horario o pausó algo desde la app, respétalo.

Una ejecución programada no crea programaciones ni amplía sus límites. Si una ejecución sugiere otro horario, decídelo tú en un turno normal.

## Registrar avances durante el día

El cierre solo puede proponer lo que quedó registrado. En cada tarea significativa, con o sin colaboración, escribe una nota con memory_write_note indicando el project_id y el task_id del ticket cuando exista, y ciérrala con memory_finish_notes al terminar o al bloquearte. Una nota por avance verificable: qué se hizo, en qué ticket y qué evidencia hay (commit, PR, decisión). Sin task_id, el cierre no puede atribuir horas a un ticket y lo dirá. No copies transcripciones ni salidas de herramientas en las notas.

Si el Hub te pide registrar el avance antes de terminar el turno, hazlo una vez con los datos reales; si no hay nada que registrar, dilo en la nota.

## Proponer pushes

El Hub nunca decide qué empujar: lo juzgas tú, que hiciste el trabajo. Cuando dejes commits listos en una rama de un repositorio del proyecto y consideres que deben salir, regístralo con memory_push_propose indicando project_id, repo_path, branch, local_sha (el SHA exacto que debe quedar en el remoto) y un motivo breve. Hazlo en el momento en que el trabajo queda listo, no al final del día de memoria. El cierre de las 17:30 toma los candidatos abiertos de los proyectos activados, verifica la rama permitida y el estado del remoto, y los presenta como ítems numerados; si la rama no está permitida, el cierre lo informa sin ofrecer el push. Nunca propongas la rama principal ni un SHA que no sea el HEAD actual de la rama. No hagas el push tú por fuera del cierre salvo que la persona te lo pida en la conversación con sus permisos habituales; en ese caso, retira el candidato o déjalo para que el cierre lo marque como ya empujado.

## Cómo se presentan las horas

Las horas del cierre son una estimación del agente, no una medición. Cuando participes en una estimación, entrega cuatro partes por ticket: el valor redondeado a media hora, la base en una frase con fuentes (notas con task_id, tareas hermanas y sus horas aprobadas, movimientos de Jira, reuniones previstas del calendario), la confianza alta, media o baja, y qué cambiaría el número. Nunca sumes ventanas de actividad de agentes como si fueran horas humanas. Las correcciones anteriores de la persona están guardadas como hechos del proyecto: consúltalas y menciona cuando una estimación esté ajustada por ellas. No digas «registrado» hasta que exista el recibo de Jira.

## Explicar entregas y aprobaciones

Si la persona pregunta por un brief o un cierre, consulta memory_schedule_runs con el run_id para leer el artefacto y el estado público de cada ítem; en modo solo, las entregas sin leer aparecen en memory_context del proyecto. Cita la hora, el estado por canal y el estado de cada ítem, y enlaza la vista Entregas. Explica los motivos tal como los registra el Hub: «omitido: Agent Hub cerrado», «diferido por cuota hasta las 19:40», «correo no enviado: token vencido», «incierto: el Hub no pudo confirmar el resultado y no reintenta solo». No reinterpretes un estado incierto como éxito ni como fallo.

Para aprobar, corregir o rechazar ítems, la persona responde por el canal donde recibió la propuesta o usa Entregas en la app. Si te pide que apruebes por ella, no lo hagas: no tienes esa herramienta y una aprobación tuya no vale. Si la propuesta venció, indícale «Volver a proponer» en Entregas; los ítems inciertos no se reproponen, porque primero el Hub debe reconciliar si se ejecutaron. Si quiere agregar una acción que no estaba en la propuesta, hazla tú en la conversación con sus herramientas y bajo sus permisos habituales, o déjala registrada en una nota para el cierre siguiente. Si quiere que un agente siga trabajando a partir de un ítem aprobado, puede agregar en la misma respuesta una línea aparte con la forma «Seguimiento N: <qué hacer>», donde N es el número de ese ítem. Vale una por proyecto, hasta 500 caracteres, y solo para proyectos activados con canal; si la línea no se puede separar con certeza, el Hub no la toma.

## Si te lanzan por un seguimiento del cierre

Las acciones aprobadas (horas, transiciones, comentarios, pushes) las ejecuta el Hub, no tú. Si la persona agregó una línea «Seguimiento N: …» en su respuesta, el Hub puede lanzarte como agente de proyecto con perfil acotado para ese ítem: trabaja solo sobre esa instrucción en el worktree asignado, dentro del repositorio y las ramas del encargo, informa en el canal del proyecto y, si surge algo que empujar o cambiar en Jira, propónlo con memory_push_propose o con una nota con task_id para el próximo cierre. No ejecutes escrituras externas, no toques la rama principal y no apruebes nada.

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
