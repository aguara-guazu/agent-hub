import { EMBEDDING_REPOSITORY, EMBEDDING_REVISION, NATIVE_EMBEDDING_MODEL } from '../embedding-model.js'

export type InferenceProfile = 'text' | 'vision' | 'audio' | 'speech' | 'speech_small'
export const WHISPER_REPOSITORY = 'onnx-community/whisper-base'
export const WHISPER_REVISION = '1846881b6b3a3024392c1eea3ad983695bc23925'
/** Larger Whisper used for recorded meetings, where conversational speech makes the base model miss too many words. */
export const WHISPER_SMALL_REPOSITORY = 'onnx-community/whisper-small'
export const WHISPER_SMALL_REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732'
const WHISPER_FILES = ['config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx']
export const isSpeechProfile = (profile: InferenceProfile): profile is 'speech' | 'speech_small' => profile === 'speech' || profile === 'speech_small'
export function modelProfile(profile: InferenceProfile) {
  if (profile === 'speech') return { id: 'whisper-base-q8-v1', repository: WHISPER_REPOSITORY, revision: WHISPER_REVISION, files: WHISPER_FILES }
  if (profile === 'speech_small') return { id: 'whisper-small-q8-v1', repository: WHISPER_SMALL_REPOSITORY, revision: WHISPER_SMALL_REVISION, files: WHISPER_FILES }
  return { id: NATIVE_EMBEDDING_MODEL, repository: EMBEDDING_REPOSITORY, revision: EMBEDDING_REVISION,
    files: ['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx','onnx/model_quantized.onnx_data',
      ...(profile === 'text' ? [] : ['processor_config.json',`onnx/${profile}_encoder_quantized.onnx`,`onnx/${profile}_encoder_quantized.onnx_data`])] }
}
export type MediaEmbedding = { kind: 'image'; image: Uint8Array } | { kind: 'audio'; audio: Float32Array }
  | { kind: 'video'; frames: Uint8Array[]; duration: number }
export type SpeechResult = { text: string; chunks: { text: string; timestamp: [number, number | null] }[] }
