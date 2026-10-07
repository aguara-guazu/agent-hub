# Automatización con CLI locales

Revisión de documentación oficial: 7 de octubre de 2026. Esta integración no implica aval de los proveedores ni garantiza que una cuenta no reciba restricciones. Rigen los términos del proveedor, el plan y las políticas de la organización de cada usuario.

| Cliente | Interfaz utilizada | Autenticación y condiciones |
| --- | --- | --- |
| Claude Code | `claude -p`, JSON y protocolo de control para modelos | Binario instalado por el usuario, sin modificar. La documentación contempla ejecutarlo dentro de productos bajo los términos comerciales aplicables, conservando sus métodos de autenticación. Cada usuario aporta su cuenta o credenciales y paga directamente al proveedor. |
| Codex | `codex exec` y `app-server model/list` | La ejecución no interactiva reutiliza la autenticación guardada por la CLI. Agent Hub no copia `auth.json` ni ofrece un servicio compartido de inferencia. |
| Kiro CLI | `chat --no-interactive`, `--effort` y `chat --list-models` | La documentación headless exige `KIRO_API_KEY`. Agent Hub verifica que exista en su entorno antes de iniciar una extracción. El login interactivo por sí solo no habilita la automatización. |
| OpenCode | Servidor local oficial `opencode serve`, API de sesiones y variantes | Usa las conexiones configuradas por el usuario. Que un proveedor aparezca conectado no acredita permiso para usar una suscripción mediante plugins de terceros; deben usarse conexiones autorizadas por ese proveedor. |

Agent Hub no distribuye ni modifica estos binarios. No extrae tokens de sesión, falsifica identidad de clientes, rota cuentas ni sustituye proveedores para sortear rechazos o cuotas. No se añaden APIs privadas de inferencia. Las tareas requieren habilitar procesamiento remoto y respetan las exclusiones por fuente o proyecto.

Los rechazos de autenticación detienen la tarea. Los límites y fallos temporales se manejan mediante reintentos limitados con espera; no se crean cuentas ni credenciales alternativas. Las pruebas usan contenido sintético y también consumen cuota.

El esfuerzo se pasa mediante opciones nativas: `--effort` en Claude Code y Kiro, `model_reasoning_effort` en Codex y `variant` en OpenCode. Se rechazan niveles que no estén en el catálogo admitido. El catálogo de Kiro actualmente omite los niveles; se utiliza una lista explícita de modelos documentados, sin asumir compatibilidad en modelos desconocidos. Las políticas de la organización y los límites del proveedor siguen teniendo precedencia.

## Referencias oficiales

- [Claude Code: ejecución programática](https://code.claude.com/docs/en/headless), [condiciones para integrarlo en productos](https://code.claude.com/docs/en/legal-and-compliance) y [esfuerzo por modelo](https://code.claude.com/docs/en/model-config).
- [Codex: ejecución no interactiva y autenticación](https://learn.chatgpt.com/docs/non-interactive-mode) y [configuración](https://learn.chatgpt.com/docs/config-file/config-reference).
- [Kiro: autenticación headless](https://kiro.dev/docs/cli/headless/) y [esfuerzo de razonamiento](https://kiro.dev/docs/models/effort/).
- [OpenCode: servidor local](https://opencode.ai/docs/server/) y [modelos y variantes](https://opencode.ai/docs/models/).
