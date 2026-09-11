# Review local de Agent Hub — 10 de septiembre de 2026

La conexión inicial y los formularios funcionan, pero la sincronización de estados todavía tiene fallos que impiden confiar en el apagado de herramientas y en las excepciones de skills por cliente. Se reprodujeron cinco problemas. No se modificó la implementación del producto: se agregaron este informe, scripts de diagnóstico y evidencia.

## Hallazgos por prioridad

### 1. [P1] Una sesión abierta puede ejecutar un server después de apagarlo

Ubicación: [packages/gateway/src/policy.ts:355](../../packages/gateway/src/policy.ts#L355), [packages/gateway/src/server.ts:147](../../packages/gateway/src/server.ts#L147).

El daemon guarda snapshots con un archivo temporal y `rename`. El gateway observa el archivo original con `fs.watch`, sin volver a suscribirse al reemplazo. En esta Mac, después de una primera actualización, las siguientes dejan de actualizar la vista. Cada llamada consulta `store.current`, sin comprobar el archivo vigente.

Reproducción con procesos reales:

1. Registrar Escalidrau por HTTP y abrir el gateway con política ON.
2. Actualizar el cuerpo de una skill, generando un nuevo snapshot sin apagar el MCP.
3. Apagar el servidor mediante la API y sincronizar el daemon.
4. Verificar que el snapshot en disco contiene `servers: []`.
5. Invocar `review_escalidrau_get_canvas_style` en la sesión que seguía abierta.

**Resultado:** `isError: false`; volvió el estilo del lienzo desde Escalidrau. El apagado no se aplicó al gateway existente. Una sesión nueva sí respeta OFF.

También se probó ON → OFF → ON → OFF: el primer OFF llegó, pero el siguiente ON quedó bloqueado. Esto ocurrió tanto en los tres gateways generados para Claude/Codex/Kiro como en una misma sesión real de Codex, mediante su App Server.

Corrección sugerida: observar el directorio y filtrar por el nombre de snapshot para sobrevivir a los reemplazos atómicos, y comprobar la política vigente al atender cada llamada. Agregar regresiones con varios reemplazos atómicos, incluyendo una actualización inocua seguida de una revocación.

Evidencia: `revocation_after_prior_snapshot_update`, `same_session_toggle` y `codex_same_thread_toggle` en [evidence.json](evidence.json).

### 2. [P1] Apagar una skill en un cliente borra el archivo que utilizan los otros

Ubicación: [packages/daemon/src/adapters/skills.ts:165](../../packages/daemon/src/adapters/skills.ts#L165).

`planRemovals` incluye el store canónico entre las carpetas que limpia usando solamente el snapshot de un cliente. No comprueba si otros clientes todavía necesitan la skill.

Reproducción: materializar una skill para Claude y Codex; ponerla OFF solamente para Codex; aplicar el plan de ese adaptador. El plan borra tanto el enlace de Codex como `.agenthub/skills/<slug>`. Claude conserva política ON, pero su `SKILL.md` ya no es legible. Otra pasada puede volver a crear el archivo, haciendo que el resultado dependa del orden de sincronización.

Corrección sugerida: calcular la retención del store a partir de todos los clientes y separar esa limpieza de la eliminación de enlaces por cliente.

Evidencia: `skill_off_in_codex_only` en [evidence.json](evidence.json).

### 3. [P1] Codex y Gemini no pueden tener estados independientes en la misma raíz de skills

Ubicación: [packages/daemon/src/adapters/skills.ts:36](../../packages/daemon/src/adapters/skills.ts#L36).

Ambos adaptadores administran `.agents/skills`. Aunque se arregle la retención del store, un único enlace físico no puede representar simultáneamente ON para Codex y OFF para Gemini. Aplicar el snapshot vacío de Gemini elimina el enlace que Codex necesita.

Se reprodujo con ambos adaptadores sobre una carpeta temporal: Codex ON, Gemini OFF, misma raíz, skill de Codex ilegible. Esta comprobación es del materializador; Gemini CLI no está instalado y no se ejecutó su binario.

Corrección sugerida: definir cómo representar excepciones por cliente usando mecanismos que cada CLI soporte, o restringir las políticas independientes cuando la raíz sea compartida. La matriz debe reflejar esa limitación en lugar de prometer estados que los archivos no pueden expresar.

Evidencia: [shared-root-evidence.json](shared-root-evidence.json).

### 4. [P2] El preload compilado no carga con el sandbox de Electron

Ubicación: [desktop/src/preload.ts:1](../../desktop/src/preload.ts#L1), [desktop/src/window.ts:28](../../desktop/src/window.ts#L28).

El build conserva imports ESM en `preload.js`, mientras la ventana usa `sandbox: true`. Al cargarlo en Electron se emite `Cannot use import statement outside a module` y `typeof window.agentHub` devuelve `undefined`.

Se reprodujo con las opciones reales de `windowOptions`, primero en una ventana mínima y luego con el renderer compilado y un core real. La UI web funciona porque actualmente no consume ese puente; las funciones IPC expuestas para estado, reinicio y autostart quedan inaccesibles desde el renderer. Esto no demuestra un fallo de las acciones equivalentes del tray.

Corrección sugerida: generar un preload compatible con el sandbox, por ejemplo un bundle CommonJS que incluya sus imports locales, manteniendo el aislamiento de la ventana. Verificar el puente en un proceso Electron real.

Evidencia: [preload-evidence.json](preload-evidence.json) y [desktop-evidence.json](desktop-evidence.json).

### 5. [P2] Las CLI detectadas después del enrolamiento no se registran al sincronizar

Ubicación: [packages/daemon/src/app.ts:327](../../packages/daemon/src/app.ts#L327).

La detección y el registro se ejecutan durante el enrolamiento. `syncOnce` consulta los agentes ya registrados en el core, pero no reconcilia esa lista con las CLI presentes en disco.

Reproducción: enrolar con carpetas de Claude, Codex y Kiro; crear después `.gemini`; ejecutar otra sincronización. `detectClis` devuelve cuatro clientes, el roster sigue con tres y `.gemini/settings.json` no se escribe. Es una simulación de instalación posterior usando el criterio de detección del propio producto.

Corrección sugerida: detectar y registrar clientes nuevos durante el arranque y periódicamente durante la sincronización, sin exigir otro enrolamiento ni rotar el token de la máquina.

Evidencia: `new_cli_after_enrollment` en [evidence.json](evidence.json).

## Cobertura y resultados

| Comprobación | Resultado |
|---|---|
| `npm test` | 179 pruebas de paquetes/desktop/testdata + 71 de React: pasan |
| `npm run test:e2e` | 1 prueba: pasa; incluye build |
| `npm run typecheck` / `npm run lint` | Pasan |
| Ventana existente de Agent Hub | Inspección visual de catálogo vacío; acceso de OS limitado por foco/accesibilidad |
| Electron real, renderer compilado, core temporal | SSO, alta de server, sondeo de 21 tools, alta de skill y pantallas matriz/máquinas/personas/auditoría funcionan |
| Codex CLI 0.154.0 | `mcp list --json` reconoce el hub empaquetado; App Server enumera 21 tools y ejecuta una lectura real a través del gateway temporal |
| Claude Code 2.1.267 | `mcp get hub` confirma `Connected` contra el hub empaquetado |
| Kiro CLI 2.21.2 | `mcp list` y `mcp status --name hub` reconocen configuración, comando y estado habilitado; esos comandos no prueban ejecución de tools |
| Gateways de Claude/Codex/Kiro en entorno temporal | Los tres ejecutan la consulta real de Escalidrau usando sus configuraciones generadas |
| Gemini CLI | Binario no instalado; solamente pruebas del adaptador |

La prueba de Codex usa `initialize`, `thread/start` efímero, `mcpServerStatus/list` y `mcpServer/tool/call` del [protocolo oficial del App Server](https://learn.chatgpt.com/docs/app-server), contrastados con los schemas generados por el binario instalado. No inicia un turno de modelo. Las pruebas de Claude y Kiro no incluyeron un turno de modelo ni ejecución de una tool desde sus propios motores; las ejecuciones de sus gateways se hicieron con el SDK MCP.

Se compararon los archivos compilados de policy, skills, daemon app y preload con los del bundle actualmente abierto: son idénticos. Las pruebas detectan problemas presentes en ese código empaquetado, aunque los escenarios mutables corrieron en instancias temporales.

No se cambió el catálogo habitual, no se escribieron configuraciones personales de CLI y no se modificó el lienzo. La única herramienta invocada en Escalidrau fue la consulta de estilo. Las instancias temporales y sus archivos fueron cerrados y eliminados. No se probaron Windows/Linux, firma/notarización, autostart del sistema ni apagado de skills ya cargadas en el contexto de un modelo.

## Repetir los diagnósticos

Con Escalidrau abierto en `http://127.0.0.1:3580/mcp` y Codex instalado, ejecutar desde la raíz:

```sh
npm run build
node docs/review-2026-09-10/reproduce.mjs
node_modules/.bin/electron docs/review-2026-09-10/preload.cjs
node_modules/.bin/electron docs/review-2026-09-10/desktop-smoke.cjs
```

Estos scripts guardan observaciones en JSON: terminar con código cero significa que el diagnóstico terminó, no que los comportamientos observados sean correctos. No forman parte de la suite de regresión existente. El siguiente paso recomendado es corregir primero la revocación del gateway y la propiedad compartida de skills, convirtiendo estos escenarios en tests con resultados esperados.
