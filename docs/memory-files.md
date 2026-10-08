# Archivos como memoria para agentes

La memoria puede conservar un archivo importante junto con su contexto: capturas, imágenes, audio, video, PDF y otros formatos. El límite es 25 MB por archivo. Los originales se guardan localmente, tienen hash SHA-256, conservan versiones y forman parte de los respaldos.

Desde **Importar fuente**, seleccioná el archivo, escribí un título y una descripción útil para buscarlo después, y asociá el proyecto. En la fuente guardada podés abrir imágenes, reproducir audio/video si el formato es compatible con el navegador y descargar el original.

Para preferencias, decisiones, aprendizajes y procedimientos, usá [recuerdos duraderos y mantenimiento](memory-maintenance.md). El archivo puede ser la evidencia que los respalda.

## Guardar desde un agente

Usá `memory_import_file` con una ruta absoluta en la computadora del Hub:

```json
{
  "path": "/ruta/absoluta/captura.png",
  "title": "Error al confirmar el pago",
  "description": "La aplicación muestra un error después de enviar el formulario de pago.",
  "external_id": "evidencia:pago-error",
  "annotations": [
    {
      "text": "El aviso de error aparece en el panel derecho",
      "region": { "x": 0.6, "y": 0.1, "width": 0.3, "height": 0.2 }
    }
  ]
}
```

También acepta `filename` y `data_base64` en lugar de `path`. No envíes ambos. Agregá `project_ids` cuando conozcas el proyecto y `occurred_at` si conocés la fecha del archivo. Una ruta del agente remoto no existe necesariamente en la computadora del Hub: en ese caso enviá el contenido. Conservá sólo archivos pertinentes para la tarea autorizada, sin secretos ni material ajeno.

Reutilizá `external_id` para guardar una versión nueva del mismo origen. Si no lo indicás, el hash del archivo evita duplicar el mismo contenido. El mismo nombre de archivo no confunde dos originales diferentes.

## Timestamps, páginas y capturas

Las anotaciones admiten `offset_ms` y `end_offset_ms` para un momento de audio/video, `page` para una página y `region` con coordenadas normalizadas entre 0 y 1 para una zona de una captura. Por ejemplo:

```json
{
  "text": "Se acuerda revisar la propuesta el viernes",
  "offset_ms": 12500,
  "end_offset_ms": 18000
}
```

Las anotaciones manuales deben provenir de evidencia conocida. El procesamiento local también puede producir timestamps de transcripción y fotogramas, y regiones de OCR; se distinguen como contenido generado pendiente de revisión. La interfaz puede abrir una cita y ubicar la reproducción en su `offset_ms`.

## Recuperar el original

`memory_search` devuelve las anotaciones con la referencia al adjunto, su versión y ubicación. Abrí el contexto con `memory_get_evidence`. Después, `memory_get_file` con `version_id` entrega metadatos y el enlace del original; con `include_content: true` devuelve el contenido hasta 5 MB, como imagen/audio MCP o recurso binario para otros formatos. El cliente del agente debe soportar ese tipo de contenido. Para archivos mayores, entregá el enlace de la fuente en el Hub para abrir y descargar el original.

Los archivos TXT, Markdown, CSV, JSON, YAML, LOG, VTT y SRT en UTF-8 de hasta 5 MB también indexan su contenido textual. Los adjuntos binarios se buscan por título, descripción y anotaciones. Con los [módulos multimedia locales](media-processing.md) habilitados también se indexan OCR, transcripciones y contenido visual/sonoro de imágenes, audio y video. PDF y otros binarios se conservan, pero todavía no tienen extracción automática. Una anotación de un agente se conserva como contexto aportado, no como texto verificado del original. Los adjuntos nacen con procesamiento remoto desactivado.
