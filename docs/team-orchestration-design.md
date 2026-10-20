# Equipos mixtos de Agent Hub

Estado: contrato de implementación, 2026-10-20. Responsable: Faro Austral.

El líder consulta la disponibilidad real, propone una composición concreta y la
persona decide. Cada miembro tiene CLI, modelo exacto, esfuerzo admitido, rol,
tarea y un worktree hijo aislado. El líder conserva su identidad y coordina
desde el canal original. No se trasladan sesiones ni se suplanta al líder.

## Contratos

- `memory_team_catalog`: instalación y catálogo de modelos nativos; devuelve
  descripciones con procedencia, esfuerzos y límites conocidos. Disponibilidad
  no prueba cuota ni autorización para inferencia. No resuelve "último" por
  alias ambiguos ni inventa benchmarks o precios.
- `memory_team_prepare`: sólo líder activo en Orca. Persiste propuesta inmutable
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
no se relajan permisos de las CLI y no se cierran terminales ni eliminan
worktrees como rollback.

## Decisiones de revisión

La autorización conversacional es deliberada: la persona decide desde su agente
líder. El backend identifica al líder y vincula la ejecución al plan exacto,
pero no certifica que una persona escribió la referencia de autorización. Un
líder que incumpla sus instrucciones puede declarar falsamente esa autorización;
no se presenta este mecanismo como una barrera contra un agente comprometido.
Agregar un consentimiento autenticado en UI sería un modo diferente, fuera de
este alcance. Las políticas del cliente siguen aplicando.

Las invitaciones tienen hash en reposo, vencimiento, consumo atómico y alcance
limitado a un miembro, CLI y worktree devuelto por Orca. Se entregan en el prompt
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

## Verificación

Cubrir catálogo parcial/no instalado, esfuerzo no admitido, líder ajeno,
expulsado o canal cerrado, plan alterado, doble lanzamiento concurrente,
reinicio entre intención y recibo, fallos parciales, invitación en carpeta
incorrecta, coordinación entre miembros autorizados y rechazo de terceros.
El ejemplo de cuatro Kiro y un Haiku es un caso de aceptación, no una orden de
lanzar cinco sesiones durante el desarrollo.
