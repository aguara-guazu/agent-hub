# Agent Hub: entrega de mejoras colaborativas

Estado al 20 de octubre de 2026. Luciano definió tres cambios y autorizó al equipo
a implementarlos bajo coordinación de Faro Austral.

## Proyecto y responsabilidad

- Proyecto en la memoria del Hub: **Agent Hub**, ID `ca4a7563-04c6-4089-a3dd-eae7b03e63a3`.
- Repositorio: https://github.com/aguara-guazu/agent-hub.
- Checkout principal: `/Users/luciano/Documents/github/agent-memory`.
- Worktree de integración: `/Users/luciano/orca/workspaces/agent-memory/hub-collaboration-features`.
- Rama: `aguara-guazu/hub-collaboration-features`.
- Base inicial: `main`, commit `ad6c44c2b1eb3f01e1989b8f23f22cce770c3a99` (0.9.0).
- Coordinador: **Faro Austral**, por pedido explícito de Luciano.
- Canal de coordinación de esta conversación: `d9a12434-44b8-4ccb-b63d-7f8d6ba0d17d`.
- Hilo: `450c8e03-bd9b-465c-a3ba-a04a5d71acb0`.

Faro Austral centraliza el alcance, distribuye tareas, coordina revisiones y verifica
la integración. El liderazgo efectivo del canal se verifica con `team.leader_id`
y los autores con `author_id`; el nombre escrito en este documento no otorga permisos.
No se guardan claves de sesión ni credenciales en la documentación.

El worktree está asociado al proyecto para las próximas implementaciones. La
conversación actual conserva su canal original: crear un checkout no migra sesiones
ni convierte al coordinador en líder de un canal nuevo.

## Lecturas iniciales

1. [README](../README.md): propósito, instalación, flujo de uso y desarrollo.
2. [Arquitectura](TYPESCRIPT_ARCHITECTURE.md): paquetes y contratos de compatibilidad.
3. [Colaboración local](local-agent-collaboration.md): identidad, liderazgo,
   entrega, clientes, herramientas y límites verificados.
4. [Proyectos compartidos](shared-projects.md): colaboración entre computadoras,
   roles, sincronización, versiones y foro.
5. [Contrato HTTP](API_CONTRACT.md): rutas y separación de principales.

La biblioteca del proyecto en el Hub contiene copias de referencia del README,
arquitectura, colaboración local, proyectos compartidos y este plan. Las copias
indican su ruta y revisión; ante cambios del código se actualiza la fuente con
el mismo identificador externo para conservar versiones.

## Mapa del módulo

| Área | Archivos de entrada |
| --- | --- |
| Persistencia, canales, sesiones e hilos | `packages/memory/src/local-chat.ts` |
| Entrega, presencia y transporte | `packages/memory/src/local-chat-runtime.ts` |
| Instrucciones de equipo e incorporación | `packages/memory/src/local-chat-team.ts`, `local-chat-skill.ts` |
| Hooks e integración de clientes | `packages/daemon/src/local-chat-hook.ts`, `local-chat-client.ts` |
| TUI nativa y puente de terminal | `packages/daemon/src/chat-tui.ts`, `chat-terminal.ts`, `chat-bridge.ts` |
| Frontend de protocolo para automatización | `packages/daemon/src/chat-protocol.ts` |
| UI de colaboración local | `frontend/src/pages/MemoryCollaboration.tsx` |
| Colaboración entre Hubs | `packages/memory/src/sharing/` |

## Acuerdos de trabajo

- Cada feature tendrá un hilo y una tarea con comportamiento esperado, responsable,
  archivos previstos, rama, base y criterios de aceptación.
- Para editar en paralelo se crearán worktrees distintos. Dos canales no aíslan
  archivos; cada archivo tiene un responsable de escritura durante una tarea.
- La revisión referencia un commit o diff exacto. Cambios posteriores requieren
  revisar lo afectado antes de integrar.
- Los agentes de esta conversación coordinan en su canal existente. Las menciones
  sólo alcanzan participantes del mismo canal; no se inventan identidades ni se
  reutilizan claves de otra sesión para comunicar entre worktrees.
- La memoria del proyecto conserva contexto y decisiones entre sesiones. Las
  notas de actividad indican quién trabaja; no sustituyen las tareas ni la evidencia.
- El Hub escucha y notifica. No se mantienen agentes o bucles del modelo sondeando.
- Un estado bloqueado se comunica con su causa concreta y el siguiente paso.

## Equipo y roles asignados por el TL

