/** Minimal surface of sherpa-onnx-node used by the diarization worker; the package ships no type declarations. */
declare module "sherpa-onnx-node" {
  export interface SpeakerDiarizationSegment { start: number; end: number; speaker: number }
  export class OfflineSpeakerDiarization {
    constructor(config: {
      segmentation: { pyannote: { model: string }; numThreads?: number }
      embedding: { model: string; numThreads?: number }
      clustering: { numClusters: number; threshold: number }
      minDurationOn?: number
      minDurationOff?: number
    })
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerDiarizationSegment[]
  }
  export interface SpeakerStream { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number })
    readonly dim: number
    createStream(): SpeakerStream
    isReady(stream: SpeakerStream): boolean
    /** `enableExternalBuffer` must be false under Electron, whose V8 sandbox rejects external ArrayBuffers. */
    compute(stream: SpeakerStream, enableExternalBuffer?: boolean): Float32Array
  }
}
