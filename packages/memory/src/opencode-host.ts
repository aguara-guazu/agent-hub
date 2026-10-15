/** Keeps the headless server tied to the worker, including when the worker crashes. */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { childEnv, killTree } from '@agenthub/gateway/platform'

const windows = process.platform === 'win32'
// ELECTRON_RUN_AS_NODE is only for this host: an Electron app opened by OpenCode would otherwise start as plain Node.
const child = spawn(process.argv[2]!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: childEnv(),
  detached: !windows,
})
// Windows locks a process's current directory: the run folder stays removable while this host (or a taskkill it starts) lives.
if (windows) try { process.chdir(tmpdir()) } catch { /* keep the inherited cwd */ }
child.stdout!.pipe(process.stdout)
let stopping = false
function kill(signal: NodeJS.Signals) {
  if (windows) return killTree(child, signal)
  try {
    if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch { /* already stopped */ }
}
function stop() {
  if (stopping) return
  stopping = true
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), 1000).unref()
}
process.stdin.resume()
process.stdin.once('end', stop)
process.stdin.once('close', stop)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
process.stdout.on('error', stop)
child.once('error', () => process.exit(1))
child.once('exit', code => { kill('SIGKILL'); process.exit(code ?? 0) })