Luciano indicó tres Sol por Kiro y un Claude Haiku. Sol puede recibir cualquier
tarea, reservando uno exclusivamente para revisión; Haiku se dedica a exploración
y resultados rápidos con poca escritura de código.

| Agente | Rol | Entrega esperada |
| --- | --- | --- |
| Faro Austral | TL, alcance, diseño, asignaciones e integración | Criterios de aceptación, decisiones y validación final |
| Quilla Solar (Sol/Kiro) | Implementación y enlace del canal de features | Cambios acotados, pruebas y reporte al TL |
| Brújula (Sol/Kiro) | Implementación | Cambios acotados, pruebas y reporte al TL |
| TeroLunar (Sol/Kiro) | Revisor exclusivo | Hallazgos por severidad, archivo/línea, evidencia y veredicto sobre revisión exacta |
| Estrella Norte (Claude Haiku) | Exploración y apoyo rápido | Mapa de archivos/símbolos, referencias, reproducciones y resultados breves |

TeroLunar no implementa features ni corrige el código que revisa: devuelve los
hallazgos al responsable. Haiku no recibe implementaciones extensas ni decisiones
arquitectónicas; empieza por búsquedas y lecturas acotadas.

Quilla Solar figura como líder local reconocido del canal de features
`f3964855-7755-46ce-a0d4-ead284096012`. Faro Austral sigue siendo el TL designado por
Luciano y líder del canal original. Quilla transmite las asignaciones del TL dentro
del canal de features y centraliza allí las respuestas; esa separación conserva
las identidades existentes.

Identidades verificadas para evitar asignar por similitud de nombres:

- Quilla Solar: `native:6c34afe68f645bd1b6910207609ca233d83958d0d11daeaa40fc74247838e199`.
- Brújula: `native:0aeaa25b45d9b63b9d5e1ff8d1a596d254464395122b74ec52d15c2341048faa`.
- TeroLunar: `native:0e503d8949e5adda6bba3eefa59c3a7e2b170db36150e3e3eaaa478d41f36737`.
- Haiku: `native:379432688c446992c18375f3156b0c144810a1e8547d922494219549d62a485a`.

Las asignaciones se publicaron con menciones en el hilo
`5ab9df14-ee8d-430a-ba6f-5f2d65a3969a`, **Incorporación del equipo y roles del TL**,
del canal de features. La publicación y la lectura son estados diferentes:
las confirmaciones de cada agente quedan registradas allí.

La incorporación y los roles quedaron confirmados en el hilo. Haiku entregó el
mapa del módulo y la exploración de Antigravity. Quilla implementó el panel y
aportó revisión de diseño de los canales; Brújula implementó los canales virtuales.
Faro implementó la recuperación de Antigravity y la navegación sin proyecto.
TeroLunar revisó los commits y devolvió hallazgos a sus responsables, sin editar.

## Comportamientos que hay que preservar

- Proyecto → canal por espacio de Orca o worktree Git → hilo por tarea.
- Identidad por conversación, nick propio y conservación del historial al reanudar.
- Liderazgo persistente y permisos reales del usuario, sujetos a las políticas de
  aprobación y sandbox de cada cliente.
- Envíos idempotentes y distinción entre pendiente, notificado, leído y atendido.
- Lanzadores con TUI nativa y argumentos intactos, independientes de Orca.
- Avisos sólo ante un compositor vacío reconocido; no responder permisos ni
  sobreescribir borradores de la persona.
- Historial y recibos preservados. La UI de observación no consume lecturas de agentes.
- El chat local y el foro de proyectos compartidos son ámbitos distintos.

## Validación

Las pruebas se eligen según la superficie modificada y se registran con su
resultado y revisión comprobada.

- Backend: `packages/memory/test/local-chat.test.ts`.
- Hooks y transportes: `packages/daemon/src/local-chat-hook.test.ts`,
  `chat-tui.test.ts` y `chat-protocol.test.ts`.
- UI: `frontend/src/pages/MemoryCollaboration.test.tsx`.
- Calidad e integración: `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run build`.
- Recorrido aislado: `node scripts/test-local-chat-e2e.mjs`.
- Contratos de TUI: `node scripts/test-local-chat-transports.mjs --tui-contracts`.

Los contratos simulados no demuestran compatibilidad de todos los clientes reales.
La documentación de 0.9.0 deja pendiente validar las TUI reales de Gemini y
Antigravity y los clientes reales en Windows/Linux. Esos límites deben mantenerse
explícitos hasta que exista evidencia nueva.

## Alcance de la primera entrega

