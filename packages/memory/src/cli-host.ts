/** The control pipe ties the CLI process tree to the worker, even if the worker crashes. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const executable = process.argv[2]!
const isScript = /\.(?:m?js|cjs)$/.test(executable)
const child = spawn(isScript ? process.execPath : executable,
  isScript ? process.argv.slice(2) : process.argv.slice(3), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  })
child.stdout!.pipe(process.stdout)
child.stderr!.pipe(process.stderr)
child.stdin!.on('error', () => undefined)
let stopping = false
function kill(signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill(signal))
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
child.once('exit', () => kill('SIGKILL'))
child.once('close', code => {
  input.close(); process.stdin.destroy()
  // Drain the forwarded output before exiting, including large extraction responses.
  process.stdout.end(() => process.stderr.end(() => process.exit(code ?? 1)))
})
