import { build } from 'esbuild'
import { copyFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const source = name => fileURLToPath(new URL(`../src/${name}`, import.meta.url))
const output = name => fileURLToPath(new URL(`../dist/${name}`, import.meta.url))
copyFileSync(fileURLToPath(new URL('./x11-speaker-window.py', import.meta.url)), output('x11-speaker-window.py'))

for (const [entry, outfile] of [['preload.ts', 'preload.cjs'], ['modules/transcriptions/recorder-preload.ts', 'recorder-preload.cjs'], ['modules/transcriptions/calendar-end-preload.ts', 'calendar-end-preload.cjs']]) {
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
for (const [entry, outfile] of [['modules/transcriptions/recorder-page.ts', 'recorder.js'], ['modules/transcriptions/speaker-tab-page.ts', 'speaker-tab.js']]) {
  await build({ entryPoints: [source(entry)], outfile: output(outfile), bundle: true, platform: 'browser', format: 'iife', target: 'es2022' })
}
writeFileSync(output('recorder.html'), [
  '<!doctype html>',
  '<html><head><meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self' blob: mediastream:">`,
  '<style>body{margin:12px;background:#202126;color:white;font:16px system-ui}canvas{display:block;max-width:100%;max-height:calc(100vh - 80px);cursor:crosshair;touch-action:none}</style>',
  '<title>Agent Hub Recorder</title></head>',
  '<body><script src="recorder.js"></script></body></html>',
  '',
].join('\n'))
