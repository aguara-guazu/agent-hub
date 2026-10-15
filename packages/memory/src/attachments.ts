import { pdfPreview } from './pdf.js'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { check, id, instant, localPath, parse } from './contracts.js'
import type { MemoryStore } from './store.js'
import { parseTranscript, splitText } from './transcript.js'

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
  title: z.string().trim().min(1).max(500).optional(), description: z.string().max(100_000).default(''),
  kind: z.enum(['document', 'meeting', 'note']).default('document'),
  external_id: z.string().min(1).max(1024).optional(), project_ids: z.array(id).max(100).default([]),
  occurred_at: instant.optional(), annotations: z.array(annotation).max(2000).default([]),
  /** Title, external_id and description are provisional; the worker replaces them from the processed content. */
  infer_metadata: z.boolean().default(false),
}).strict().refine(v => Boolean(v.path) !== (v.data_base64 !== undefined), 'Enviá una ruta local o contenido base64, no ambos')
  .refine(v => v.infer_metadata || v.title !== undefined, 'Indicá el título del archivo')
export const getFileInput = z.object({ version_id: id, page: z.number().int().min(1).max(200).optional(), include_content: z.boolean().default(false) }).strict()

const TEXT_NAME = /\.(txt|md|csv|tsv|json|yaml|yml|log|vtt|srt)$/i
/** Files that Notepad and Excel save in the ANSI code page when no encoding is chosen. */
const ANSI_NAME = /\.(txt|csv|tsv)$/i
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/
const BOMS = [['utf-8', [0xef, 0xbb, 0xbf]], ['utf-16le', [0xff, 0xfe]], ['utf-16be', [0xfe, 0xff]]] as const
const bomEncoding = (data: Buffer) => BOMS.find(([, bytes]) => bytes.every((byte, i) => data[i] === byte))?.[0]

/**
 * Text of an attachment named as text, or undefined when it must be kept as binary. A byte order mark selects
 * UTF-8 or UTF-16 and is dropped by TextDecoder; without one the content must be UTF-8, except .txt/.csv/.tsv,
 * which fall back to Windows-1252. UTF-16 and Windows-1252 decode almost any byte sequence, so for them a
 * control byte other than whitespace marks a binary.
 */
export function fileText(data: Buffer, name = ''): string | undefined {
  if (!TEXT_NAME.test(name) || data.length > 5_000_000) return undefined
  const decode = (encoding: string, fatal = true) => { try { return new TextDecoder(encoding, { fatal }).decode(data) } catch { return undefined } }
  const bom = bomEncoding(data)
  if (!bom || bom === 'utf-8') {
    const text = decode('utf-8')
    if (text !== undefined || bom || !ANSI_NAME.test(name)) return text
  }
  // Runtimes without full ICU data lack windows-1252; latin1 differs only in 0x80-0x9f.
  const text = bom ? decode(bom) : decode('windows-1252', false) ?? data.toString('latin1')
  return text === undefined || CONTROL.test(text) ? undefined : text
}

