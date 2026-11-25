import type { RecorderBridge } from "./recorder-ipc.js"

/** Feed the default output monitor into the same Opus recorder without playing it through the speakers. */
export function monitorStream(context: AudioContext, bridge: RecorderBridge): Promise<MediaStream> {
  const destination = context.createMediaStreamDestination()
  let next = 0, odd: number | undefined
  return new Promise((resolve, reject) => {
    const unsubscribe = bridge.onMonitor(bytes => {
      if (!bytes) {
        unsubscribe()
        bridge.stopMonitor()
        for (const track of destination.stream.getTracks()) { track.stop(); track.dispatchEvent(new Event("ended")) }
        reject(new Error("Output monitor unavailable (parec / pw-record)"))
        return
      }
      if (context.state === "closed") return
      let data = bytes
      if (odd !== undefined) {
        data = new Uint8Array(bytes.length + 1)
        data[0] = odd
        data.set(bytes, 1)
      }
      odd = data.length % 2 ? data[data.length - 1] : undefined
      const n = Math.floor(data.length / 2)
      if (!n) return
      const buffer = context.createBuffer(1, n, 16000), samples = buffer.getChannelData(0)
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(2 * i, true) / 32768
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(destination)
      next = Math.max(context.currentTime + 0.015, next)
      node.start(next); next += buffer.duration
      resolve(destination.stream)
    })
    // A suspended output may deliver its first sample minutes later. Its timestamp anchors the system track.
    bridge.startMonitor()
  })
}
