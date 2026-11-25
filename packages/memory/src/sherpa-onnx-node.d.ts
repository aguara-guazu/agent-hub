/** Minimal surface of sherpa-onnx-node used by the diarization worker; the package ships no type declarations. */
declare module "sherpa-onnx-node" {
  export class Vad {
    constructor(config: { sileroVad: { model: string; threshold: number; minSilenceDuration: number; minSpeechDuration: number; maxSpeechDuration: number; windowSize: number }; sampleRate: number; numThreads: number }, bufferSeconds: number)
    acceptWaveform(samples: Float32Array): void
    flush(): void
    isEmpty(): boolean
    front(enableExternalBuffer: false): { start: number; samples: Float32Array }
    pop(): void
  }
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
