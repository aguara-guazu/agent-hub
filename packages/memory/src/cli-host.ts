/** The control pipe ties the CLI process tree to the worker, even if the worker crashes. */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { childEnv, killTree } from '@agenthub/gateway/platform'

const windows = process.platform === 'win32'
const executable = process.argv[2]!
const isScript = /\.(?:m?js|cjs)$/.test(executable)
// Scripts run on process.execPath and need ELECTRON_RUN_AS_NODE; a native CLI would pass it on to any Electron app it opens.
const child = spawn(isScript ? process.execPath : executable,
  isScript ? process.argv.slice(2) : process.argv.slice(3), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !windows, env: isScript ? process.env : childEnv(),
  })
// Windows locks a process's current directory: the run folder stays removable while this host (or a taskkill it starts) lives.
if (windows) try { process.chdir(tmpdir()) } catch { /* keep the inherited cwd */ }
child.stdout!.pipe(process.stdout)
child.stderr!.pipe(process.stderr)
child.stdin!.on('error', () => undefined)
let stopping = false
function kill(signal: NodeJS.Signals) {
  if (windows) return killTree(child, signal)
  try {
    if (child.pid) process.kill(-child.pid, signal)
  } catch { /* already stopped */ }
}
function stop() {
  if (stopping) return
  stopping = true
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), 1000).unref()
}
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  try {
    const message = JSON.parse(line) as { stdin: string; end?: boolean }
    if (message.end) child.stdin!.end(message.stdin)
    else child.stdin!.write(message.stdin)
  } catch { stop() }
})
input.once('close', stop)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
process.stdout.on('error', stop)
process.stderr.on('error', stop)
child.once('error', () => process.exit(1))
// The process group outlives its leader on POSIX. taskkill /T cannot find the children of an exited PID on Windows.
child.once('exit', () => { if (!windows) kill('SIGKILL') })
child.once('close', code => {
  input.close(); process.stdin.destroy()
  // Drain the forwarded output before exiting, including large extraction responses.
  process.stdout.end(() => process.stderr.end(() => process.exit(code ?? 1)))
})
