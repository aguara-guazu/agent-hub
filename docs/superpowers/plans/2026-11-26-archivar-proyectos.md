# Archivar y reactivar proyectos en el Hub

Un equipo puede dejar de atender una cuenta mientras otro sigue trabajando con el cliente. Archivar retira el proyecto del seguimiento cotidiano de este Hub. Su ficha, su etapa comercial, sus permisos y sus fuentes se conservan. El proyecto vuelve a Activos mediante una acción explícita.

## Decisiones de producto

- El archivo pertenece al Hub que lo elige. Los agentes de ese Hub comparten la vista de su dueño. Otro Hub que participa en el mismo proyecto conserva su propia elección.
- Activos y Archivados describen el seguimiento. La etapa comercial, incluida Completada, sigue disponible como filtro independiente. Una renovación, un mensaje o una sincronización pueden sumar información al proyecto archivado. Solo **Desarchivar** reanuda el seguimiento.
- Al volver a Activos se evalúa la situación actual. Por ejemplo, un bloqueo que sigue abierto puede generar un aviso. Los recordatorios vencidos durante el archivo y las menciones ya respondidas quedan en el historial.

## Pasos de implementación

1. **Guardar la elección en Proyectos y memoria.** En `packages/memory/src/projects`, agregar el estado local por ID de proyecto con fecha de archivo y última reactivación. Incluirlo en la migración SQLite y en el respaldo local. Una operación del dueño archiva o reactiva de forma idempotente y comprueba la revisión para resolver cambios concurrentes. Los proyectos sin marca previa quedan activos por defecto. La migración respeta un archivo previo de un proyecto independiente. El código de fusión ya marca el proyecto de origen con `merged_into`. Ese origen sigue remitiendo al destino y queda fuera de la lista de proyectos reactivables.
2. **Dar acceso desde Proyectos.** En `frontend/src/modules/memory/projects/ProjectsPage.tsx` y `project/ProjectPage.tsx`, ofrecer **Archivar proyecto** en la fila y en la ficha. Agregar la vista **Archivados**, con búsqueda, acceso a la ficha, alta de contenido y **Desarchivar**. La vista inicial, los selectores y los contadores habituales consultan los activos. Actualizar las consultas al guardar para que el cambio se vea de inmediato.
3. **Aplicar el alcance en las lecturas del MCP.** Extender `memory_list_entities` con `project_state` para proyectos. El valor predeterminado es `active`. Con `kind="project", project_state="archived"` el agente puede buscar archivados y abrir el resultado en ese alcance explícito. Aplicar la misma regla a contexto por carpeta, sugerencias, búsqueda textual y semántica, memoria relacionada y listados compartidos. Una lectura ordinaria, incluso con un ID guardado, respeta la vista activa. Filtrar antes de paginar o contar. Una fuente vinculada a dos proyectos sigue visible por el activo, con sus fragmentos y referencias correspondientes.
4. **Sacar el proyecto de la atención automática.** Usar el mismo criterio en `assistants`, `schedules` y en quienes construyen el brief y el cierre. Cubrir la bandeja, el chat general, los recordatorios por proyecto, la agenda, las tareas, los avisos ya en cola y las microtareas de seguimiento. Comprobar el estado al preparar y antes de entregar un aviso. Si ya se preparó un brief de varios proyectos, recalcular sus secciones vigentes para que los demás lo reciban. Conservar programación y preferencias para la reactivación.
5. **Mantener abierta la entrada de información.** Las conexiones, la asignación de fuentes por sus vínculos existentes, las escrituras dirigidas y las publicaciones recibidas de otros Hubs siguen usando el mismo ID. Probar que una reunión sincronizada, una nota manual y una actualización remota llegan durante el archivo y que figuran al consultar el historial.

## Prueba de aceptación

- [x] En dos Hubs con un proyecto compartido, archivar en A. B sigue viéndolo en Activos y agrega una actualización. A la recibe, la muestra en Archivados y omite el proyecto en sus avisos.
- [x] Preparar un brief y un recordatorio antes de archivar. Entregarlos después. El brief incluye al otro proyecto activo y el recordatorio personal independiente se entrega. El recordatorio del archivado queda omitido.
- [x] Consultar por nombre, carpeta, ID y texto exclusivo desde el MCP. La búsqueda ordinaria omite el proyecto. La búsqueda explícita de archivados permite recuperar su historial. Un documento compartido con un proyecto activo conserva la parte visible desde ese proyecto.
- [x] Reiniciar el core headless, recibir actividad nueva y desarchivar. Se conserva el mismo proyecto con su historial y configuración. El próximo ciclo informa solo lo que todavía requiere atención. Repetir la operación y verificar que no duplique avisos.
- [x] Ejecutar `npm run test:module -- <id>` para `memory`, `assistants`, `schedules`, `mcp`, `connections` y `sharing`. Verificar encendido, apagado y reactivación con una operación independiente disponible. Cubrir el filtro de la interfaz y la entrada MCP real en sus suites.
