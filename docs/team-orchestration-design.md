# Equipos mixtos de Agent Hub

Estado: contrato actualizado, 2026-10-22. Responsable: Faro Austral.

El líder consulta la disponibilidad real, propone una composición concreta y la
persona decide. Cada miembro tiene CLI, modelo exacto, esfuerzo admitido, rol,
tarea y un worktree hijo aislado. El líder conserva su identidad y coordina
desde el canal original. No se trasladan sesiones. El dueño puede designar otro coordinador desde la UI; los planes previos quedan pausados y se revocan sus vínculos.

## Contratos

- `memory_team_catalog`: instalación y catálogo de modelos nativos; devuelve
  descripciones con procedencia, esfuerzos y límites conocidos. Disponibilidad
  no prueba cuota ni autorización para inferencia. No resuelve "último" por
  alias ambiguos ni inventa benchmarks o precios.
- `memory_team_prepare`: `task_key` etiqueta el trabajo y conserva el canal existente. Exige un canal activo creado explícitamente con `memory_chat_create_channel` tras preguntar a la persona y obtener autorización, tanto con Git como sin Git; preparar no activa canales ni concede liderazgo. Exige coordinador activo; runtime del Hub con espacios Git o virtuales. Persiste propuesta inmutable
  y digest: objetivo, padre, revisión base y miembros con CLI, modelo, esfuerzo,
  rol y tarea. Devuelve el plan completo para mostrar a la persona.
- `memory_team_launch`: exige ID y digest del plan exacto y referencia textual
  a la instrucción de la persona. Sólo el líder dueño puede ejecutarlo después
  de la elección explícita. Esa referencia es una declaración del agente, no
  una aprobación humana autenticada: las políticas de las CLI siguen vigentes.
  Revalida catálogo antes de crear recursos. Nunca cambia modelo/esfuerzo.
- `memory_team_status`: plan, worktrees y recibos persistidos, con estados que
  distinguen lanzamiento aceptado, incorporación y resultado incierto.
- `memory_team_join`: miembro presenta invitación de un solo uso y se vincula
  exclusivamente desde el worktree asignado. Conserva su propia session_key.
- Coordinación: extensión acotada al hilo raíz creado para ese equipo,
  comprobando el vínculo de cada sesión, equipo activo, líder vigente y canales
  abiertos en cada escritura. No habilita otros hilos del canal ni otros canales.
  La autoría sigue siendo la sesión original.

Se persiste la intención antes de cada efecto externo. Repetir launch devuelve
el estado guardado; un lanzamiento incierto requiere reconciliación y nunca
origina un segundo agente automáticamente. No se ejecutan shells arbitrarias,
el plan declara los permisos completos de los trabajadores del Hub. No se eliminan
espacios como rollback.

## Decisiones de revisión

La autorización conversacional es deliberada: la persona decide desde su agente
líder. El backend identifica al líder y vincula la ejecución al plan exacto,
pero no certifica que una persona escribió la referencia de autorización. Un
líder que incumpla sus instrucciones puede declarar falsamente esa autorización;
no se presenta este mecanismo como una barrera contra un agente comprometido.
La UI también permite aprobar el digest exacto mediante una ruta autenticada del dueño. Las políticas del cliente siguen aplicando.

Las invitaciones tienen hash en reposo, vencimiento, consumo atómico y alcance
limitado a un miembro, CLI y espacio devuelto por el runtime. Se entregan en el prompt
inicial privado del agente, visible para la persona y su CLI; no son claves de
sesión. No se publican en status, documentación ni mensajes del equipo.

Se fija `{id, repo_id, path, head}` del padre y se revalida antes de efectos.
`create` pasa `parent.head` como base explícita y verifica el padre y HEAD del
resultado. Restore conserva historia e invalida ejecución/invitaciones.

## Distribución

- Faro Austral: adaptador Orca, integración de operaciones/servicio y validación.
- Brújula: servicio de equipos, persistencia, invitaciones y permisos de chat;
  tests de autorización, duplicados, fallos parciales e identidad.
