import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { z } from 'zod'
import { check, id, instant, parse } from './contracts.js'
import type { MemoryStore } from './store.js'
import { splitText } from './transcript.js'

const MAX_BYTES = 25_000_000
const filename = z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+$/)
const annotation = z.object({ text: z.string().trim().min(1).max(100_000),
  offset_ms: z.number().int().nonnegative().optional(), end_offset_ms: z.number().int().nonnegative().optional(),
  page: z.number().int().positive().optional(),
  region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(),
}).strict().refine(a => a.end_offset_ms === undefined || (a.offset_ms !== undefined && a.end_offset_ms >= a.offset_ms), 'El final debe ser posterior al comienzo')
export const importFileInput = z.object({
  path: z.string().max(4000).optional(), filename: filename.optional(),
  data_base64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4).optional(),
  title: z.string().trim().min(1).max(500), description: z.string().max(100_000).default(''),
  external_id: z.string().min(1).max(1024).optional(), project_ids: z.array(id).max(100).default([]),
  occurred_at: instant.optional(), annotations: z.array(annotation).max(2000).default([]),
}).strict().refine(v => Boolean(v.path) !== (v.data_base64 !== undefined), 'Enviá una ruta local o contenido base64, no ambos')
export const getFileInput = z.object({ version_id: id, include_content: z.boolean().default(false) }).strict()

export function fileMime(data: Buffer, name = ''): string {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a','GIF89a'].includes(data.subarray(0,6).toString())) return 'image/gif'
  if (data.subarray(0,4).toString() === 'RIFF') {
    if (data.subarray(8,12).toString() === 'WEBP') return 'image/webp'
    if (data.subarray(8,12).toString() === 'WAVE') return 'audio/wav'
  }
  if (data.subarray(0,3).toString() === 'ID3' || (data[0] === 255 && ((data[1] ?? 0) & 224) === 224)) return 'audio/mpeg'
  if (data.subarray(0,4).toString() === 'OggS') return 'audio/ogg'
  if (data.subarray(0,4).toString() === 'fLaC') return 'audio/flac'
  if (data.subarray(4,8).toString() === 'ftyp') return 'video/mp4'
  if (data.subarray(0,5).toString() === '%PDF-') return 'application/pdf'
  if (/\.(txt|md|csv|json|yaml|yml|log|vtt|srt)$/i.test(name) && data.length <= 5_000_000) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); return 'text/plain' } catch { /* preserve non-UTF8 originals as binary */ }
  }
  return 'application/octet-stream'
}
function decodeBase64(value: string): Buffer {
  check(value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Base64 inválido')
  const data = Buffer.from(value, 'base64')
  check(data.toString('base64') === value, 'Base64 inválido')
  check(data.length <= MAX_BYTES, 'El archivo supera 25 MB')
  return data
}
export async function importFile(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(importFileInput, raw)
  let data: Buffer, name = input.filename
  if (input.path) {
    check(isAbsolute(input.path), 'Usá una ruta absoluta al archivo local')
    const file = await open(input.path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      check(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'Se requiere un archivo regular de hasta 25 MB')
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      check(bytesRead === stat.size, 'El archivo cambió durante la lectura; reintentá')
      data = buffer.subarray(0, bytesRead)
    } finally { await file.close() }
    name ??= basename(input.path)
  } else { data = decodeBase64(input.data_base64!); check(name, 'Indicá el nombre del archivo') }
  name = parse(filename, name)
  const digest = createHash('sha256').update(data).digest('hex'), mime = fileMime(data, name)
  const attachment = { filename: name, mime_type: mime, size: data.length, sha256: digest }
  const fragments = [{ text: [input.title, input.description].filter(Boolean).join('\n'), metadata: { attachment, annotation: true } },
    ...(mime === 'text/plain' ? splitText(data.toString('utf8')).map(part => ({ ...part, metadata: { ...part.metadata, attachment, annotation: false, source_text: true } })) : []),
    ...input.annotations.map(a => ({ text: a.text, ...(a.offset_ms !== undefined ? { offset_ms: a.offset_ms } : {}),
      metadata: { attachment, annotation: true, ...(a.end_offset_ms !== undefined ? { end_offset_ms: a.end_offset_ms } : {}), ...(a.page ? { page: a.page } : {}), ...(a.region ? { region: a.region } : {}) } }))]
  const result = await store.ingest({ kind: 'document', title: input.title, external_id: input.external_id ?? `file:sha256:${digest}`,
    project_ids: input.project_ids, ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}), fragments,
    // An annotation is supplied context, never an automatically verified transcript or OCR.
    metadata: { attachment, remote_processing: false, description: input.description },
    original: { format: 'agenthub-file-v1', ...attachment, data_base64: data.toString('base64') } }, actor)
  return { ...result, attachment, download_url: `/api/memory/files/${result.version_id}`, local_url: `/#/memory/entities/${result.entity_id}` }
}
export async function readFileAttachment(store: MemoryStore, versionId: string) {
  const original = await store.original(versionId) as { original?: Record<string, unknown> }
  const file = original.original
  check(file?.format === 'agenthub-file-v1' && typeof file.data_base64 === 'string', 'Esta versión no contiene un archivo adjunto', 404)
  const data = decodeBase64(file.data_base64)
  check(createHash('sha256').update(data).digest('hex') === file.sha256, 'El archivo no coincide con su hash', 409)
  const name = parse(filename, file.filename)
  return { data, filename: name, mime_type: fileMime(data, name), size: data.length, sha256: file.sha256 as string }
}
export async function getFile(store: MemoryStore, raw: unknown) {
  const input = parse(getFileInput, raw), { data, ...file } = await readFileAttachment(store, input.version_id)
  check(!input.include_content || data.length <= 5_000_000, 'Para archivos de más de 5 MB usá la descarga del original')
  return { ...file, version_id: input.version_id, download_url: `/api/memory/files/${input.version_id}`,
    ...(input.include_content ? { data_base64: data.toString('base64') } : {}) }
}
