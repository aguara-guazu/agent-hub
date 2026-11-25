import { fork } from "node:child_process"
import { MemoryError } from "./contracts.js"

/** A fatal error inside a native audio model must not take the memory worker or its other jobs down. */
export function runAudioAnalysis<T>(script: URL, task: object, label: string, timeoutMs: number, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = fork(script, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      settle()
    }
    const fail = (message: string) => finish(() => reject(new MemoryError(422, `${label}: ${message}`)))
    const abort = () => finish(() => reject(new MemoryError(499, `${label}: cancelado`)))
    const timer = setTimeout(() => fail("se agotó el tiempo de espera"), timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    child.once("message", (message: { result: T } | { error: string }) => {
      if ("error" in message) fail(message.error)
      else finish(() => resolve(message.result))
    })
    child.once("error", error => fail(error.message))
    child.once("exit", (code, reason) => fail(`el proceso se cerró (${reason ?? code})`))
    child.send(task, error => { if (error) fail(error.message) })
  })
}
