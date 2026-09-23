/** Keeps the headless server tied to the worker, including when the worker crashes. */
import { spawn } from 'node:child_process'

const child = spawn(process.argv[2]!, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  detached: process.platform !== 'win32',
})
child.stdout!.pipe(process.stdout)
let stopping = false
function kill(signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
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
