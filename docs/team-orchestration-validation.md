# Validación de equipos mixtos

Fecha: 2026-10-20. Integración: `aguara-guazu/hub-team-orchestration`.

## Prueba local con Orca y Kiro

- El adaptador consultó el worktree padre real y creó
  `hub-team-launch-smoke` como hijo con la revisión aprobada `096d45e`.
- Orca rechazó `agent launch --agent kiro --model gpt-5.6-sol --effort high`
  con `invalid_argument`: su lanzador no permite seleccionar el modelo de Kiro.
  La inspección confirmó que sólo existía la terminal shell del worktree.
- Se implementó una ruta explícita con la CLI nativa conectada `agenthub-kiro`,
  dentro de una terminal Orca, conservando modelo y esfuerzo.
- La terminal real mostró `kiro_default · gpt-5.6-sol · high`.
- La pregunta posicional de arranque no apareció en la TUI. Después de observar
  el compositor vacío se envió una única instrucción de prueba por
  `terminal send`; el agente respondió `listo` y quedó disponible.
- Terminal del ensayo: `term_ce89cf0e-dd34-4b58-98aa-2605624439e0`.
  Recibo local: `/tmp/agenthub-team-orca-smoke.json`.
- No se lanzó el equipo de cinco miembros del ejemplo, no se cambiaron permisos
  y no se publicaron cambios en la instalación personal del Hub.

## Alcance

El ensayo confirma worktree hijo, ejecución nativa, modelo, esfuerzo y recepción
de entrada. El flujo completo de las nuevas herramientas se valida en pruebas
con base aislada; no se ha probado contra el daemon personal instalado.

La disponibilidad de un catálogo no prueba cuota ni acceso. Kiro no informó
esfuerzos por modelo en este catálogo: se distingue la compatibilidad conocida
del adaptador de los valores reportados por una CLI.

## Catálogo local observado

La consulta nativa, sin inferencia, devolvió 12 modelos de Claude Code, 7 de Codex
 y 20 de Kiro el 2026-10-20. Claude Code informó `claude-haiku-5-5` con esfuerzo
`high`; Kiro informó `gpt-5.6-sol`, cuya selección `high` se verificó en el ensayo.
Las descripciones, ventanas de contexto y multiplicadores se conservan sólo
cuando la CLI los proporciona. El acceso de la cuenta sigue marcado como no
verificado hasta usar el modelo.

## Hallazgos de revisión corregidos

- `team_catalog` conserva el catálogo fuera de Orca, pero sólo anuncia
  `launchable` con un worktree confirmado y los requisitos del adaptador
  disponibles. Un fallo de preflight no publica rutas ni errores privados.
- El servicio propietario del daemon recupera lanzamientos interrumpidos antes
  de exponer chat y notificaciones: pausa el plan, marca efectos pendientes como
  inciertos y revoca invitaciones y entregas pendientes. Los workers y scripts
  que comparten la base no recuperan ni pausan lanzamientos del daemon activo.
- Una prueba con dos servicios sobre la misma base verifica esa distinción y
  rechaza el primer mensaje del hijo tras un reinicio, sin necesitar una llamada
  previa a las herramientas de equipo.
