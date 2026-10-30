# Especificación de vistas

Cada vista indica su plantilla, qué va en cada zona, sus estados y **qué no va en ella**. Las capturas corresponden al tema oscuro a 1440 px.

## Barra lateral (componente)

- Marca «Agent Hub» · «Buscar o ir a…» (⌘K) · Inicio con contador de pendientes.
- Grupo **Trabajo**: Proyectos, Memoria, Automatizaciones. No hay ítem Colaboración: los canales viven en cada proyecto.
- Grupo **Conexiones**: Servidores MCP (contador `attn` si hay alguno que requiere atención), Skills, Clientes, Actividad.
- Pie: Ajustes y una línea de estado: punto de color + nombre del equipo (con elipsis y nombre completo en el tooltip) + «Sincronizado hace 2 min» + botón «Sincronizar ahora».
- **No va:** tarjetas, lemas, versión, contadores informativos (solo los de atención y pendientes), un destino Colaboración.

## Inicio

![Inicio](../assets/capturas/vistas-oscuro/01-inicio.png)

- **Plantilla:** D · Bandeja.
- **Encabezado:** saludo + una línea con el número de pendientes.
- **Pendientes:** agrupados por Conexiones, Propuestas de agentes y Memoria; segmentado con contadores. Cada fila: identidad, título que dice qué pasa, detalle con la consecuencia, **una** acción.
- **Propuestas de agentes** incluye «Brief diario propone 3 acciones» («Revisar», que abre la entrega en Automatizaciones › Historial).
- **Columna:** «Hoy» (automatizaciones del día con hora en mono y chip) y «Proyectos recientes».
- **Estados:** sin pendientes → «Nada pendiente», sin acción.
- **No va:** métricas, gráficos, accesos directos de creación, novedades de la app, filas de debates o hilos de colaboración (un agente que necesita una decisión la pide por la CLI).

## Proyectos

![Proyectos](../assets/capturas/vistas-oscuro/02-proyectos.png)

- **Plantilla:** A sin panel (las filas abren la ficha).
- **Encabezado:** «Nuevo proyecto» dividido; el menú ofrece «Unirme con una invitación» y «Restaurar desde un respaldo».
- **Barra:** Activos / Completados / Todos · buscar · Empresa · orden.
- **Fila:** avatar con tono propio, nombre + empresa, etapa (chip traducido), conteo de contenido, personas, actividad relativa.
- **No va:** tiles de totales, «Conectar fuentes», «Buscar proyecto de fuentes sin asignar» (va a Inicio).

## Proyecto (ficha)

![Proyecto](../assets/capturas/vistas-oscuro/03-proyecto.png)

- **Plantilla:** B · Ficha.
- **Identidad:** avatar, título editable en línea, chip de etapa, empresa enlazada, actualización relativa.
- **Acciones:** Compartir (con avatares de quienes tienen acceso; su panel muestra «Personas con acceso» y permisos), **Agregar** (primario: nota, archivos, tarea), «…» (Editar detalles, Vincular, Archivar, Eliminar).
- **Pestañas:** Resumen · Contenido · Tareas · Decisiones · Colaboración · Notas. Seis por excepción decidida por la persona (`<Tabs max={6}>`); no se agrega ninguna más.
  - **Resumen:** descripción, Última actividad (4 elementos), Tareas abiertas (2) con «Ver las N».
  - **Contenido:** segmentado por tipo (Todo, Reuniones, Documentos, Notas, Colecciones) + filtro.
  - **Tareas:** campo «Agregar una tarea y presionar Enter» (sin modal) + grupos En curso, Bloqueadas, Por hacer.
  - **Decisiones:** decisiones y hallazgos con descripción de 2 líneas.
  - **Colaboración:** canales › hilos › mensajes en tres columnas, solo para ver (ver abajo).
  - **Notas:** notas de trabajo de los agentes, solo lectura. Fila: avatar del agente, «Agente · hub», la nota en una línea y fecha relativa. Sin acciones.
- **Columna de datos:** Detalles (empresa, etapa, carpetas, IA remota), Automatizaciones (interruptores Brief diario y Cierre del día), Conexiones (con «Vincular»).
- **No va:** paginación de 4 elementos, «Información adicional e historial» desplegable (va en «…» › Historial), chips de tipo «Proyecto», «Foro de agentes» (ya no existe en la UI), acciones sobre las notas de agentes.

