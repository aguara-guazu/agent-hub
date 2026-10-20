# Automatización con CLI locales

Revisión de documentación oficial: 7 de octubre de 2026. Esta integración no implica aval de los proveedores ni garantiza que una cuenta no reciba restricciones. Rigen los términos del proveedor, el plan y las políticas de la organización de cada usuario.

| Cliente | Interfaz utilizada | Autenticación y condiciones |
| --- | --- | --- |
| Claude Code | `claude -p`, JSON y protocolo de control para modelos | Binario instalado por el usuario, sin modificar. La documentación contempla ejecutarlo dentro de productos bajo los términos comerciales aplicables, conservando sus métodos de autenticación. Cada usuario aporta su cuenta o credenciales y paga directamente al proveedor. |
| Codex | `codex exec` y `app-server model/list` | La ejecución no interactiva reutiliza la autenticación guardada por la CLI. Agent Hub no copia `auth.json` ni ofrece un servicio compartido de inferencia. |
| Kiro CLI | `chat --no-interactive`, `--effort` y `chat --list-models` | La documentación headless exige `KIRO_API_KEY`. Agent Hub permite guardarla en Ajustes y la entrega como `KIRO_API_KEY` únicamente al proceso Kiro. Verifica que haya una clave disponible antes de iniciar una extracción. El login interactivo por sí solo no habilita la automatización. |
| OpenCode | Servidor local oficial `opencode serve`, API de sesiones y variantes | Usa las conexiones configuradas por el usuario. Que un proveedor aparezca conectado no acredita permiso para usar una suscripción mediante plugins de terceros; deben usarse conexiones autorizadas por ese proveedor. |

Agent Hub no distribuye ni modifica estos binarios. No extrae tokens de sesión, falsifica identidad de clientes, rota cuentas ni sustituye proveedores para sortear rechazos o cuotas. No se añaden APIs privadas de inferencia. Las tareas requieren habilitar procesamiento remoto y respetan las exclusiones por fuente o proyecto.

Los rechazos de autenticación detienen la tarea. Los límites y fallos temporales se manejan mediante reintentos limitados con espera; no se crean cuentas ni credenciales alternativas. Las pruebas usan contenido sintético y también consumen cuota.

El esfuerzo se pasa mediante opciones nativas: `--effort` en Claude Code y Kiro, `model_reasoning_effort` en Codex y `variant` en OpenCode. Se rechazan niveles que no estén en el catálogo admitido. El catálogo de Kiro actualmente omite los niveles; se utiliza una lista explícita de modelos documentados, sin asumir compatibilidad en modelos desconocidos. Las políticas de la organización y los límites del proveedor siguen teniendo precedencia.

## Catálogo para equipos interactivos

El catálogo de equipos usa `ExtractionCli` —Claude Code, Codex y Kiro— como conjunto de candidatos, pero no convierte automáticamente una capacidad headless ni el tipo aceptado por `TeamOrca` en launch real. Claude Code y Codex usan `agent launch`. Orca rechaza selección de modelo Kiro por esa ruta; el adaptador inicial soporta Kiro sólo en POSIX mediante `terminal create --command` con el launcher fijo `agenthub-kiro`, después de verificar plataforma y launcher y antes de crear el worktree. Windows falla explícitamente hasta disponer de un runner seguro. No es un fallback: el plan conserva Kiro, modelo y effort exactos o falla sin crear recursos. Kiro publica `--model`, `--effort` y modelos sin efforts por modelo, por lo que cada combinación sigue requiriendo validación del catálogo.

Un modelo anunciado por una CLI no demuestra acceso, cuota ni permiso de la cuenta. La preparación puede mostrarlo con esa advertencia; el lanzamiento vuelve a validarlo y falla cerrado si la combinación quedó ausente, vencida o desconocida. No se resuelven aliases ambiguos, no se inventan precios o benchmarks y no se elige otro modelo para completar el equipo.

El esfuerzo conserva la semántica de cada cliente. `--effort` sólo se envía junto con un modelo cuando el catálogo de ese cliente admite el valor; no hay una escala universal que convierta niveles entre Claude Code, Codex y Kiro. En la ruta Kiro, el adaptador arma el comando fijo `agenthub-kiro` con argumentos quoted para `--model`, `--effort` y prompt nativo; no agrega trust flags, cambia permisos ni omite el modelo. `prompt_outcome: native-argv` confirma que el prompt quedó en argv, no que la inferencia haya empezado. Para Claude Code y Codex, **Chat UI** determina si el outcome es chat estructurado o terminal.

Orca sólo provee worktrees y launch en el host local. Agent Hub persiste intención, recibos, invitaciones y estado. `launch_handle` y `operation_id` aparecen en status para inspección y no son secretos; si el adaptador devuelve un `operation_id` con el error, se conserva al marcar `unknown`. La recuperación inspecciona handle, workspace y operación, pero no existe una tool que relance automáticamente; tras reiniciar, estados con efectos en vuelo pasan a incierto/paused y requieren recovery manual. Este flujo no usa `worker-start`. La invitación scoped forma parte del contenido del prompt y Orca la pasa mediante `--prompt` en argv transitorio, visible dentro del threat model del usuario local; no es una `session_key` y sólo su hash se persiste. El adaptador limpia variables `AGENTHUB_*`, Electron y routing heredado, conserva el PATH necesario para launches GUI y sanitiza errores sin copiar stdout o stderr crudos. Cerrar el equipo revoca ACL/invitaciones, pero no mata procesos ni borra worktrees.

## Referencias oficiales

- [Claude Code: ejecución programática](https://code.claude.com/docs/en/headless), [condiciones para integrarlo en productos](https://code.claude.com/docs/en/legal-and-compliance) y [esfuerzo por modelo](https://code.claude.com/docs/en/model-config).
- [Codex: ejecución no interactiva y autenticación](https://learn.chatgpt.com/docs/non-interactive-mode) y [configuración](https://learn.chatgpt.com/docs/config-file/config-reference).
- [Kiro: autenticación headless](https://kiro.dev/docs/cli/headless/) y [esfuerzo de razonamiento](https://kiro.dev/docs/models/effort/).
- [OpenCode: servidor local](https://opencode.ai/docs/server/) y [modelos y variantes](https://opencode.ai/docs/models/).
