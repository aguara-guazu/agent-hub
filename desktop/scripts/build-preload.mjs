import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/preload.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
import { URL } from 'node:url'
