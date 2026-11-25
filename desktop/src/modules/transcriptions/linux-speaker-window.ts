import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const script = fileURLToPath(new URL("../../x11-speaker-window.py", import.meta.url))
const x11 = () => process.platform === "linux" && process.env.DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland" && !process.env.WAYLAND_DISPLAY
const xid = (id: string) => /^window:(\d+):\d+$/.exec(id)?.[1]

export async function x11WindowTitles(ids: string[], signal: AbortSignal): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (!x11()) return names
  const windows = ids.flatMap(id => xid(id) ?? []).slice(0, 256)
  if (!windows.length) return names
  try {
    const { stdout } = await run("python3", ["-I", script, "--titles", ...windows], { timeout: 1500, maxBuffer: 1_000_000, signal })
    const titles = JSON.parse(stdout)
    for (const id of ids) {
      const name = titles[xid(id) ?? ""]
      if (typeof name === "string" && name.trim()) names.set(id, name.trim())
    }
  } catch { /* Fall back to Electron's titles if the window manager or helper is unavailable. */ }
  return names
}

/** Electron 44's ARM video conversion can execute SVE instructions on an SME-only CPU, killing the recorder. */
export function needsStillCapture(): boolean {
  if (process.platform !== "linux" || process.arch !== "arm64") return false
  try {
    return readFileSync("/proc/cpuinfo", "utf8").split("\n").some(line => /^Features\s*:/.test(line) && /\bsme\b/.test(line) && !/\bsve\b/.test(line))
  } catch { return false }
}

export async function captureX11Window(id: string, signal: AbortSignal) {
  const window = xid(id)
  if (!window || !x11()) throw new Error("X11 window unavailable")
  const { stdout } = await run("python3", ["-I", script, window], { encoding: "buffer", timeout: 3500, maxBuffer: 12_000_000, signal })
  return stdout
}
