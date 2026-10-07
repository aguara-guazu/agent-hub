import { parentPort, workerData } from 'node:worker_threads'
import { AutoConfig, AutoModel, AutoTokenizer, env } from '@huggingface/transformers'
import { EMBEDDING_REPOSITORY, EMBEDDING_REVISION, embeddingInput } from './embedding-model.js'

// Downloads are allowed only during the explicit installation action. Inference is fully offline.
env.allowRemoteModels = workerData.install === true
env.cacheDir = workerData.cache
env.useBrowserCache = false
env.useFSCache = true
let lastProgress = 0
const options = { revision: EMBEDDING_REVISION, cache_dir: workerData.cache, local_files_only: !workerData.install,
  progress_callback: (progress: any) => { if (progress.status !== 'progress' || Date.now() - lastProgress > 200) { lastProgress = Date.now(); parentPort!.postMessage({ type: 'progress', progress }) } } }
if (workerData.checkRuntime) {
  parentPort!.postMessage({ type: 'runtime-ready' })
  parentPort!.close()
} else try {
  const config: any = await AutoConfig.from_pretrained(EMBEDDING_REPOSITORY, options)
  config.vision_config = null
  config.audio_config = null
  const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_REPOSITORY, options)
  const model = await AutoModel.from_pretrained(EMBEDDING_REPOSITORY, { ...options, config, device: 'cpu', dtype: 'q8',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
  const embed = async (texts: string[], query: boolean) => {
    const vectors: number[][] = []
    // One item at a time bounds attention memory on small machines. Never silently truncate evidence.
    for (const text of texts) {
      const inputs = tokenizer(embeddingInput(text, query), { truncation: false })
      if (inputs.input_ids.dims[1]! > 8192) throw new Error('El texto supera el límite de 8192 tokens de EmbeddingGemma 2')
      const output = await model(inputs)
      try {
        const vector = (output.sentence_embedding.tolist() as number[][])[0]!
        if (vector.length !== 768 || !vector.every(Number.isFinite) || Math.abs(vector.reduce((sum, v) => sum + v * v, 0) - 1) > 0.01) throw new Error('EmbeddingGemma 2 devolvió un vector inválido')
        vectors.push(vector)
      } finally {
        for (const tensor of [...Object.values(output), ...Object.values(inputs)] as { dispose?: () => void }[]) tensor.dispose?.()
      }
    }
    return vectors
  }
  // A completed download is not considered installed until native inference succeeds.
  await embed(['Comprobación local del modelo de búsqueda.'], false)
  parentPort!.postMessage({ type: 'ready' })
  parentPort!.on('message', async ({ texts, query }) => {
    try { parentPort!.postMessage({ type: 'result', vectors: await embed(texts, query) }) }
    catch (error) { parentPort!.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'No se pudieron generar los embeddings' }) }
  })
} catch (error) {
  parentPort!.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'No se pudo cargar EmbeddingGemma 2' })
}
