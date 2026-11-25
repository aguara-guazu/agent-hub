import type { RecordingTrack } from "./recording.js"

/**
 * Contrato entre el proceso principal y la ventana oculta de captura. Es independiente del de la consola
 * (`ipc.ts`): la ventana de captura vive en su propia sesión y sólo conoce estos canales.
 */
export const RECORDER_IPC = {
  /** send: página -> main, la página cargó y espera órdenes. */
  ready: "agenthub-recorder:ready",
  /** send: main -> página, `start` o `stop`. */
  command: "agenthub-recorder:command",
  /** send: página -> main, una pista abrió su dispositivo; lleva la hora de reloj del inicio. */
  trackStarted: "agenthub-recorder:track-started",
  /** send: página -> main, una pista no pudo abrirse o se cortó. */
  trackFailed: "agenthub-recorder:track-failed",
  /** send: página -> main, tramo WebM de una pista. */
  chunk: "agenthub-recorder:chunk",
  /** send: página -> main, nivel RMS máximo de cada pista en el último intervalo. */
  levels: "agenthub-recorder:levels",
  /** send: página -> main, todas las pistas entregaron su último tramo. */
  stopped: "agenthub-recorder:stopped",
  regionDone: "agenthub-recorder:region-done",
  visualFailed: "agenthub-recorder:visual-failed",
  speakerFrame: "agenthub-recorder:speaker-frame",
  speakerStill: "agenthub-recorder:speaker-still",
  tabLevel: "agenthub-recorder:tab-level",
  monitor: "agenthub-recorder:monitor",
  startMonitor: "agenthub-recorder:start-monitor",
  stopMonitor: "agenthub-recorder:stop-monitor",
} as const

export type RecorderCommand = "start" | "stop" | "stop-window" | "start-tab"
export type RecorderLevels = Partial<Record<RecordingTrack, number>>

/** Superficie que el preload publica en `window.recorderBridge`. */
export interface RecorderBridge {
  regionDone(): void
  tabLevel(level: number): void
  visualFailed(): void
  linuxMonitor: boolean
  startMonitor(): void
  stopMonitor(): void
  onMonitor(listener: (samples: Uint8Array | null) => void): () => void
  speakerFrame(at: number, tile: boolean, image: ArrayBuffer): Promise<void>
  speakerStill(): Promise<Uint8Array<ArrayBuffer> | null>
  ready(): void
  onCommand(listener: (command: RecorderCommand) => void): void
  trackStarted(track: RecordingTrack, epochMs: number): void
  trackFailed(track: RecordingTrack, message: string): void
  chunk(track: RecordingTrack, data: ArrayBuffer): void
  levels(levels: RecorderLevels): void
  stopped(): void
}