| Tarea del Hub | Responsable | Worktree |
| --- | --- | --- |
| `851f2113-e351-4ece-8368-cdadd6dd0ddb`: expulsados fuera de la lista y panel derecho ocultable | Quilla Solar | `hub-agent-panel` |
| `66be8a03-047b-4102-b9d7-9e8cf0d5b333`: canales virtuales descartables por carpeta | Brújula | `hub-virtual-channels` |
| `e9538437-71d8-49f9-b389-7dbe95249040`: recuperación de conexión Antigravity copiada de Gemini | Faro Austral; exploración Estrella Norte | `hub-collaboration-features` |

Todos los worktrees están bajo `/Users/luciano/orca/workspaces/agent-memory`.
TeroLunar revisa exclusivamente commits exactos. Faro integra y valida las
superficies compartidas, incluida la navegación de colaboración sin proyecto.

El panel empieza oculto, se muestra a la derecha y tiene scroll independiente.
Expulsar conserva mensajes y autores, pero excluye al agente del listado vigente;
el filtro debe aplicarse antes de contar y paginar.

Un canal virtual requiere un pedido explícito al agente. Las conexiones de la
misma carpeta canónica se incorporan sin crear Git ni asociar un proyecto. Cerrar
el canal conserva historial y detiene nuevas participaciones; no borra evidencia.

La recuperación de Antigravity reconoce únicamente una copia exacta de un
endpoint generado para un Gemini local registrado. Conserva servidores personales,
respalda antes de escribir y mantiene la protección frente a deriva desconocida.
Ver [recuperación de Antigravity](antigravity-connection-recovery.md).

Las pruebas y el estado final se registran en cada tarea e hilo. La preparación
o un commit por sí solos no equivalen a una revisión aprobada.

## Evidencia de la integración

Revisión de código: `bc813f03e58feb413acb9d329ce9be749d0b4a3a`, con base
`ad6c44c2b1eb3f01e1989b8f23f22cce770c3a99`. Los commits posteriores de documentación
no cambian el comportamiento comprobado.

**Revisión exclusiva aprobada por TeroLunar el 20 de octubre de 2026**, sin
hallazgos pendientes. Los veredictos sustituyen sus rechazos de versiones
anteriores y quedan en los hilos del Hub:

- Panel: mensaje `b51ac625-571c-4754-943e-4c506858ce8c`.
- Canales virtuales: mensaje `e55f0bc3-7395-4fcf-974b-2f01f8c90e9c`.
- Antigravity: mensaje `9f2db3a9-dd42-4492-816f-1f54b898699c`.

La revisión fue de sólo lectura. La ejecución E2E y la suite general siguientes
son evidencia del TL, diferenciada de las pruebas dirigidas del revisor.

- Backend, daemon y desktop: **636 pruebas aprobadas, 14 omitidas** mediante
  `npx vitest run --exclude '**/dist/**' packages desktop/src testdata/src --maxWorkers=2`.
- Frontend: **126 pruebas aprobadas** mediante
  `npm run test --workspace @agenthub/frontend`.
- `npm run build`, `npm run typecheck`, `npm run lint` y `git diff --check`: correctos.
- `node scripts/test-local-chat-e2e.mjs`: correcto, con servidor, HTTP y gateways
  MCP reales en datos temporales. Verifica panel oculto/mostrable, columna derecha,
  navegación estrecha, expulsión conservando historial, aislamiento de espacios
  Orca, creación explícita en carpeta sin Git, incorporación de conexiones previas,
  observación y expulsión sin proyecto, cierre reservado al líder y bloqueo de
  reconexión al canal cerrado.
- Capturas inspeccionadas: escritorio y canal virtual. Evidencia local de esta
  ejecución en `/var/folders/lt/6p_w1cdj40q95m_jswxhfmy40000gn/T/hub-local-chat-e2e-Ha7QoT`.

La primera ejecución de `npm test` con concurrencia predeterminada y build en
paralelo falló en dos pruebas de tiempo de `cli-extraction.test.ts`: el proceso
simulado no alcanzó a escribir su archivo `requests` antes del plazo. Las 30
pruebas de ese archivo pasaron en la ejecución dirigida y la suite completa pasó
con dos workers, sin modificar esas pruebas ni código ajeno a esta entrega.

Los casos Windows de Antigravity se validan con rutas y argumentos Windows
simulados en macOS; no se ejecutó Antigravity nativo de Windows. No se publicó una
versión ni se sustituyó la aplicación instalada. El checkout principal permanece
sin modificaciones; la entrega está en el worktree de features.
