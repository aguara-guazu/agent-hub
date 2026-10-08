import { prepareModelFiles } from './model-download.js'
import { parentPort, workerData } from 'node:worker_threads'
import { AutoConfig, AutoModel, AutoTokenizer, AutoProcessor, RawImage, RawVideo, Tensor, matmul, WhisperForConditionalGeneration, AutomaticSpeechRecognitionPipeline, env } from '@huggingface/transformers'
import sharp from 'sharp'
import { embeddingInput } from './embedding-model.js'
import { modelProfile, type MediaEmbedding, type InferenceProfile } from './media-models.js'

const profile: InferenceProfile = workerData.profile ?? 'text', definition = modelProfile(profile)
env.allowRemoteModels = workerData.install === true
// Defense against library metadata lookups that ignore local_files_only: inference cannot make HTTP requests.
if (!workerData.install) globalThis.fetch = async () => { throw new Error('La inferencia local no tiene acceso a la red') }
env.cacheDir = workerData.cache
env.useBrowserCache = false
env.useFSCache = true
let lastProgress = 0
const options = { revision: definition.revision, cache_dir: workerData.cache, local_files_only: !workerData.install,
  progress_callback: (progress: any) => { if (progress.status === 'progress_total') return; if (progress.status !== 'progress' || Date.now() - lastProgress > 200) { lastProgress = Date.now(); parentPort!.postMessage({ type: 'progress', progress }) } } }
const session_options = { intraOpNumThreads: 2, interOpNumThreads: 1 }
const failure = (error: unknown) => parentPort!.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'No se pudo cargar el modelo local' })
async function decodeImage(data: Uint8Array) {
  const { data: pixels, info } = await sharp(Buffer.from(data), { limitInputPixels: 40_000_000 }).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  return new RawImage(new Uint8ClampedArray(pixels), info.width, info.height, info.channels)
}
if (workerData.checkRuntime) {
  // Generation (Whisper) also initializes ONNX graphs from bytes rather than file paths.
  const input = new Tensor('float32', [2], [1, 1]), output = await matmul(input, input)
  if (Number(output.data[0]) !== 4) throw new Error('El motor ONNX no pudo ejecutar una operación local')
  input.dispose(); output.dispose()
  parentPort!.postMessage({ type: 'runtime-ready' }); parentPort!.close()
} else try {
  await prepareModelFiles(workerData.cache, profile, workerData.install === true, options.progress_callback)
  if (profile === 'speech') {
    const [tokenizer, processor, model] = await Promise.all([
      AutoTokenizer.from_pretrained(definition.repository, options), AutoProcessor.from_pretrained(definition.repository, options),
      WhisperForConditionalGeneration.from_pretrained(definition.repository, { ...options, device: 'cpu', dtype: 'q8', session_options }),
    ])
    const transcriber = new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', tokenizer, processor, model })
    // Load and execute both ONNX sessions before marking the module ready.
    parentPort!.postMessage({ type: 'validating' })
    await transcriber(new Float32Array(16000), { max_new_tokens: 8, language: 'es' })
    parentPort!.postMessage({ type: 'ready' })
    parentPort!.on('message', async ({ audio, language, shutdown }) => {
      if (shutdown) { await model.dispose(); parentPort!.postMessage({ type: 'stopped' }); parentPort!.close(); return }
      try { parentPort!.postMessage({ type: 'result', result: await transcriber(audio, { language, return_timestamps: true, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 }) }) }
      catch (error) { failure(error) }
    })
  } else {
    const config: any = await AutoConfig.from_pretrained(definition.repository, options)
    if (profile !== 'vision') config.vision_config = null
    if (profile !== 'audio') config.audio_config = null
    const tokenizer = await AutoTokenizer.from_pretrained(definition.repository, options)
    const processor = profile === 'text' ? null : await AutoProcessor.from_pretrained(definition.repository, options)
    const model = await AutoModel.from_pretrained(definition.repository, { ...options, config, device: 'cpu', dtype: 'q8', session_options })
    const infer = async (inputs: any) => {
      if (inputs.input_ids.dims[1]! > 8192) throw new Error('El contenido supera el límite de 8192 tokens de EmbeddingGemma 2')
      let output: any
      try {
        output = await model(inputs)
        const vector = (output.sentence_embedding.tolist() as number[][])[0]!
        if (vector.length !== 768 || !vector.every(Number.isFinite) || Math.abs(vector.reduce((sum, v) => sum + v * v, 0) - 1) > 0.01) throw new Error('EmbeddingGemma 2 devolvió un vector inválido')
        return vector
      } finally {
        for (const tensor of [...Object.values(output ?? {}), ...Object.values(inputs)] as { dispose?: () => void }[]) tensor?.dispose?.()
      }
    }
    const embedMedia = async (media: MediaEmbedding) => {
      if (!processor) throw new Error('Falta el encoder multimedia')
      if (media.kind === 'image') return infer(await (processor as any)(null, await decodeImage(media.image)))
      if (media.kind === 'audio') return infer(await (processor as any)(null, null, media.audio))
      const frames = await Promise.all(media.frames.map(decodeImage))
      return infer(await (processor as any)(null, null, null, new RawVideo(frames, media.duration)))
    }
    const embed = async (texts: string[], query: boolean) => {
      const vectors: number[][] = []
      for (const text of texts) vectors.push(await infer(tokenizer(embeddingInput(text, query), { truncation: false })))
      return vectors
    }
    parentPort!.postMessage({ type: 'validating' })
    await embed(['Comprobación local del modelo de búsqueda.'], false)
    if (profile === 'vision') await embedMedia({ kind: 'image', image: await sharp({ create: { width: 96, height: 96, channels: 3, background: 'white' } }).png().toBuffer() })
    if (profile === 'audio') await embedMedia({ kind: 'audio', audio: new Float32Array(16000) })
    parentPort!.postMessage({ type: 'ready' })
    parentPort!.on('message', async ({ texts, query, media, shutdown }) => {
      if (shutdown) { await model.dispose(); parentPort!.postMessage({ type: 'stopped' }); parentPort!.close(); return }
      try { parentPort!.postMessage({ type: 'result', vectors: media ? [await embedMedia(media)] : await embed(texts, query) }) }
      catch (error) { failure(error) }
    })
  }
} catch (error) { failure(error) }
