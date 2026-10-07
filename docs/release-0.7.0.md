# Agent Hub 0.7.0

Las reuniones ahora pueden procesarse en segundo plano con **Claude Code, Codex o Kiro CLI**, además de OpenCode, DeepSeek por API y Ollama. Agent Hub utiliza la autenticación de la CLI instalada y consulta su catálogo de modelos para elegir desde Ajustes.

## Novedades

- Selector de asistente y modelo en **Memoria → Fuentes y ajustes → Procesamiento y búsqueda**, con opción de escribir el ID del modelo.
- **Probar modelo** verifica una extracción con contenido de ejemplo. Guardar con procesamiento remoto habilitado también comprueba el acceso antes de reemplazar la configuración anterior.
- Las transcripciones nuevas usan el asistente elegido para extraer hechos, resolver identidades, asociar proyectos y completar reglas. **Reprocesar fuentes importadas** aplica el mismo flujo al material existente.
- La vista de procesamiento identifica el proveedor y el modelo de cada trabajo.

## Cuentas y procesamiento

No hace falta copiar los tokens de la CLI a Agent Hub. El procesamiento utiliza la autenticación configurada en cada cliente y consume los límites de esa cuenta. Los modelos disponibles y el acceso no interactivo dependen de la cuenta y la versión de la CLI. Si falta acceso, el trabajo muestra el error; no cambia automáticamente de proveedor.

Las exclusiones de procesamiento remoto por fuente y proyecto se mantienen. Los procesos se ejecutan bajo demanda, con herramientas restringidas, evidencia por stdin, validación de JSON y controles de cancelación y tiempo máximo. Los embeddings siguen usando Ollama.

Kiro puede requerir una API key para determinados flujos headless; la prueba de conexión permite verificar la instalación del usuario. Se comprobó el funcionamiento con la sesión local de Kiro CLI 2.28.0. Kiro informa créditos, por lo que los contadores de tokens no reflejan su consumo.

## Validación

Se procesaron reuniones sintéticas completas con las tres CLI instaladas: Claude Code, Codex y Kiro generaron hechos con evidencia y registros de colección. Las pruebas automatizadas cubren catálogos de modelos, errores de acceso, respuestas inválidas, restricciones remotas, cancelación, limpieza de procesos, configuración y procesamiento del worker. La release ejecuta además CI en Node 22.18 y 24 antes de generar los instaladores.

Las instalaciones con actualizaciones automáticas habilitadas detectan esta versión al arrancar o en la siguiente revisión periódica. Windows portable y Linux `.deb` muestran el enlace de descarga.
