# Agent Hub 0.7.1

Esta actualización incorpora la selección de esfuerzo de razonamiento para procesar reuniones y corrige el indicador de actualizaciones que permanecía en «Buscando actualizaciones» durante toda la descarga.

## Procesamiento en segundo plano

- **Esfuerzo de razonamiento** junto al modelo en **Memoria → Fuentes y ajustes**: niveles de Claude Code y Codex, niveles documentados de Kiro y variantes de OpenCode.
- **Predeterminado de la CLI** conserva el comportamiento anterior. Cambiar de modelo o proveedor reinicia el esfuerzo para evitar combinaciones incompatibles.
- **Probar modelo** y guardar verifican la combinación elegida con evidencia sintética. Las próximas tareas usan la configuración guardada.
- Las CLI se ejecutan sin modificar sus binarios ni extraer tokens de sus cuentas. Se respetan rechazos de acceso, exclusiones de procesamiento remoto y reintentos limitados.
- **Kiro requiere `KIRO_API_KEY` en el entorno de Agent Hub**, conforme a su documentación de automatización. Una sesión interactiva sin esa clave ya no inicia extracciones automáticas. Ver [condiciones de integración](https://github.com/aguara-guazu/agent-hub/blob/v0.7.1/docs/cli-automation.md).

## Actualizaciones más claras

- El menú anuncia la versión encontrada y muestra **Descargando v…**, porcentaje y MB descargados, además del estado de instalación.
- Las descargas sin datos durante 60 segundos o que superan 15 minutos terminan con un error y permiten reintentar.
- Los errores al consultar GitHub se muestran como errores, sin informar incorrectamente que la app está al día. Se rechazan y eliminan descargas incompletas.

Las instalaciones con actualizaciones automáticas detectan esta versión al arrancar, mediante **Buscar actualizaciones** o en su revisión periódica. El nuevo indicador estará disponible después de instalar 0.7.1; al descargarla desde una versión anterior todavía puede aparecer el texto anterior. Windows portable y Linux `.deb` ofrecen el enlace de descarga.
