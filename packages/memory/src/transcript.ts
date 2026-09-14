import type { ImportInput } from './contracts.js'
type Part = ImportInput['fragments'][number]

export function splitText(text: string, size = 1800): Part[] {
  const out: Part[] = []
  let pending = ''
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (pending.length + line.length > size && pending.trim()) { out.push({ text: pending.trim(), metadata: {} }); pending = '' }
    for (let start = 0; start < line.length; start += size) {
      const part = line.slice(start, start + size)
      if (part.length === size) out.push({ text: part, metadata: {} })
      else pending += part + '\n'
    }
  }
  if (pending.trim()) out.push({ text: pending.trim(), metadata: {} })
  return out
}
function milliseconds(value: string): number {
  const numbers = value.replace(',', '.').split(':').map(Number)
  return Math.round(numbers.reduce((total, n) => total * 60 + n, 0) * 1000)
}

/** Reads VTT/SRT and common Google Docs speaker lines, preserving unknown identity/time. */
export function parseTranscript(text: string): Part[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  const blocks = normalized.split(/\n\s*\n/)
  if (blocks.some(block => block.includes('-->'))) {
    const result: Part[] = []
    for (const block of blocks) {
      const lines = block.split('\n')
      const timeIndex = lines.findIndex(line => /\d+:\d+.*-->/.test(line))
      if (timeIndex < 0) continue
      const time = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/.exec(lines[timeIndex]!)
      const body = lines.slice(timeIndex + 1).join('\n')
      const voice = /<v\s+([^>]+)>/.exec(body)
      const clean = body.replace(/<[^>]*>/g, '').trim()
      const speaker = voice?.[1] ?? /^([^:\n]{1,120}):\s/.exec(clean)?.[1]
      const content = !voice && speaker ? clean.slice(speaker.length + 1).trim() : clean
      if (content) result.push({ text: content, ...(speaker ? { speaker } : {}), ...(time ? { offset_ms: milliseconds(time[1]!) } : {}), metadata: { ...(time ? { end_offset_ms: milliseconds(time[2]!) } : {}), format: 'captions' } })
    }
    return result
  }
  const result: Part[] = []
  for (const line of normalized.split('\n')) {
    if (!line.trim()) continue
    const match = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*)?([^:\n]{1,120}):\s+(.+)$/.exec(line)
    if (match) {
      // Plain-text clock labels can be wall time or elapsed time. Preserve them without guessing.
      result.push({ text: match[3]!, speaker: match[2]!.trim(), metadata: { timestamp_label: match[1] ?? null, format: 'speaker-lines' } })
    } else if (result.length) result[result.length - 1]!.text += '\n' + line
    else result.push({ text: line, metadata: { format: 'plain' } })
  }
  return result.flatMap(part => part.text.length <= 20_000 ? [part] : splitText(part.text, 4000).map(p => ({ ...part, text: p.text })))
}