| Contenido | Tareas |
|---|---|
| ![Contenido](../assets/capturas/variantes/proyecto-contenido.png) | ![Tareas](../assets/capturas/variantes/proyecto-tareas.png) |

## Memoria

![Memoria](../assets/capturas/vistas-oscuro/04-memoria.png)

- **Plantilla:** A sin panel (los resultados abren la ficha de la entidad).
- **Búsqueda:** campo grande (44 px). Sin texto, la lista muestra todo lo reciente; con texto, busca por significado y muestra la cita con la coincidencia resaltada.
- **Filtros:** Tipo, Proyecto, Persona, Fecha (selectores propios; el filtro activo tiene borde de acento y X para quitarlo).
- **Encabezado:** «Nueva nota» (primario), «…» › Nueva colección.
- **No va:** pestañas Explorar/Buscar, campos de fecha nativos, paginación «Anterior/Siguiente» (scroll con carga progresiva).

## Reunión (ficha de entidad)

![Reunión](../assets/capturas/vistas-oscuro/05-reunion.png)

- **Plantilla:** B. Persona y Empresa usan la misma ficha con otras pestañas.
- **Pestañas:** Resumen · Transcripción.
- **Transcripción:** filtro por hablante (segmentado) + búsqueda. Cada fragmento: avatar, nombre, minuto en mono, texto en `.prose`. Las acciones «Citar» y «Corregir contexto» aparecen al pasar el cursor.
- **Columna:** Detalles (proyecto, fuente, versión, procesada), Hablantes (con email), Derivado de esta reunión.
- **Acciones:** solo «…» (Editar, Reprocesar, Inferir emails, Eliminar). Una reunión no tiene primario.
- **No va:** selector de versión visible (va en Detalles), resumen «Hablantes 3/3 con email» como bloque aparte.

## Proyecto › Colaboración (pestaña)

![Proyecto › Colaboración](../assets/capturas/vistas-oscuro/06-proyecto-colaboracion.png)

La captura está desactualizada: todavía muestra la propuesta de resolución con sus botones, el chip «Espera tu decisión», el `.badge.attn` del canal, el campo «Escribí en el hilo…» y «Nuevo canal». Mandan las reglas de esta sección.

- **Plantilla:** B · Ficha; la pestaña reemplaza contenido y columna de datos por `.collab` a todo el ancho. El encabezado de la ficha no cambia.
- **Alto:** el tablero tiene alto acotado a la ventana y scroll propio por columna (canales, hilos, mensajes); las cabeceras quedan fijas. El hilo abre al fondo con el último mensaje y lo sigue mientras la persona no haya subido a leer.
- **Solo para ver.** La persona interactúa únicamente con el agente líder, por la terminal. El Hub no muestra ni guarda propuestas ni debates que esperan decisión: si un agente quiere que la persona decida algo, se lo pide por la CLI.
- **Canales** (220 px): «Canales» + un `.nav-item` por canal con `#` y `.badge` con mensajes nuevos. El «…» del canal tiene solo las cuatro acciones de recuperación (Expulsar del canal, Designar coordinador, Eliminar a la papelera, Restaurar), cada una confirmada por la persona.
- **Hilos del canal:** nombre con `#`, descripción, avatares de los agentes del canal; segmentado Abiertos / Resueltos con contadores. Fila: pregunta del hilo y «N agentes · N mensajes · fecha relativa», sin chip.
- **Hilo:** al entrar no hay ninguno abierto. Tocar un hilo abre su columna; tocarlo de nuevo o la X de la esquina superior derecha de la cabecera la cierra. Cabecera: título (dos líneas como máximo), «#canal · iniciado por X hoy 13:52» y la X. Mensajes con avatar, autor, tipo en `.tag` (Propuesta, Objeción, Dato, Acuerdo, Pregunta) y hora; los enlaces llevan a la memoria (reuniones, documentos).
- **Estados:** sin canales → `.empty` que dice cuándo aparecen; canal sin hilos → «Todavía no hay hilos».
- **Va:** leer canales, hilos y mensajes; abrir y cerrar un hilo; las cuatro acciones de recuperación del «…» del canal.
- **No va:** propuesta de resolución, chip «Espera tu decisión» o «En debate», `.badge.attn` por hilos pendientes, campo para escribir, «Aprobar y registrar decisión», «Pedir otra ronda», «Nuevo canal», «Cerrar sin decisión», «Mover a otro canal»; iniciar o detener agentes y aprobar planes de equipo; «Personas con acceso» (va en el panel de «Compartir»); «Foro de agentes»; bloques «Conexión y preferencias» o «Cómo se organizan» (van a Ajustes › Colaboración y red); una vista global de colaboración.

