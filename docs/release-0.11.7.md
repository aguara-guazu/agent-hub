# Agent Hub 0.11.7 — Automatizaciones, brief diario y cierre

Los agentes pueden programar su propio trabajo recurrente. El Hub agrega un
programador de tareas, un brief diario y un cierre de jornada por proyecto, y
la ejecución de acciones aprobadas por la persona. También retoma
automáticamente a los equipos que se quedaron sin cuota a mitad de una tarea.

## Programaciones creadas por los agentes

- Las herramientas `memory_schedule_*` permiten a un agente crear, listar,
  pausar, reanudar, ejecutar ahora y eliminar sus programaciones. La persona las
  ve y puede cancelarlas desde Automatizaciones; no se le piden aprobaciones
  para programarlas, solo se le avisa.
- Cada ejecución guarda sus fases (recolección, síntesis, persistencia y
  entrega), sus entregas y su resultado. Las ejecuciones huérfanas se terminan
  y quedan en un historial que los agentes pueden consultar.
- Los horarios usan la zona horaria del sistema. Si la computadora estaba
  apagada, el brief corre al encender, salvo que la próxima ocurrencia esté
  cerca; el cierre se puede recuperar hasta las 22:00.
- Si la cuota del modelo está agotada, la ejecución espera a que se restablezca.
  Un interruptor general en Ajustes apaga todas las automatizaciones.
- Cuando la persona fija la recurrencia o la entrega de una programación, el
  agente ya no puede cambiar ese campo.

## Brief y cierre por proyecto

- La skill de fábrica `responsabilidad` y la herramienta
  `memory_project_automation_activate` activan, por proyecto, un status a las
  07:50, el brief a las 08:00 y el cierre a las 17:30, de lunes a viernes.
- El brief reúne en un resumen ejecutivo el status vigente de cada proyecto,
  lo que requiere atención, la agenda del día y lo que quedó pendiente del
  cierre anterior. Se entrega en la app y, si se configuró, por Gmail o Slack.
- El cierre propone, con numeración única, horas por ticket de Jira como
  estimación del agente (en pasos de media hora, con su base y supuestos),
  transiciones, comentarios y pushes. Nada se ejecuta sin aprobación.
- La persona aprueba respondiendo el correo o el mensaje de Slack con el código
  del cierre, o desde la app. Los ítems aprobados los ejecuta el Hub sin pasar
  por un modelo, con el efecto exacto que se mostró.
- Las escrituras en Jira van por el servidor elegido en Ajustes →
  Automatizaciones; si no se eligió ninguno, se usa la conexión «Atlassian Rovo»
  cuando está disponible. Con «Ninguno» no se escribe en Jira, ni siquiera lo que
  ya estaba aprobado. Solo se escriben tickets asignados a la cuenta del
  dueño, verificada en Jira antes de cada escritura, y un cierre repetido el
  mismo día no duplica horas.
- Los pushes solo van a ramas permitidas en la delegación del proyecto, nunca
  a la rama principal y nunca forzados. Se rechazan repositorios con
  configuración de Git que pueda desviar las credenciales.

## Reanudación tras agotar la cuota

Cuando la cuota de una CLI se agota, el líder y los miembros que fallaron
trabajando se reanudan solos al restablecerse, en la misma conversación y con
el mismo modelo, en las CLIs de la flota que permiten retomar una conversación.
Si el Hub se reinició, primero
confirma que el proceso anterior terminó. Si el líder está cerrado, los
miembros esperan y la persona recibe un aviso.

## App de escritorio

- Nueva sección Automatizaciones con programaciones, entregas y decisiones.
  Las aprobaciones sensibles muestran el efecto exacto antes de confirmar, y el
  reintento de una entrega incierta avisa que el mensaje puede llegar dos veces.
- Pestaña «Brief y cierre» en cada proyecto para activar la delegación, con
  confirmación del documento completo antes de guardar.
- Notificaciones del sistema para el brief y el cierre, que se pueden
  desactivar en Ajustes, y opción para mantener la computadora despierta
  mientras corre una programación.
- El permiso de envío por Gmail se pide en el mismo consentimiento de Google y
  solo se habilita si Google lo concede. Si la cuenta de Google ya está
  conectada, la acción «Canales» de cada automatización ofrece «Autorizar»; Slack
  requiere agregar su servidor MCP en el Catálogo.
- Al hacer clic en la notificación del brief o del cierre se abre su entrega.

## Otros cambios

- Al reiniciar el Hub, los miembros de la flota que quedaron sin proceso se
  reconocen como detenidos y se pueden volver a lanzar. Un miembro con un
  proceso todavía activo en su espacio de trabajo nunca se reemplaza.
- El instalador local de macOS abre la app correctamente aunque se ejecute
  desde una sesión de agente.
- Los miembros de Kiro se lanzan en la flota del Hub por ACP.
- Las sesiones de terminal inactivas vuelven a recibir los avisos del Hub.
- La detección de marcadores de Git rotos ya no depende del idioma de Git.

Los planes derivados que un coordinador lanzaría por proyecto quedan
desactivados en esta versión hasta que el Hub aplique perfiles de ejecución
por miembro. El brief todavía no informa agentes trabados: lo indica como
«Sin datos de: incidentes del supervisor» hasta que exista el supervisor que
los detecte.

Actualiza Agent Hub, sincroniza los clientes y vuelve a abrir las conexiones
MCP para cargar las herramientas y la skill nuevas. En macOS, si después de
actualizar la flota no arranca, revisa en Configuración del Sistema →
Privacidad y seguridad → Archivos y carpetas que Agent Hub conserve el acceso
a la carpeta Documentos.
