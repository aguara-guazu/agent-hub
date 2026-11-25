import { activeTile } from "./active-tile.js"
import type { RecorderBridge } from "./recorder-ipc.js"

type SpeakerFrame = HTMLVideoElement | ImageBitmap
const sizeOf = (frame: SpeakerFrame) => frame instanceof HTMLVideoElement
  ? { width: frame.videoWidth, height: frame.videoHeight } : frame

/** Shared across platforms. The main process grants video only for the window explicitly selected in the tray. */
export class SpeakerView {
  private video: HTMLVideoElement | undefined
  private still = false
  private generation = 0
  private last = 0
  private lastRead = 0
  private signature = 0
  private talking = false
  private busy = false
  private selecting = false
  private region: { x: number; y: number; w: number; h: number } | undefined
  private dismissPicker: (() => void) | undefined
  constructor(private bridge: Pick<RecorderBridge, "speakerFrame" | "speakerStill" | "visualFailed" | "regionDone">) {}

  async start(instruction?: string, still = false, tab = false): Promise<void> {
    this.stop()
    const generation = this.generation
    if (still) {
      this.still = true
      if (instruction) {
        this.selecting = true
        const frame = await this.getStill()
        try { if (generation === this.generation) this.pickRegion(frame, instruction) } finally { frame.close() }
      }
      return
    }
    const options = tab
      ? { audio: false, video: { displaySurface: "browser", frameRate: 3 }, selfBrowserSurface: "exclude", surfaceSwitching: "exclude", monitorTypeSurfaces: "exclude" }
      : { audio: false, video: { frameRate: 3 } }
    const stream = await navigator.mediaDevices.getDisplayMedia(options)
    const track = stream.getVideoTracks()[0]
    const unavailable = () => {
      const surface = track?.getSettings().displaySurface
      if (!tab) return !track || surface === "monitor"
      const info = (track as MediaStreamTrack & { getCaptureHandle?: () => { origin?: string } | null })?.getCaptureHandle?.()
      return surface !== "browser" || info?.origin === "https://meet.google.com" || /google meet|meet\.google\.com|\bmeet\s*[-–]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(track?.label ?? "")
    }
    if (unavailable()) {
      stream.getTracks().forEach(t => t.stop()); throw new Error("Unavailable capture surface")
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach(t => t.stop()); return
    }
    const video = this.video = document.createElement("video")
    video.muted = true
    video.srcObject = stream
    await video.play()
    if (generation !== this.generation) return
    if (tab) track?.addEventListener("capturehandlechange", () => {
      if (generation === this.generation && unavailable()) { this.stop(); this.bridge.visualFailed() }
    })
    stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (generation === this.generation) { this.stop(); this.bridge.visualFailed() } })
    if (instruction) this.pickRegion(video, instruction)
  }

  markRegion(instruction: string): void {
    if (this.video?.videoWidth && !this.selecting) this.pickRegion(this.video, instruction, false)
  }

  private async getStill(): Promise<ImageBitmap> {
    const pixels = await this.bridge.speakerStill()
    if (!pixels) throw new Error("Selected window unavailable")
    return createImageBitmap(new Blob([pixels], { type: "image/png" }))
  }

  private pickRegion(video: SpeakerFrame, instruction: string, stopOnCancel = true) {
    this.selecting = true
    const note = document.createElement("p"), preview = document.createElement("canvas")
    const picker = document.createElement("section")
    note.textContent = instruction
    const size = sizeOf(video)
    preview.width = size.width; preview.height = size.height
    const ctx = preview.getContext("2d")!
    ctx.drawImage(video, 0, 0)
    const frame = ctx.getImageData(0, 0, preview.width, preview.height)
    const close = () => {
      this.selecting = false; this.dismissPicker = undefined
      picker.remove(); window.removeEventListener("keydown", cancel)
      this.bridge.regionDone()
    }
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { if (stopOnCancel) this.stop(); else close() } }
    window.addEventListener("keydown", cancel)
    const point = (e: PointerEvent) => {
      const box = preview.getBoundingClientRect()
      return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) }
    }
    preview.onpointerdown = event => {
      const from = point(event)
      preview.setPointerCapture(event.pointerId)
      preview.onpointermove = moved => {
        const to = point(moved)
        ctx.putImageData(frame, 0, 0)
        ctx.lineWidth = Math.max(2, preview.width / 320)
        ctx.strokeStyle = "#2cdafa"
        ctx.strokeRect(from.x * preview.width, from.y * preview.height, (to.x - from.x) * preview.width, (to.y - from.y) * preview.height)
      }
      preview.onpointerup = end => {
        preview.onpointermove = null
        ctx.putImageData(frame, 0, 0)
        const to = point(end), w = Math.abs(to.x - from.x), h = Math.abs(to.y - from.y)
        if (w * preview.width < 16 || h * preview.height < 8 || h > 0.35) return
        this.region = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w, h }
        close()
      }
    }
    this.dismissPicker = close
    picker.append(note, preview); document.body.append(picker)
  }

  stop(): void {
    this.dismissPicker?.()
    this.selecting = false
    this.region = undefined
    this.still = false
    this.generation++
    const video = this.video
    this.video = undefined
    if (video) { (video.srcObject as MediaStream)?.getTracks().forEach(t => t.stop()); video.srcObject = null }
    this.talking = false
    this.lastRead = 0
  }

  sample(level: number): void {
    const active = level > 0.001, onset = active && !this.talking
    this.talking = active
    const video = this.video, now = Date.now()
    if (this.selecting || !active || (!this.still && !video?.videoWidth) || this.busy || now - this.last < (onset ? 150 : 900)) return
    this.last = now
    const generation = this.generation
    if (onset) this.lastRead = 0
    this.busy = true
    const sample = async () => {
      const frame = video ?? await this.getStill()
      try { if (generation === this.generation) await this.inspect(frame, now, generation) } finally { if (frame instanceof ImageBitmap) frame.close() }
    }
    void sample().catch(() => {
      if (generation === this.generation) { this.stop(); this.bridge.visualFailed() }
    }).finally(() => { this.busy = false })
  }

  private async inspect(video: SpeakerFrame, at: number, generation: number) {
    const canvas = document.createElement("canvas")
    const { width, height } = sizeOf(video)
    canvas.width = Math.min(900, width)
    const scale = width / canvas.width
    canvas.height = Math.max(1, Math.round(height / scale))
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const tile = activeTile(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    if (this.region) {
      const { x, y, w, h } = this.region
      const sourceWidth = Math.max(1, w * width), sourceHeight = Math.max(1, h * height)
      canvas.width = Math.min(900, Math.round(sourceWidth * 2))
      canvas.height = Math.min(256, Math.round(sourceHeight * 2))
      ctx.drawImage(video, x * width, y * height, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
    } else if (tile) {
      const h = Math.min(52, Math.round(tile.height / 3))
      canvas.width = Math.min(640, Math.round(tile.width * scale * 0.9))
      canvas.height = Math.ceil(h * scale)
      ctx.drawImage(video, (tile.x + 3) * scale, (tile.y + tile.height - h - 5) * scale,
        canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
    }
    // Re-read a changed label immediately; a stable one needs only a ten-second observation.
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let signature = 2166136261
    for (let index = 0; index < pixels.length; index += 16) signature = Math.imul(signature ^ (pixels[index]! >> 4), 16777619)
    if (signature === this.signature && at - this.lastRead < 10000) return
    this.signature = signature; this.lastRead = at
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"))
    if (!blob || blob.size > 3000000 || generation !== this.generation) return
    await this.bridge.speakerFrame(at, Boolean(tile || this.region), await blob.arrayBuffer())
  }
}
