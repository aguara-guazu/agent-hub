import type { ModuleEnabled } from '@agenthub/shared/modules'
import { pdfPreview } from '../pdf.js'
import { readFileAttachment } from './attachments.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MemoryService } from '../service.js'
import { extractionClis, validCliModel } from '../cli-extraction.js'
import { reasoningEffortSchema } from '../reasoning.js'
import { check, id, MemoryError, parse } from '../contracts.js'
import { restoreMemory, streamBackup } from '../backup.js'
import { globalSearch } from './global-search.js'
import type { OwnerGuard } from '../http.js'

export function registerProjectRoutes(app: FastifyInstance, service: MemoryService, auth: OwnerGuard, enabled: ModuleEnabled) {
  app.post('/api/memory/search', { preHandler: auth }, async (request, reply) => {
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try { const { db, ai } = await service.get(); return await globalSearch(db, ai, request.body, controller.signal) }
    finally { reply.raw.off('close', abort) }
  })
  app.post('/api/memory/defaults/provider', { preHandler: auth }, () => service.defaults.recommendProvider())
  app.get('/api/memory/embeddings/native', { preHandler: auth }, () => service.nativeEmbeddings.status())
  app.post('/api/memory/embeddings/native/install', { preHandler: auth }, async (_request, reply) => reply.code(202).send(await service.defaults.resume()))
  app.post('/api/memory/embeddings/native/cancel', { preHandler: auth }, () => service.defaults.pause())
  app.get('/api/memory/opencode', { preHandler: auth }, () => service.openCode.status())
  app.post('/api/memory/opencode/test', { preHandler: auth }, async (request, reply) => {
    const { model, reasoning_effort } = parse(z.object({ model: z.string().min(1).max(200).regex(/^[^/\s]+\/\S+$/), reasoning_effort: reasoningEffortSchema }).strict(), request.body)
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try { return await service.openCode.test(model, controller.signal, reasoning_effort) }
    finally { reply.raw.off('close', abort) }
  })
  app.get('/api/memory/extraction-cli/:provider', { preHandler: auth }, request => {
    const { provider } = parse(z.object({ provider: z.enum(extractionClis) }), request.params)
    return service.cliExtraction.status(provider)
  })
  app.post('/api/memory/extraction-cli/:provider/test', { preHandler: auth }, async (request, reply) => {
    const { provider } = parse(z.object({ provider: z.enum(extractionClis) }), request.params)
    const { model, reasoning_effort } = parse(z.object({ model: z.string().refine(validCliModel), reasoning_effort: reasoningEffortSchema }).strict(), request.body)
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try { return await service.cliExtraction.test(provider, model, controller.signal, reasoning_effort) }
    finally { reply.raw.off('close', abort) }
  })
  app.put('/api/memory/ai', { preHandler: auth }, async (request, reply) => {
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try { return await service.saveAI(request.body, controller.signal) }
    finally { reply.raw.off('close', abort) }
  })
  app.get('/api/memory/credentials/kiro', { preHandler: auth }, (_request, reply) => {
    const stored = service.vault.has('kiro'), environment = Boolean(process.env.KIRO_API_KEY?.trim())
    return reply.header('Cache-Control', 'no-store').send({ configured: stored || environment, stored })
  })
  app.delete('/api/memory/credentials/kiro', { preHandler: auth }, (_request, reply) => {
    service.vault.delete('kiro')
    return reply.code(204).send()
  })
  for (const [key, schema] of [
    ['kiro', z.string().trim().min(1).max(4000).regex(/^[^\s\x00-\x1f\x7f]+$/)],
    ['deepseek', z.string().min(1).max(2000)],
  ] as const) {
    app.put('/api/memory/credentials/' + key, { preHandler: auth }, async request => {
      if (!enabled('memory')) throw new MemoryError(409, 'Módulo desactivado en Ajustes', false, 'module_disabled')
      service.vault.save(key, parse(z.object({ api_key: schema }).strict(), request.body))
      return { configured: true }
    })
  }
  app.get('/api/memory/backups/:id', { preHandler: auth }, async (request, reply) => {
    const backupId = parse(id, (request.params as { id: string }).id)
    const data = streamBackup((await service.get()).store, backupId)
    return reply.header('Content-Type', 'application/json').header('Content-Disposition', `attachment; filename="agenthub-memory-${backupId}.json"`).send(data)
  })
  app.post('/api/memory/restore', { preHandler: auth, bodyLimit: 128_000_000 }, async request => service.admission.track("backup", async () => restoreMemory((await service.get()).store, request.body)))
  app.get('/api/memory/files/:version/pages/:page', { preHandler: auth }, async (request, reply) => {
    const input = parse(z.object({ version: id, page: z.coerce.number().int().min(1).max(200) }), request.params)
    const file = await readFileAttachment((await service.get()).store, input.version)
    check(file.mime_type === 'application/pdf', 'El archivo no es un PDF', 422)
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try {
      const preview = await pdfPreview(file.data, input.page, controller.signal)
      return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').send(preview.data)
    } finally { reply.raw.off('close', abort) }
  })
  app.get('/api/memory/files/:version', { preHandler: auth }, async (request, reply) => {
    const file = await readFileAttachment((await service.get()).store, (request.params as { version: string }).version)
    return reply.header('Content-Type', file.mime_type).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').send(file.data)
  })
  app.get('/api/memory/originals/:version', { preHandler: auth }, async request => (await service.get()).store.original((request.params as { version: string }).version))
}
