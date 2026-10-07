# Agent Hub 0.7.2

Esta versión convierte el Hub en una **memoria principal proactiva, con archivos, embeddings integrados y mantenimiento en segundo plano**, junto con mejoras de configuración de las CLI.

- **EmbeddingGemma 2 local**: descargá una vez el modelo de texto (unos 350 MB) desde Ajustes. Genera embeddings sin Ollama, sin API key y sin enviar consultas ni documentos. Descarga con progreso, cancelación y reintento; libera la memoria tras un minuto sin uso.
- **Regenerar embeddings** reconstruye el índice en segundo plano con el modelo elegido, conservando originales, transcripciones y extracciones. Los modelos mantienen índices separados.
- **Archivos en la memoria**: capturas, imágenes, audio, video, PDF y otros adjuntos de hasta 25 MB, desde la interfaz o `memory_import_file`. Se conservan versiones, originales y respaldos, con anotaciones de timestamps, páginas o regiones. `memory_get_file` puede devolver imágenes y audio directamente por MCP (hasta 5 MB; depende del cliente).
- **Memoria principal y proactiva**: la skill prioriza el Hub, enseña a guardar recuerdos duraderos con `memory_remember`, conservar archivos relevantes y dejar notas para otros agentes. Los recuerdos se pueden corregir con control de versión, fijar, archivar y restaurar.
- **Organizar la memoria**: un trigger para el worker revisa vigencias explícitas, archiva duplicados exactos, detecta recuerdos relacionados con embeddings y retira vectores históricos regenerables. Conserva originales, evidencia e historial; la similitud no borra recuerdos automáticamente.
- La búsqueda de adjuntos utiliza el contenido de archivos de texto UTF-8 de hasta 5 MB; para adjuntos binarios, título, descripción y anotaciones. No se agrega OCR, transcripción automática ni embeddings de contenido audiovisual en esta versión.

[Embeddings locales](https://github.com/aguara-guazu/agent-hub/blob/v0.7.2/docs/native-embeddings.md) · [Archivos para agentes](https://github.com/aguara-guazu/agent-hub/blob/v0.7.2/docs/memory-files.md) · [Recuerdos y mantenimiento](https://github.com/aguara-guazu/agent-hub/blob/v0.7.2/docs/memory-maintenance.md).

También podés configurar la **API key de Kiro directamente en Agent Hub**, desde **Memoria → Fuentes y ajustes**, al seleccionar **Kiro CLI en segundo plano**.

- Campo oculto para guardar o reemplazar la clave y opción de quitar la copia local.
- Guía breve que indica dónde obtenerla mientras falta configurar el acceso. Al guardar la clave, la guía se oculta y queda disponible para volver a consultarla.
- Capturas de referencia y explicación para cuentas cuya organización tenga deshabilitada la creación de API keys.
- El worker usa la clave guardada sin reiniciar el Hub. La clave se entrega sólo al proceso Kiro y nunca se devuelve en las consultas de configuración.
- Se conserva **Probar modelo** para comprobar el acceso antes de habilitar el procesamiento.
- **Guardar** reemplaza a **Actualizar modelos** junto al selector: guarda la configuración elegida y queda grisado mientras no haya cambios. Un error permite reintentar sin perder la selección.

No hace falta configurar variables de entorno. Kiro sigue requiriendo una API key autorizada para automatización; si tu organización la tiene deshabilitada, pedí su habilitación al administrador.

[Guía de configuración con capturas](https://github.com/aguara-guazu/agent-hub/blob/v0.7.2/docs/kiro-api-key.md).
