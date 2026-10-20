# Arquitectura TypeScript/Electron

## Objetivo

Agent Hub se distribuye como una aplicación Electron y usa exclusivamente TypeScript/JavaScript sobre Node.js. El renderer React, el control plane local, el daemon, el gateway MCP y los servidores de prueba comparten contratos compilados. No se distribuye ningún runtime adicional.

## Paquetes

- `packages/shared`: tipos, esquemas, nombres expuestos, JSON canónico y hashes. No accede a disco ni red.
- `packages/memory`: memoria de proyectos, colaboración local y orquestación de equipos. `TeamCatalog` observa CLI/modelos/capacidades; `TeamOrchestration` valida autoridad, persiste planes/recibos/invitaciones y coordina canales; `TeamOrca` es la interfaz acotada de efectos externos.
- `packages/core`: SQLite, migraciones, autenticación, catálogo, políticas, matriz, snapshots, auditoría y API HTTP compatible bajo `/api`.
- `packages/daemon`: estado en disco, sincronización, adaptadores de Claude Code/Codex/Gemini/Kiro/OpenCode/Antigravity/Claude Desktop, materialización de skills, secretos y selección de runtime.
- `packages/gateway`: servidor MCP headless por stdio, política por llamada, pool de upstreams stdio/HTTP y auditoría al core.
- `desktop`: proceso principal Electron, tray, single-instance, inicio al login, supervisor del core y enlaces IPC mínimos.
- `frontend`: renderer React/Vite existente, consumiendo la misma API y tipos compartidos.
- `testdata`: servidores MCP y proveedor OIDC de prueba en TypeScript.

## Procesos

El proceso principal de Electron inicia el core HTTP en loopback y permanece en tray al cerrar la ventana. Cada CLI ejecuta el entrypoint headless `agenthub gateway --agent <id>` por stdio. El gateway no toma el lock de instancia de Electron, no abre una ventana y no necesita que el renderer esté visible. El instalador incluye ambos entrypoints JavaScript.

## Orquestación de equipos

`TeamOrchestration` recibe `LocalChat`, `TeamCatalog` y `TeamOrca`; no ejecuta comandos arbitrarios. El catálogo y el adaptador se inyectan para que discovery, validación, persistencia y efectos puedan probarse por separado. El adaptador de Orca sólo opera en el host local y recibe objetos validados y argumentos separados.

Preparar un equipo persiste un plan canónico y digest, sin efectos. Lanzar exige el líder vigente del canal master, el plan exacto y una declaración textual de la orden explícita de la persona. Esa declaración es auditable pero no se presenta como autenticación humana ni como un grant de UI. Antes de cada efecto se revalidan líder y sesión no cerrados/expulsados, canales activos, catálogo y padre `{id, repo_id, path, head}`; el hijo debe conservar el HEAD aprobado.

La intención precede a cada efecto. Los estados distinguen `workspace_intent`, workspace creado, `launch_intent`, `launching`, aceptado, `unknown` e incorporación. Las transiciones son monotónicas: accepted no pisa joined. `launch_handle` y `operation_id` aparecen en status para inspección y no son secretos. Si `TeamOrcaError` aporta `operation_id`, se conserva al marcar `unknown`. Tras reiniciar, cualquier efecto en vuelo queda incierto/paused y exige recovery manual; nunca se reintenta automáticamente. Restore pausa ejecuciones y revoca invitaciones activas. No se eliminan worktrees ni se cierran terminales como rollback.

Cada hijo registra una conversación nueva en su propio canal. `join` revalida master/líder/canales activos y el `agent.orca_workspace_id` exacto del slot antes de consumir la invitación. Las invitaciones tienen hash en reposo, TTL y uso único, están ligadas a plan, slot, miembro, workspace y CLI, y nunca sustituyen una `session_key`. El token forma parte del prompt inicial y Orca lo transporta mediante `--prompt` en argv transitorio, visible para el usuario y procesos locales; sólo el hash se persiste. El adaptador limpia variables `AGENTHUB_*`, Electron y routing heredado, conserva el PATH de launches GUI y nunca incluye stdout o stderr crudos en errores. El master conserva coordinación, mientras cada canal conserva su propio `leader_id`. La ACL cross-channel se limita al hilo raíz del equipo y preserva autor y origen; no amplía `chat_send` ni `chat_kick` al canal completo.

`memory_team_close(plan_id,digest,reason)` exige el master vigente, marca el plan cancelled/closed y revoca invitaciones y ACL sin matar procesos, cerrar terminales, borrar worktrees ni perder historial. Cada efecto consulta el cierre antes de empezar. Si uno ya estaba en vuelo, su recibo puede persistirse de forma monotónica, pero no reabre el plan ni habilita efectos posteriores.

## Persistencia

SQLite sigue siendo la fuente local. Las migraciones TypeScript reconocen tablas y datos de esquemas anteriores, hacen copia de seguridad antes de modificar la base y registran su propia versión en `schema_migrations`. Todos los timestamps se guardan como ISO-8601 UTC y los documentos como JSON canónico. El producto local usa una sola base embebida.

## Compatibilidad obligatoria

1. Se preservan las rutas, cuerpos, códigos y respuestas de `docs/API_CONTRACT.md`.
2. JWT de consola y token opaco `ahd_` del daemon siguen siendo principales no intercambiables.
3. El hash del snapshot excluye `snapshot_hash` y `generated_at` y es determinista.
4. Precedencia: default ON, regla de persona, regla de cliente; cuarentena siempre deniega.
5. `tools/list` usa el snapshot local y `tools/call` vuelve a leer la política vigente antes de conectar al upstream.
6. Una denegación nunca inicia ni invoca el upstream y sólo registra digest de argumentos.
7. El modo degradado conserva el último snapshot válido, nunca fail-open.
8. Cada adaptador escribe únicamente la entrada `hub`, preserva contenido ajeno y usa reemplazo atómico.
9. Los secretos sólo son referencias `keychain://`, `env://` o `file://`; nunca entran en snapshot, logs o SQLite.
10. Cerrar la ventana deja el proceso en tray; salir explícitamente detiene core y watchers de forma ordenada.

## Dependencias

Las versiones se fijan exactamente. Fastify implementa HTTP; `better-sqlite3` aporta transacciones locales; `jose` JWT/OIDC; el SDK MCP oficial implementa cliente y servidor; Electron y electron-builder producen artefactos macOS, Windows y Linux. Las dependencias nativas se reconstruyen para Electron durante packaging.

## Estrategia de pruebas

- Unitarias: nombres/hashes/política, validación, secretos, adaptadores y migraciones.
- Contrato HTTP: cada endpoint y separación de principales.
- Integración MCP: servidor real por stdio y HTTP.
- Invariante: misma sesión MCP, cambio ON→OFF, siguiente llamada denegada y archivo del upstream sin cambios.
- Degradación: apagar core, conservar lista/denegación desde disco.
- Escritorio: smoke del main process con ventana simulada y validación de configuración de builder.
- Calidad: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` y búsqueda de runtimes ajenos al stack igual a cero.

## Retirada completada

El repositorio, sus pruebas, sus scripts y su packaging usan sólo Node.js, TypeScript y Electron. Las bases existentes se reconocen y respaldan antes de registrar las migraciones actuales.
