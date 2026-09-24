# Agent Hub 0.4.0

## Cambios

- Procesamiento con OpenCode: errores de saturación reconocidos como transitorios, reintentos cancelables y recuperación por lote sin duplicar hechos.
- «Sincronizar ahora» consulta las fuentes activas, incluidas las transcripciones nuevas de Meet, e informa los errores.
- Las reuniones y documentos sin proyecto se comparan con los proyectos existentes. La asignación automática exige confianza alta y evidencia; los demás casos aparecen en Proyectos para asociar, crear o dejar sin proyecto. La revisión y la asignación se guardan en una sola transacción.
- Tablero de tareas por proyecto: espejo de Jira con su estado real, pendientes internos, filtros, historial, estadísticas y exportación HTML. Las claves de Jira se distinguen por sitio; una coincidencia ambigua no se asigna.
- El gateway refleja las llamadas de Jira que pasan por el hub. Las entregas pendientes sobreviven a reinicios y sólo reintentan lecturas de Jira y escrituras locales. Nunca se repite una mutación de Jira para reparar el espejo.
- Carpetas de proyecto y contexto de trabajo con tareas y notas de otros agentes. Búsqueda por proyecto y de material sin asignar.
- Notas cortas atribuidas a la sesión. Codex, Claude Code, Gemini CLI y OpenCode reciben hooks para cerrar las notas al finalizar el turno; un cierre atrasado no afecta al siguiente turno. Se conservan los hooks personales y se detectan modificaciones de los administrados por el hub.
- Exportación y descarga de respaldos por streaming para evitar cargar toda la memoria en RAM; verificado con un respaldo real de 1,6 GB. La UI muestra la versión del paquete.
- Correcciones de esquema MCP, herencia de proyectos, concurrencia, estadísticas y sincronización de tareas desde el conector Jira.

## Actualización

Instalar la nueva app y ejecutar «Sincronizar ahora» para actualizar las configuraciones administradas de los clientes. Reiniciar las sesiones que todavía usan el gateway anterior. Las migraciones de memoria se aplican al arrancar. Los trabajos que ya estaban fallidos se recuperan con «Reintentar» en Procesamiento.

Los hooks requieren un cliente que soporte esos eventos y los tenga habilitados. Kiro y Claude Desktop conservan el cierre explícito mediante `memory_finish_notes`, el cierre de sesión y el cierre por inactividad. Un MCP de Jira conectado directamente al cliente queda fuera del gateway: en ese caso la skill indica llamar `memory_sync_tasks` después de usarlo.

La cola respeta las herramientas habilitadas. Si la memoria o la lectura necesaria de Jira están apagadas, la entrega espera; si no existe el proyecto, se debe configurar su clave y sitio para que el espejo pueda asociarlo.

## Validación y publicación

La versión y las dependencias internas están alineadas en 0.4.0. CI verifica lint, tipos, pruebas unitarias, frontend, procesos completos y PostgreSQL/pgvector antes de construir una release; también valida la correspondencia del tag.

Se probaron localmente los flujos de proyectos, tareas, notas, estadísticas, backup, reintentos y sincronización con datos controlados; el navegador recorre la UI contra PostgreSQL real. OpenCode se comprobó además con su CLI instalado y los proveedores gratuitos `opencode/nemotron-3-ultra-free` y `opencode/nemotron-3.5-lightning-free`. Los dos modelos también procesaron una reunión sintética completa con asociación de proyecto y extracción de hechos. Google/Jira tienen pruebas con respuestas representativas; se comprobó además la sincronización de Google en la instalación local, sin escrituras sobre cuentas externas.

El instalador local se genera con `npx electron-builder --mac dmg --arm64 --publish never`. Las otras plataformas se construyen en sus runners mediante `.github/workflows/release.yml`. Publicar `v0.4.0` activa ese flujo; `workflow_dispatch` permite construir sin publicar.

Referencias de los eventos implementados: [Codex](https://learn.chatgpt.com/docs/hooks), [Claude Code](https://code.claude.com/docs/en/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/reference/) y [OpenCode](https://opencode.ai/docs/plugins/).
