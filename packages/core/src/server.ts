#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import staticPlugin from '@fastify/static'
import { buildApp } from './app.js'

const host = process.env.AGENTHUB_HUB_HOST?.trim() || '127.0.0.1'
const port = Number.parseInt(process.env.AGENTHUB_HUB_PORT || '8765', 10)
const core = buildApp()

if (core.settings.consoleDist && existsSync(core.settings.consoleDist)) {
  await core.fastify.register(staticPlugin, {
    root: resolve(core.settings.consoleDist),
    prefix: '/',
    wildcard: false,
  })
  core.fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ detail: 'ruta inexistente' })
    return reply.sendFile('index.html')
  })
}

await core.fastify.listen({ host, port })
// Un server que no conectó se vuelve a sondear solo mientras esté habilitado y configurado.
core.probeRetry.start()

let closing: Promise<void> | null = null
const shutdown = (): Promise<void> => {
  closing ??= (async () => {
    core.probeRetry.stop()
    await core.fastify.close()
    core.db.close()
  })()
  return closing
}
const exitAfterShutdown = (): void => void shutdown().then(() => process.exit(0))
process.once('SIGINT', exitAfterShutdown)
process.once('SIGTERM', exitAfterShutdown)
if (process.env.AGENTHUB_STDIN_LIFELINE === '1') {
  // La app de escritorio mantiene abierto stdin. Si muere sin poder detenernos, el EOF
  // apaga el core y libera el puerto en vez de dejar un huérfano que bloquee el
  // próximo arranque.
  process.stdin.resume()
  process.stdin.once('end', exitAfterShutdown)
  process.stdin.once('close', exitAfterShutdown)
}
