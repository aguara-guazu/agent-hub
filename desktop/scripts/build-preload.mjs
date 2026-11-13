import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const source = name => fileURLToPath(new URL(`../src/${name}`, import.meta.url))
const output = name => fileURLToPath(new URL(`../dist/${name}`, import.meta.url))

for (const [entry, outfile] of [['preload.ts', 'preload.cjs'], ['recorder-preload.ts', 'recorder-preload.cjs']]) {
  await build({
    entryPoints: [source(entry)],
    outfile: output(outfile),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
}

// Página de la ventana oculta de captura: script de navegador sin módulos, cargado desde un archivo local.
await build({
  entryPoints: [source('recorder-page.ts')],
  outfile: output('recorder.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
})
writeFileSync(output('recorder.html'), [
  '<!doctype html>',
  '<html><head><meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; media-src 'self' blob: mediastream:">`,
  '<title>Agent Hub Recorder</title></head>',
  '<body><script src="recorder.js"></script></body></html>',
  '',
].join('\n'))