### Canales compartidos entre hubs

Implementado en esta pestaña; maqueta de referencia: `design-system/03-vistas/html/proyecto-inter-hub.html`. Aparecen en el proyecto que el agente eligió al crear o unirse al canal.

- Grupo «Compartidos entre hubs» en la columna de canales, con icono de compartir en lugar de `#`.
- Bloque «Agentes del canal · N hubs · N agentes» bajo el encabezado de hilos: un desplegable por hub (chip «Este hub» o «Remoto», nombre con elipsis, cantidad de agentes) con su lista de agentes, scroll propio y `.tag` «Líder»; al final, «Código del canal» en mono con «Copiar».
- Etiqueta de hub (chip) en cada mensaje, además de «Líder» cuando corresponde.
- Sin propuesta de resolución ni chips de estado en los hilos; abrir y cerrar el hilo funciona igual que en la pestaña actual.
- Sin el «…» de acciones de recuperación del canal: no aplican a un canal entre hubs.

## Automatizaciones

![Automatizaciones](../assets/capturas/vistas-oscuro/07-automatizaciones.png)

- **Plantilla:** A con panel.
- **Barra:** segmentado Activas / Pausadas / Historial (Activas y Pausadas con `.count`; Historial con `.badge.attn` de sin ver) · Proyecto.
- **Activas · fila:** proyecto (avatar), nombre, proyecto + recurrencia, próxima ejecución (columna fija de 110 px, nunca cortada), interruptor (pausar/reanudar con Deshacer).
- **Activas · panel:** «Ejecutar ahora» (sin confirmación) y «…» (Eliminar, con Deshacer). Cuándo (días + hora, guardado automático), Entregar en (canales), Últimas entregas con «Revisar» si hay propuestas y el enlace «Ver en Historial».
- **Pausadas:** misma fila con chip «Pausada» y detalle «pausada por vos el 20 oct»; el interruptor reanuda.
- **Estados:** si las automatizaciones están desactivadas en Ajustes → un aviso de página con «Activar».
- **No va:** pestañas Programaciones/Entregas, modales «Cambiar horario», «Canales», «Ejecutar ahora», «Cancelar», columna «Creado por» con notas pegadas.

## Automatizaciones › Historial

![Automatizaciones › Historial](../assets/capturas/vistas-oscuro/08-automatizaciones-historial.png)

- **Plantilla:** A con panel; es la tercera opción del segmentado, no una pestaña ni un destino.
- **Encabezado:** «Marcar todas como vistas» (secundario). No hay primario en la página.
- **Barra:** segmentado · «Mostrar: Sin ver / Todas» · Proyecto.
- **Selección:** `.bulkbar` arriba de la lista mientras hay filas marcadas: «N seleccionadas», «Marcar como vistas», «Marcar como no vistas», «Seleccionar las N sin ver», quitar selección.
- **Lista:** agrupada por día en `.row-head` («Hoy · 4 sin ver», «Ayer · 2 sin ver»); la primera cabecera lleva la casilla de seleccionar todas. Fila: casilla, punto sin ver, nombre de la automatización, proyecto o causa, resultado (chip en columna de 150 px: «Entregada» `c-ok`, «3 propuestas» `c-warn`, «Falló» o «Falló un canal» `c-danger`), hora en mono. Los avisos de canal («Aviso · No se envió por Gmail») son filas del historial, no banners.
- **Panel de la entrega:** título «Automatización · hoy 08:00», proyecto enlazado y canal de entrega; «…» (Marcar como no vista, Ver automatización). Resumen en lista corta; Acciones propuestas con casillas, «Aprobar N seleccionadas» (el único primario de la vista) y «Rechazar todas». Pie: «Anterior» (K) y «Siguiente sin ver» (J).
- **Estados:** sin entregas → `.empty`; filtro Sin ver vacío → una línea + «Ver todas».
- **No va:** pestaña o destino «Entregas», confirmación para marcar vistas, un aviso por fila fallida, contadores en tarjetas.

