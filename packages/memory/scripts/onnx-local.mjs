import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)
process.env.ORT_DISABLE_TELEMETRY = '1'
let runtime
if ((process.platform === 'darwin' && process.arch === 'x64') || workerData?.forceWasm) {
  // Microsoft no longer ships an Intel Mac binding. Bundle the CPU WASM engine locally.
  const web = await import('onnxruntime-web')
  const dist = dirname(require.resolve('onnxruntime-web'))
  web.env.wasm.numThreads = 1
  web.env.wasm.wasmBinary = readFileSync(join(dist, 'ort-wasm-simd-threaded.wasm'))
  web.env.wasm.wasmPaths = { mjs: pathToFileURL(join(dist, 'ort-wasm-simd-threaded.mjs')).href }
  runtime = { ...web, InferenceSession: { create: (path, options) => web.InferenceSession.create(readFileSync(path), {
    ...options, executionProviders: ['wasm'], externalData: [{ path: `${basename(path)}_data`, data: readFileSync(`${path}_data`) }],
  }) } }
} else runtime = require('onnxruntime-node')
export default runtime
