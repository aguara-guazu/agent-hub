# EmbeddingGemma 2 dentro de Agent Hub

En **Memoria → Fuentes y ajustes → Motor de embeddings**, seleccioná **EmbeddingGemma 2 integrado** y pulsá **Descargar modelo**. La descarga de texto ocupa aproximadamente 350 MB. Cuando diga **Listo para usar**, activá **Habilitar embeddings locales** y guardá.

El Hub genera los vectores localmente y reconstruye el índice en segundo plano. No requiere Ollama, Python, un servidor de inferencia, una cuenta ni API key. La primera descarga necesita acceso a Hugging Face y sus servidores de archivos; las consultas posteriores funcionan sin conexión. Los textos y consultas no forman parte de la descarga.

La descarga muestra progreso por archivo, permite cancelar y reintentar, y sólo informa que está lista después de probar el modelo. Si no avanza durante 90 segundos, informa un error; el límite total es de 60 minutos. Los pesos parciales se reanudan al reintentar y se verifican por tamaño y SHA-256 antes de cargarlos. Los pesos quedan en `memory/models/embeddinggemma-2-native-q8-v1` dentro del directorio de memoria del Hub, separados de los originales y de los respaldos.

## Regenerar un índice anterior

Guardá el modelo elegido y pulsá **Regenerar embeddings**. El botón programa los fragmentos y las entidades para reconstruir sus vectores, sin volver a pedir resúmenes ni extracción a las CLI. Con Gemma 2 también vuelve a analizar los archivos actuales si hay encoders visuales o sonoros habilitados. Los originales, las citas y las propuestas existentes se conservan. Revisá **Ver progreso del índice**; desde allí podés cancelar o reintentar trabajos.

El cambio de modelo también detecta automáticamente el material pendiente. Los vectores de modelos diferentes no se comparan entre sí. Durante la reconstrucción, la búsqueda textual sigue disponible y los resultados semánticos se completan gradualmente. No es necesario convertir ni borrar los embeddings viejos para actualizar.

## Motor incluido

- Modelo: [EmbeddingGemma 2 de Google](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2), lanzado el 6 de octubre de 2026, licencia Apache 2.0.
- Conversión: [onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), revisión fija `daa72c51243991dfcaf9f9137d2c573d8f7790c0`.
- Codificador de texto y encoders opcionales de imagen/video y audio, cuantización Q8, 768 dimensiones normalizadas. Consultas y documentos usan los prefijos de búsqueda indicados por el modelo. Se rechaza texto que supere los 8192 tokens; no se trunca evidencia silenciosamente.
- Transformers.js 4.3.1 y ONNX Runtime incluidos en la app. CPU en un worker independiente, dos hilos de cálculo; en Mac Intel se usa el motor CPU WebAssembly incluido, sin descargar código al ejecutar.
- Carga bajo demanda y liberación tras un minuto sin actividad. RAM y latencia dependen del equipo y de la longitud del texto; la descarga en disco no representa el consumo total de memoria.

Los [módulos multimedia](media-processing.md) amplían la búsqueda con los encoders visual y sonoro del mismo modelo, en un espacio compartido de 768 dimensiones. Se descargan y activan por separado. Los [adjuntos](memory-files.md), sus versiones y citas permanecen disponibles aunque se desactive un módulo. Los vectores de imagen, video y audio conservan su modalidad al regenerar el índice; nunca se sustituyen por el embedding del texto descriptivo.
