#!/usr/bin/env node
const marker = process.argv.indexOf('--agenthub-headless')

if (marker >= 0) {
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE && process.platform === 'darwin') {
    // Una configuración vieja lanza el puente como app Electron gráfica. Que al menos no
    // ocupe el Dock; la configuración actual lo lanza con ELECTRON_RUN_AS_NODE=1.
    const { app } = await import('electron')
    app.dock?.hide()
  }
  const { main } = await import('@agenthub/daemon/cli')
  const code = await main(process.argv.slice(marker + 1))
  // El runtime Electron mantiene un loop nativo aun cuando el CLI ya terminó.
  // Una salida explícita evita dejar colgados comandos finitos como `status`.
  process.exit(code)
} else {
  await import('./main.js')
}
