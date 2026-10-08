import { Worker } from 'node:worker_threads'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'

// No model download: verify the exact packaged worker and all of its runtime dependencies.
const path = process.argv[2] ?? 'packages/memory/dist/embedding-worker.js'
for (const forceWasm of [false, true]) await new Promise((resolveCheck, reject) => {
  const worker = new Worker(pathToFileURL(resolve(path)), { workerData: { checkRuntime: true, install: false, forceWasm } })
  const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('Embedding runtime startup timed out')) }, 20_000)
  worker.once('error', error => { clearTimeout(timeout); reject(error) })
  worker.once('message', async message => {
    clearTimeout(timeout); await worker.terminate()
    if (message.type !== 'runtime-ready') reject(new Error('Unexpected embedding runtime response'))
    else { console.log(`Embedding runtime ready (${forceWasm ? 'WASM' : 'platform default'})`); resolveCheck() }
  })
})

// The bundled PDF reader must initialize offline with its packaged WASM and Sharp.
await new Promise((resolveCheck, reject) => {
  const worker = new Worker(pathToFileURL(join(dirname(resolve(path)), 'pdf-worker.js')), { workerData: { checkRuntime: true } })
  const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('PDF runtime startup timed out')) }, 20_000)
  worker.once('error', error => { clearTimeout(timeout); reject(error) })
  worker.once('message', async message => {
    clearTimeout(timeout); await worker.terminate()
    if (message.type !== 'runtime-ready') reject(new Error('Bundled PDF runtime failed to initialize'))
    else { console.log('PDF runtime ready (bundled WASM)'); resolveCheck() }
  })
})