export function fileMime(data: Buffer, name = ''): string {
  // FF FE, the UTF-16LE mark, is also a valid MPEG audio frame sync.
  if (bomEncoding(data) === 'utf-16le' && fileText(data, name) !== undefined) return 'text/plain'
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
  if (data.subarray(4,8).toString() === 'ftyp') return /\.(m4a|m4b)$/i.test(name) ? 'audio/mp4' : 'video/mp4'
  if (data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return /\.(weba|opus)$/i.test(name) ? 'audio/webm' : 'video/webm'
  if (data.subarray(0,5).toString() === '%PDF-') return 'application/pdf'
  return fileText(data, name) === undefined ? 'application/octet-stream' : 'text/plain'
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
    const path = localPath(input.path, 'Use una ruta absoluta al archivo local (en Windows, con letra de unidad: C:\\Users\\...)')
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      check(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'Se requiere un archivo regular de hasta 25 MB')
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      check(bytesRead === stat.size, 'El archivo cambió durante la lectura; reintentá')
      data = buffer.subarray(0, bytesRead)
    } finally { await file.close() }
    name ??= basename(path)
  } else { data = decodeBase64(input.data_base64!); check(name, 'Indicá el nombre del archivo') }
  name = parse(filename, name)
  const digest = createHash('sha256').update(data).digest('hex'), mime = fileMime(data, name)
  const attachment = { filename: name, mime_type: mime, size: data.length, sha256: digest }
  if (input.infer_metadata) {
    // An inferred external_id no longer carries the hash, so an identical upload is matched by content and only gains the new projects.
    const existing = (await store.db.query(`SELECT s.entity_id,s.id AS source_id,s.current_version_id FROM sources s JOIN entities e ON e.id=s.entity_id
      WHERE s.provider='manual' AND s.account='local' AND s.status='active' AND e.data->'attachment'->>'sha256'=$1 LIMIT 1`, [digest]))[0]
    if (existing) {
      for (const project of new Set(input.project_ids)) await store.link({ from_id: existing.entity_id, to_id: project, type: 'project' }, actor)
      return { entity_id: existing.entity_id as string, source_id: existing.source_id as string, version_id: existing.current_version_id as string, duplicate: true, fragments: 0,
        attachment, download_url: `/api/memory/files/${existing.current_version_id}`, local_url: `/#/memory/entities/${existing.entity_id}` }
    }
  }
  const title = input.title ?? name
  const text = mime === 'text/plain' ? fileText(data, name) ?? '' : ''
  const fragments = [{ text: [title, input.description].filter(Boolean).join('\n'), metadata: { attachment, annotation: true } },
    ...(text ? (input.kind === 'meeting' ? parseTranscript(text) : splitText(text)).map(part => ({ ...part, metadata: { ...part.metadata, attachment, annotation: false, source_text: true } })) : []),
    ...input.annotations.map(a => ({ text: a.text, ...(a.offset_ms !== undefined ? { offset_ms: a.offset_ms } : {}),
      metadata: { attachment, annotation: true, ...(a.end_offset_ms !== undefined ? { end_offset_ms: a.end_offset_ms } : {}), ...(a.page ? { page: a.page } : {}), ...(a.region ? { region: a.region } : {}) } }))]
  const result = await store.ingest({ kind: input.kind, title, external_id: input.external_id ?? `file:sha256:${digest}`,
    project_ids: input.project_ids, ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}), fragments,
    // An annotation is supplied context, never an automatically verified transcript or OCR.
    // An upload that asks for inference follows the global and per-project remote policy; the original file itself is never sent.
    metadata: input.infer_metadata ? { attachment, infer_metadata: true, ...(input.description ? { description: input.description } : {}) }
      : { attachment, remote_processing: false, description: input.description },
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
export async function getFile(store: MemoryStore, raw: unknown, signal?: AbortSignal) {
  const input = parse(getFileInput, raw), { data, ...file } = await readFileAttachment(store, input.version_id)
  if (input.page !== undefined) {
    check(file.mime_type === 'application/pdf', 'La selección de página sólo corresponde a un PDF')
    const preview = await pdfPreview(data, input.page, signal)
    check(!input.include_content || preview.data.length <= 5_000_000, 'La página supera 5 MB; usá su enlace de descarga')
    return { ...file, version_id: input.version_id, source_sha256: file.sha256, sha256: createHash('sha256').update(preview.data).digest('hex'), page: preview.page, pages: preview.pages, mime_type: 'image/png', filename: `${file.filename}.page-${input.page}.png`, size: preview.data.length,
      download_url: `/api/memory/files/${input.version_id}/pages/${input.page}`, ...(input.include_content ? { data_base64: preview.data.toString('base64') } : {}) }
  }
  check(!input.include_content || data.length <= 5_000_000, 'Para archivos de más de 5 MB usá la descarga del original')
  return { ...file, version_id: input.version_id, download_url: `/api/memory/files/${input.version_id}`,
    ...(input.include_content ? { data_base64: data.toString('base64') } : {}) }
}
