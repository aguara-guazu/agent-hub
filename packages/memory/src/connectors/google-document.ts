import type { ImportInput } from '../contracts.js'
import { createHash } from 'node:crypto'

type Participant = ImportInput['participants'][number]
export const normalizeSpeaker = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const transcriptTitle = /transcrip(?:t|ci[oó]n)/i
const clock = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/
const label = /^([\p{L}\p{M}\p{N} ._'’()@+-]{1,120}):\s*(.*)$/u
const lineId = (tab: string, text: string) => `${tab}:${createHash('sha256').update(text).digest('hex')}`

/** Distinguish transcript tabs from summaries; retain source paragraph coordinates. */
export function parseGoogleDocument(document: any, roster: Participant[] = []): { fragments: ImportInput['fragments']; participants: Participant[]; speakerLines: number } {
  const fragments: ImportInput['fragments'] = [], participants = new Map<string, Participant>()
  const byName = new Map<string, Participant[]>()
  for (const person of roster) {
    const name = normalizeSpeaker(person.name), matches = byName.get(name) ?? []
    if (!matches.some(p => p.person_id ? p.person_id === person.person_id : p.external_id === person.external_id)) matches.push(person)
    byName.set(name, matches)
  }
  let speakerLines = 0
  function visit(elements: any[], tab: string, tabTitle: string, inheritedTranscript = false) {
    let inTranscript = inheritedTranscript || transcriptTitle.test(tabTitle), offset: number | undefined
    for (const element of elements) {
      const paragraph = element.paragraph
      const text: string = (paragraph?.elements ?? []).map((e: any) => e.textRun?.content ?? e.person?.personProperties?.name ?? '').join('').trim()
      const heading = paragraph?.paragraphStyle?.namedStyleType?.startsWith('HEADING')
      if (heading && transcriptTitle.test(text) && !/finaliz|ended|termin/i.test(text)) inTranscript = true
      const time = clock.exec(text)
      if (inTranscript && time) offset = (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000
      if (heading && /^(resumen|summary|notas|notes|decisiones|decisions|detalles|details|pr[oó]ximos pasos)$/i.test(text)) { inTranscript = false; offset = undefined }
      const metadata = { tab, tab_title: tabTitle, start_index: element.startIndex ?? null, end_index: element.endIndex ?? null }
      if (text) {
        // Google uses a paragraph with several speaker-labelled lines in some exports.
        const lines = inTranscript && !heading ? text.split(/\r?\n/).filter(v => v.trim()) : [text]
        for (const line of lines) {
          const match = inTranscript && !heading ? label.exec(line.trim()) : null
          if (match && !/^https?$/i.test(match[1]!)) {
            const name = match[1]!.trim(), matches = byName.get(normalizeSpeaker(name)) ?? []
            const person: Participant = matches.length === 1 ? matches[0]! : {
              external_id: `docs:${document.documentId ?? 'document'}:speaker:${normalizeSpeaker(name)}`, name, identity_verified: false,
              email_status: matches.length > 1 ? 'ambiguous' : 'missing' }
            participants.set(person.external_id, person)
            fragments.push({ text: match[2]!.trim() || line.trim(), speaker: person.external_id,
              external_id: lineId(tab, line),
              ...(offset !== undefined ? { offset_ms: offset } : {}),
              metadata: { ...metadata, original_text: line, format: 'google-docs-transcript', speaker_display_name: name,
                speaker_resolution: matches.length === 1 ? 'meeting_roster' : matches.length > 1 ? 'ambiguous' : 'label_only',
                ...(offset !== undefined ? { timestamp_precision: 'section' } : {}) } })
            speakerLines++
          } else fragments.push({ text: line, external_id: lineId(tab, line),
            metadata: { ...metadata, format: inTranscript ? 'google-docs-transcript-context' : 'google-docs-document' } })
        }
      }
      for (const row of element.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) visit(cell.content ?? [], tab, tabTitle, inTranscript)
    }
  }
  function tabs(items: any[]) { for (const tab of items) {
    visit(tab.documentTab?.body?.content ?? [], tab.tabProperties?.tabId ?? '', tab.tabProperties?.title ?? '')
    tabs(tab.childTabs ?? [])
  } }
  if (document.tabs?.length) tabs(document.tabs)
  else visit(document.body?.content ?? [], '', document.title ?? '')
  return { fragments, participants: [...participants.values()], speakerLines }
}