- Brújula Cobalto: catálogo de CLI/modelos y descripciones; tests de discovery.
- Quilla Solar: skill colaborativa y documentación de uso; coordinación local.
- TeroLunar: revisión exclusiva de diseño e implementación.
- Estrella Norte: exploración rápida de comandos y contratos Orca, sólo lectura.

## Interfaz del adaptador Orca

Archivo `packages/memory/src/team-orca.ts`, propiedad de Faro Austral:

```ts
interface TeamWorkspace {
  id: string; path: string; repo_id: string; head: string;
}
interface TeamLaunchReceipt {
  handle: string; kind: string; operation_id?: string;
  prompt_outcome: string;
}
interface TeamOrca {
  preflight?(members: Array<{
    cli: 'kiro' | 'claude_code' | 'codex_cli'; model: string; effort?: string;
  }>): Promise<void>;
  workspace(id: string): Promise<TeamWorkspace>;
  create(parent: TeamWorkspace, name: string): Promise<TeamWorkspace>;
  launch(workspace: TeamWorkspace, member: {
    cli: 'kiro' | 'claude_code' | 'codex_cli';
    model: string; effort?: string; prompt: string;
  }): Promise<TeamLaunchReceipt>;
}
```

El adaptador usa argumentos separados, `--json`, padre explícito y revisión base
exacta. Los IDs y recibos provienen de Orca. No deriva handles ni acepta comandos
del modelo.

Claude y Codex usan `agent launch`. La versión de Orca probada rechaza
explícitamente la selección de modelo de Kiro. Para Kiro se crea una terminal
Orca que ejecuta el lanzador fijo `agenthub-kiro`, con modelo y esfuerzo como
argumentos escapados para POSIX. El adaptador verifica ese lanzador en preflight;
esta ruta admite macOS/Linux. No se omite el modelo ni se cambian permisos.

La TUI de Kiro probada ignoró la pregunta posicional de arranque. Se espera su
estado idle, se verifica el compositor vacío y se envía el prompt una sola vez
mediante `terminal send`. `input-accepted` confirma aceptación de entrada, no
inferencia ni incorporación. Una falla posterior a crear la terminal conserva
su handle para inspección.

En la flota del Hub (`HubTeamRuntime`), Kiro corre en segundo plano con
`kiro-cli acp --model <m> [--effort <e>] --trust-all-tools`, sin terminal.
El cliente ACP anuncia `fs` y `terminal` deshabilitados, abre `session/new`
sin servidores MCP adicionales (rige la configuración propia de Kiro, que
incluye el Hub) y envía la tarea con `session/prompt`. Esa RPC queda abierta
durante todo el turno: sólo su `stopReason` marca al trabajador idle
(`refusal` lo marca fallido). La interrupción usa `session/cancel`. Un
`session/request_permission` residual se responde `cancelled` (nunca se
concede); otra solicitud del agente que no sea una extensión `_*` falla el
proceso. La actividad visible sólo toma texto del agente, título y entrada de
cada herramienta y bloques de texto de sus resultados. Kiro no admite agregar
entrada a un turno en curso.

## Verificación

Cubrir catálogo parcial/no instalado, esfuerzo no admitido, líder ajeno,
expulsado o canal cerrado, plan alterado, doble lanzamiento concurrente,
reinicio entre intención y recibo, fallos parciales, invitación en carpeta
incorrecta, coordinación entre miembros autorizados y rechazo de terceros.
El ejemplo de cuatro Kiro y un Haiku es un caso de aceptación, no una orden de
lanzar cinco sesiones durante el desarrollo.

La preparación, el registro previo sin contexto y los espacios virtuales se describen en [Colaboración local](local-agent-collaboration.md#preparación-y-recuperación-de-equipos).


La incorporación entrega el registro de autorización con procedencia (`owner_ui`, `coordinator_declaration` o `legacy_record`), encargo aprobado y pares del equipo. Los operadores pueden recibir subtareas de sus pares dentro de ese alcance; las dudas técnicas se resuelven con el TL y los bloqueos se reportan con su causa concreta. `clear` retira la sesión anterior y sus avisos después de confirmar la detención. La eliminación recuperable de canales cancela sus planes y reporta cualquier detención incierta; ver la papelera en la guía de colaboración local.
