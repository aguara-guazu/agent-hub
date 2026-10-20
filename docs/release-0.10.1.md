# Agent Hub 0.10.1 — Equipos mixtos desde Orca

El agente líder puede consultar las CLI y modelos disponibles, recomendar una
composición de equipo y lanzar los miembros autorizados en worktrees hijos de
Orca. Cada miembro conserva su CLI, modelo, esfuerzo, rol y tarea; el líder
coordina desde su canal original.

## Cómo usarlo

Actualizá Agent Hub, sincronizá los clientes y reabrí sus conexiones MCP para
cargar la skill `local-collaboration` y las herramientas nuevas. Desde el líder
en un worktree Git de Orca podés pedir, por ejemplo:

> Proponeme un equipo con Kiro/Sol para implementar, un revisor dedicado y
> Claude Code/Haiku para explorar archivos y usar herramientas livianas.

El líder consulta el catálogo real y explica las opciones antes de ejecutar la
composición elegida. Una instrucción previa que ya define y autoriza el equipo
sigue siendo válida; no hace falta repetirla. Si cambia la composición, espera
la elección de la persona.

Las descripciones y esfuerzos indican su procedencia. Las sugerencias de roles
son heurísticas: un modelo listado no garantiza cuota, acceso ni rendimiento.
La selección conserva los IDs exactos; no sustituye modelos o esfuerzos de
forma silenciosa.

## Herramientas y coordinación

- `memory_team_catalog`: CLI, modelos, esfuerzos y requisitos de lanzamiento.
- `memory_team_prepare`: plan revisable sin crear worktrees ni ejecutar modelos.
- `memory_team_launch`: ejecuta el plan autorizado, fijado al padre y su revisión.
- `memory_team_status`: efectos, recibos e incorporaciones confirmadas.
- `memory_team_join`: incorpora al miembro desde su worktree y CLI asignados.
- `memory_team_close`: termina la coordinación y revoca invitaciones y entregas;
  conserva procesos, worktrees e historial.

Los miembros coordinan únicamente en el hilo raíz del equipo. Repetir un
lanzamiento no duplica agentes. Un resultado incierto requiere inspección; al
reiniciar, el daemon pausa los lanzamientos interrumpidos antes de habilitar el
chat. Las políticas y permisos propios de cada CLI siguen vigentes.

## Compatibilidad y actualización

Esta versión admite Claude Code, Codex y Kiro. Claude Code y Codex usan el
lanzador nativo de Orca. Kiro usa `agenthub-kiro` en una terminal Orca, en macOS
o Linux; el lanzamiento automático de Kiro en Windows se informa como no
disponible. Las otras CLI del Hub mantienen su colaboración habitual, pero
todavía no participan de este lanzador de equipos.

Las skills de fábrica se actualizan al iniciar y sincronizar el Hub. Se
conservan las skills personalizadas o eliminadas, los archivos con cambios
locales y las herramientas desactivadas por la persona.

## Validación

La integración pasó pruebas automatizadas, typecheck, lint y revisión
independiente. La prueba de actualización desde el catálogo anterior usa HTTP
y gateways MCP reales: verifica las seis herramientas, la actualización de la
skill, las reglas OFF, la preparación, idempotencia, incorporación, mensajes
entre canales y revocación al cerrar. Los efectos de Orca y el miembro de esa
prueba son controlados y no ejecutan inferencia.

En un ensayo separado con Orca y Kiro reales se confirmó el worktree hijo,
`gpt-5.6-sol` con esfuerzo `high`, recepción del prompt y respuesta. Estas pruebas
no equivalen a verificar todas las combinaciones de modelos, cuentas y sistemas.
El workflow de publicación comprueba Linux/Windows y construye instaladores de
macOS, Windows y Linux antes de publicar.
