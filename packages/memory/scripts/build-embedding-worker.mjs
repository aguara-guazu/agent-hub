import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const transformers = resolve(dirname(require.resolve('@huggingface/transformers')), '../src/transformers.js')
await build({ entryPoints: [resolve(root, 'src/embedding-worker.ts')], outfile: resolve(root, 'dist/embedding-worker.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', legalComments: 'eof',
  plugins: [{ name: 'local-onnx', setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: transformers }))
    build.onResolve({ filter: /\/onnx-node\.js$/ }, () => ({ path: resolve(root, 'scripts/onnx-local.mjs') }))
    // 4.3.1 discovers tokenizer filenames over HTTP even with local_files_only. Our pinned model has two known files.
    build.onResolve({ filter: /\/get_tokenizer_files\.js$/ }, () => ({ path: 'tokenizer-files', namespace: 'pinned-model' }))
    build.onLoad({ filter: /.*/, namespace: 'pinned-model' }, () => ({ contents: 'export async function get_tokenizer_files() { return ["tokenizer.json", "tokenizer_config.json"] }', loader: 'js' }))
  } }],
})
