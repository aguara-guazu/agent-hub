import { spawn } from "node:child_process"

/** Capture the default output without ever opening the default microphone. PipeWire also works without its Pulse server. */
export function openLinuxMonitor(pcm: (data: Uint8Array) => void, lost: () => void) {
  const commands = [
    ["parec", "--device=@DEFAULT_MONITOR@", "--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=80"],
    ["pw-record", "-P", "{ stream.capture.sink = true }", "--rate=16000", "--channels=1", "--format=s16", "-"],
  ]
  let child: ReturnType<typeof spawn> | undefined
  let stopping = false
  const open = (index: number) => {
    const command = commands[index]
    if (!command) { lost(); return }
    const process = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "ignore"] })
    child = process
    let received = false, finished = false
    process.stdout.on("data", (bytes: Uint8Array) => {
      if (!stopping && bytes.length) { received = true; pcm(bytes) }
    })
    const ended = () => {
      if (stopping || finished) return
      finished = true
      // Switching backends mid-recording would hide a discontinuity from the timeline.
      if (received) lost()
      else open(index + 1)
    }
    process.once("error", ended)
    process.once("close", ended)
  }
  open(0)
  return () => { stopping = true; child?.kill() }
}
