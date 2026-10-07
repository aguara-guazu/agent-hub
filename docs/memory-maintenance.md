# Recuerdos duraderos y mantenimiento

Agent Hub puede ser la memoria principal compartida de los agentes. La skill distribuida con el Hub enseña a consultarlo antes de otras soluciones de memoria, guardar información reutilizable de forma proactiva dentro de la tarea autorizada y dejar notas de coordinación para otras sesiones. Las instrucciones explícitas de la persona y del proyecto siguen teniendo prioridad.

No se copian automáticamente conversaciones completas, secretos ni otras memorias instaladas. Si personalizaste la skill local, el Hub conserva tus cambios; comparala con la versión de fábrica para incorporar estas instrucciones.

## Recordar y corregir

`memory_remember` guarda una idea reutilizable con una clave estable por proyecto:

```json
{
  "key": "release-validation",
  "title": "Validación antes de publicar",
  "text": "Ejecutar las pruebas del proyecto y comprobar los instaladores antes de publicar la versión.",
  "category": "procedure",
  "confidence": "confirmed",
  "importance": 4,
  "tags": ["release", "validation"]
}
```

Las categorías son `preference`, `decision`, `lesson`, `procedure` y `context`. Agregá `project_id` para acotar el recuerdo, `evidence_ids` cuando haya fragmentos que lo respalden y `expires_at` sólo si conocés su fecha de vencimiento. La confianza (`observed`, `confirmed`, `inferred`) debe reflejar la evidencia disponible, no la seguridad aparente del agente.

Repetir la misma clave y contenido no duplica el recuerdo. Para corregirlo, leé la entidad y enviá `expected_updated_at` junto con la misma clave: se conserva una nueva versión sin perder las citas anteriores. Un conflicto pide volver a leer antes de escribir. Los recuerdos no habilitan procesamiento remoto por defecto.

`memory_context` incorpora hasta ocho recuerdos generales o del proyecto y un resumen del mantenimiento pendiente. `memory_list_memories` permite explorar activos y archivados; las búsquedas habituales también encuentran los recuerdos activos por texto y significado.

Los [archivos originales](memory-files.md) respaldan la información. Las notas de trabajo (`memory_write_note` y `memory_finish_notes`) comunican a otros agentes qué se está haciendo; los aprendizajes que deban durar se guardan por separado como recuerdos.

## Organizar la biblioteca

`memory_tidy_memory` encola una revisión local del worker; también existe **Organizar la memoria** en Ajustes. Acepta un proyecto y un motivo. Se evita repetir una revisión dentro de 24 horas, salvo que se solicite `force: true`. Un pedido ya en curso devuelve el mismo trabajo.

En cada revisión:

- Recorre hasta 500 recuerdos, comenzando por los menos recientemente revisados.
- Archiva recuerdos con fecha de vigencia vencida y duplicados exactamente iguales dentro del mismo ámbito, categoría y confianza. Los fijados se conservan.
- Conserva evidencia del duplicado, versiones, originales y el motivo de cada cambio. Archivar retira de la búsqueda habitual, sin borrar las citas.
- Compara hasta 200 recuerdos ya indexados con el modelo configurado y devuelve hasta 30 pares relacionados para revisar. La similitud no confirma un duplicado ni resuelve contradicciones.
- Retira embeddings de versiones históricas que ya no participan en la búsqueda actual; su texto y evidencia permanecen intactos y sus vectores se pueden regenerar.

No necesita un proveedor remoto ni otra instalación. La organización por significado aprovecha los embeddings existentes de EmbeddingGemma 2 u Ollama; si falta el índice, se realiza el mantenimiento restante. El worker no hace OCR, transcripción ni una revisión factual automática de todo el contenido.

`memory_health` devuelve el último informe, los pares relacionados y si corresponde otra revisión. `memory_list_jobs` permite seguir progreso, cancelar o reintentar. El agente debe leer los recuerdos y su evidencia antes de corregirlos, relacionarlos o consolidarlos; una contradicción sin resolver debe conservarse.

## Archivar, fijar y restaurar

`memory_manage_memory` admite `archive`, `restore`, `pin` y `unpin`, con motivo y `expected_updated_at`. Para consolidar, `duplicate_of` referencia un recuerdo activo del mismo ámbito. También hay controles en la ficha del recuerdo.

Restaurar fija el recuerdo para evitar que la próxima revisión lo archive nuevamente. El borrado permanente de originales sigue siendo una acción explícita separada; el mantenimiento no lo ejecuta por inferencia. Los respaldos conservan recuerdos, archivos, versiones e historial de cambios.