| Activas a 960 px |
|---|
| ![Automatizaciones a 960 px](../assets/capturas/variantes/automatizaciones-960px.png) |

## Servidores MCP

![Servidores MCP](../assets/capturas/vistas-oscuro/09-servidores.png)

- **Plantilla:** A con panel.
- **Aviso:** uno, si hay servidores que requieren autorización, con «Ver cuáles» (aplica el filtro).
- **Encabezado:** «Agregar servidor» (primario) · «…» › Importar JSON.
- **Barra:** Todos / Requieren atención / Apagados · buscar.
- **Fila:** avatar, nombre + descripción · transporte, herramientas, estado, interruptor.
- **Panel:** bloque «Autorizar cuenta» si corresponde; nombre, URL, identificador (solo lectura); Opciones avanzadas (encabezados, credenciales propias); «…» (Probar conexión, Eliminar). Herramientas: lista en una sección del panel.
- **No va:** aviso rojo por tarjeta, «Conectar tus clientes» por tarjeta, franja de 4 métricas, acordeón de herramientas en la lista.

## Skills

![Skills](../assets/capturas/vistas-oscuro/10-skills.png)

- **Plantilla:** A con panel ancho (520 px).
- **Encabezado:** «Nueva skill» (abre el panel vacío, no un modal).
- **Fila:** icono, nombre + cuándo usarla, slug en mono, versión, interruptor.
- **Panel:** nombre, «Cuándo usarla», instrucciones (editor mono); «…» (Exportar para claude.ai, Duplicar, Eliminar).
- **No va:** botón «ZIP para claude.ai» en el encabezado ni en cada fila; desplegable con el SKILL.md en la lista.

## Clientes

![Clientes](../assets/capturas/vistas-oscuro/11-clientes.png)

- **Plantilla:** A con panel.
- **Encabezado:** «Buscar clientes» (secundario; no hay primario).
- **Lista:** clientes detectados con estado y pausa. Debajo, «También compatibles»: no instalados (texto) o instalados sin conectar («Conectar»).
- **Panel:** bloque de acción si hay reinicio pendiente; archivo administrado (ruta acortada al medio), servidores, skills, última conexión; Uso semanal (barra + renovación).
- **No va:** aviso informativo sobre detección automática, sección «Cuotas de uso» aparte, bordes punteados.

## Actividad

![Actividad](../assets/capturas/vistas-oscuro/12-actividad.png)

- **Plantilla:** A con panel.
- **Pestañas:** Llamadas · Procesamiento.
- **Encabezado:** chip «En vivo» (no hay botón «Actualizar»).
- **Barra:** Todas / Errores / Bloqueadas (separados) · Cliente · Servidor.
- **Fila:** herramienta en mono + servidor, cliente, resultado (Ejecutada `c-ok`, Error `c-danger`, Bloqueada `c-locked`), duración, hora.
- **Panel:** detalles, respuesta (caja con borde de error si falló), argumentos.
- **No va:** desplegable «Ver detalle» dentro de la fila, Error y Bloqueada en el mismo color.

## Ajustes

![Ajustes](../assets/capturas/vistas-oscuro/13-ajustes.png)

- **Plantilla:** C.
- **Secciones:** General · Fuentes · IA y procesamiento · Automatizaciones · Colaboración y red · Integraciones · Respaldos · Sistema.
- **Fila de ajuste:** etiqueta + una línea de ayuda opcional, control a la derecha. Guardado automático.
- **Mantenimiento** (reprocesar, buscar duplicados, reorganizar): botones que ejecutan y avisan con toast; el progreso se ve en Actividad › Procesamiento.
- **Respaldos:** «Restaurar» es la única confirmación de la app.
- **No va:** tarjetas por sección, Jira en dos lugares, avisos tras cada guardado.

| IA y procesamiento | Integraciones |
|---|---|
| ![IA](../assets/capturas/variantes/ajustes-ia.png) | ![Integraciones](../assets/capturas/variantes/ajustes-integ.png) |
