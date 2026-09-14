import type { Connector, ConnectorContext } from './types.js'
import { pages, ProviderError } from './http.js'
import type { ImportInput } from '../contracts.js'
import { GooglePeople } from './google-people.js'
import { parseGoogleDocument } from './google-document.js'

const encoded = encodeURIComponent
export async function syncGoogle(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const { store, http } = ctx
  const token = await ctx.google.token(connector.id)
  const headers = { Authorization: `Bearer ${token}` }
  const people = new GooglePeople(ctx, headers)
  const base = { provider: 'google' as const, account: connector.id, connector_id: connector.id, project_ids: connector.project_ids }
  const since = connector.config.since ?? new Date(Date.now() - 90 * 86400_000).toISOString()
  const until = new Date().toISOString()
  const cursor = { ...connector.cursor }
  let imported = 0
  const calendars: string[] = connector.config.calendars?.length ? connector.config.calendars : ['primary']
  if (connector.config.calendar_enabled !== false) for (const calendar of calendars) {
    // Revisit a bounded window: expanding recurring series without timeMax can
    // materialize decades of future events. A syncToken cannot carry timeMax,
    // and misses unchanged occurrences entering a moving time window.
    if (Date.parse(since) >= Date.parse(until)) continue
    let pageToken = '', completed = false
    while (!completed) {
      ctx.signal.throwIfAborted()
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encoded(calendar)}/events`)
      url.searchParams.set('singleEvents', 'true'); url.searchParams.set('showDeleted', 'true'); url.searchParams.set('maxResults', '250')
      url.searchParams.set('timeMin', since); url.searchParams.set('timeMax', until)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const page = await http.json(url.toString(), headers)
      for (const event of page.items ?? []) {
        ctx.signal.throwIfAborted()
        const externalId = `calendar:${calendar}:${event.id}`
        if (event.status === 'cancelled') {
          // A cancelled calendar event never deletes a conference or its transcript.
          await store.db.query(`UPDATE entities SET data=data || '{"status":"cancelled"}'::jsonb,updated_at=now()
            WHERE id IN(SELECT entity_id FROM sources WHERE provider='google' AND account=$1 AND external_id=$2)`, [connector.id, externalId])
          continue
        }
        const result = await store.ingest({ ...base, external_id: externalId, kind: 'event', title: event.summary || 'Reunión sin título',
          ...(event.htmlLink ? { url: event.htmlLink } : {}), ...(event.start?.dateTime ? { occurred_at: event.start.dateTime } : {}),
          text: [event.summary, event.description, ...(event.attendees ?? []).map((a: any) => `${a.displayName ?? ''} ${a.email ?? ''} (${a.responseStatus ?? 'needsAction'})`)].filter(Boolean).join('\n'),
          metadata: { event_id: event.id, calendar, status: event.status, scheduled_start: event.start ?? null, scheduled_end: event.end ?? null,
            organizer: event.organizer ?? null, attendees: event.attendees ?? [], recurrence_id: event.recurringEventId ?? null,
            original_start: event.originalStartTime ?? null, meet_url: event.hangoutLink ?? null, conference_data: event.conferenceData ?? null, attachments: event.attachments ?? [] }, original: event }, 'connector:google')
        // Explicit document attachments provide a path to historical transcripts, even after Meet entries expire.
        for (const attachment of event.attachments ?? []) if (attachment.fileId && attachment.mimeType === 'application/vnd.google-apps.document') {
          await store.enqueue('google_document', { connector_id: connector.id, document_id: attachment.fileId, event_entity_id: result.entity_id }, `google-doc:${connector.id}:${attachment.fileId}:${event.updated ?? ''}`)
        }
        imported++
      }
      await ctx.progress({ stage: 'calendar', calendar, imported })
      pageToken = page.nextPageToken ?? ''
      if (!pageToken) {
        delete cursor[`calendar:${calendar}`]
        cursor[`calendar_window:${calendar}`] = { from: since, to: until }
        await ctx.checkpoint(cursor)
        completed = true
      }
    }
  }
  if (connector.config.meet_enabled !== false) {
    // Revisit the retention window so late-generated transcript artifacts are not missed.
    const from = new Date(Math.max(Date.parse(since), Date.now() - 29 * 86400_000)).toISOString()
    const url = new URL('https://meet.googleapis.com/v2/conferenceRecords')
    url.searchParams.set('filter', `start_time >= "${from}"`)
    url.searchParams.set('pageSize', '100')
    for await (const conference of pages(http, url.toString(), headers, 'conferenceRecords')) {
      ctx.signal.throwIfAborted()
      const participants: ImportInput['participants'] = []
      const speakerIds = new Map<string, string>()
      for await (const participant of pages(http, `https://meet.googleapis.com/v2/${conference.name}/participants?pageSize=250`, headers, 'participants')) {
        const externalId = participant.signedinUser?.user ?? participant.name
        speakerIds.set(participant.name, externalId)
        if (!participants.some(p => p.external_id === externalId)) participants.push({ external_id: externalId,
          name: participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ?? participant.phoneUser?.displayName ?? 'Sin identificar', identity_verified: Boolean(participant.signedinUser?.user) })
      }
      const fragments: ImportInput['fragments'] = [], docs: string[] = []
      for await (const transcript of pages(http, `https://meet.googleapis.com/v2/${conference.name}/transcripts?pageSize=100`, headers, 'transcripts')) {
        if (transcript.state !== 'FILE_GENERATED') continue
        if (transcript.docsDestination?.document) docs.push(transcript.docsDestination.document)
        for await (const entry of pages(http, `https://meet.googleapis.com/v2/${transcript.name}/entries?pageSize=100`, headers, 'transcriptEntries')) {
          if (!entry.text?.trim()) continue
          fragments.push({ text: entry.text, external_id: entry.name, speaker: speakerIds.get(entry.participant) ?? entry.participant,
            ...(entry.startTime ? { start_time: entry.startTime } : {}), ...(entry.endTime ? { end_time: entry.endTime } : {}),
            metadata: { language: entry.languageCode ?? null, transcript: transcript.name } })
        }
      }
      if (!fragments.length) continue
      fragments.sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''))
      let meetingCode = ''
      if (typeof conference.space === 'string') {
        try { meetingCode = (await http.json(`https://meet.googleapis.com/v2/${conference.space}`, headers)).meetingCode ?? '' }
        catch (error) { if (!(error instanceof ProviderError && [403,404].includes(error.httpStatus))) throw error }
      }
      const matched = await store.db.query(`SELECT e.* FROM entities e JOIN sources s ON s.entity_id=e.id WHERE s.account=$1 AND e.kind='event'
        AND e.data->'conference_data'->>'conferenceId'=$2
        AND abs(EXTRACT(EPOCH FROM ((e.data->'scheduled_start'->>'dateTime')::timestamptz-$3::timestamptz)))<21600`,
        [connector.id, meetingCode, conference.startTime])
      const event = matched.length === 1 ? matched[0] : undefined
      const attendeeEmails = (event?.data.attendees ?? []).map((a: any) => a.email).filter(Boolean)
      for (const [index, person] of participants.entries()) participants[index] = await people.resolve(person, attendeeEmails)
      const result = await store.ingest({ ...base, external_id: conference.name, kind: 'meeting', title: event?.title ?? `Reunión ${conference.startTime ?? ''}`,
        occurred_at: conference.startTime, fragments, participants,
        metadata: { conference: conference.name, space: conference.space ?? null, ended_at: conference.endTime ?? null, document_ids: docs,
          calendar_match: event ? 'matched' : matched.length ? 'ambiguous' : 'unresolved' }, original: { conference, fragments, participants } }, 'connector:google')
      if (event) await store.link({ from_id: result.entity_id, to_id: event.id, type: 'calendar_event' }, 'connector:google')
      for (const doc of docs) await store.enqueue('google_document', { connector_id: connector.id, document_id: doc, meeting_entity_id: result.entity_id }, `google-doc:${connector.id}:${doc}:${result.version_id}`)
      imported++
      await ctx.progress({ stage: 'meet', imported })
    }
  }
  const documentIds = new Set<string>(connector.config.document_ids ?? [])
  for (const folder of connector.config.folder_ids ?? []) {
    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('q', `'${String(folder).replace(/['\\]/g, '')}' in parents and trashed=false and mimeType='application/vnd.google-apps.document'`)
    url.searchParams.set('fields', 'nextPageToken,files(id,name)'); url.searchParams.set('pageSize', '100')
    for await (const file of pages(http, url.toString(), headers, 'files')) documentIds.add(file.id)
  }
  for (const document of documentIds) await importGoogleDocument(connector, ctx, document)
  await ctx.progress({ stage: 'complete', imported, documents: documentIds.size })
}

export async function importGoogleDocument(connector: Connector, ctx: ConnectorContext, documentId: string, relatedId?: string, cachedDocument?: any) {
  const token = await ctx.google.token(connector.id)
  let document: any
  try { document = cachedDocument ?? await ctx.http.json(`https://docs.googleapis.com/v1/documents/${encoded(documentId)}?includeTabsContent=true`, { Authorization: `Bearer ${token}` }) }
  catch (error) {
    if (!(error instanceof ProviderError && [403,404].includes(error.httpStatus))) throw error
    await ctx.store.db.query("UPDATE sources SET status='inaccessible' WHERE provider='google' AND account=$1 AND external_id=$2", [connector.id, `docs:${documentId}`])
    await ctx.progress({ inaccessible_document: documentId, document_error: 'Documento sin acceso; se conserva la copia anterior si existe' })
    return
  }
  // Resolve only within meetings actually linked to this document or its calendar event.
  const meetings = await ctx.store.db.query(`SELECT DISTINCT m.id,m.data FROM entities m WHERE m.kind='meeting' AND (
    m.id=$1::uuid OR m.data->'document_ids' ? $2 OR
    EXISTS(SELECT 1 FROM links l WHERE l.from_id=m.id AND l.to_id=$1::uuid AND l.type='calendar_event') OR
    EXISTS(SELECT 1 FROM links l JOIN sources s ON s.entity_id=l.from_id WHERE l.to_id=m.id AND l.type='meeting_document' AND s.account=$3 AND s.external_id=$4))`,
    [relatedId ?? null, documentId, connector.id, `docs:${documentId}`])
  const roster = meetings.length ? await ctx.store.db.query(`SELECT DISTINCT p.id AS person_id,p.title AS name,i.external_id,i.verified AS identity_verified,
    p.data->>'email' AS email,p.data->>'email_status' AS email_status,p.data->>'email_source' AS email_source
    FROM links l JOIN entities p ON p.id=l.to_id JOIN identities i ON i.person_id=p.id
    WHERE l.from_id=ANY($1::uuid[]) AND l.type='participant' AND i.provider='google' AND i.account=$2`, [meetings.map(m => m.id), connector.id]) : []
  const participants = roster.map(p => Object.fromEntries(Object.entries(p).filter(([, value]) => value !== null))) as ImportInput['participants']
  const parsed = parseGoogleDocument({ ...document, documentId }, participants)
  const { fragments } = parsed
  if (!fragments.length) return
  const result = await ctx.store.ingest({ provider: 'google', account: connector.id, connector_id: connector.id, external_id: `docs:${documentId}`,
    title: document.title || 'Documento de Google', kind: 'document', url: `https://docs.google.com/document/d/${encoded(documentId)}/edit`,
    fragments, participants: parsed.participants, project_ids: connector.project_ids,
    ...(meetings.length === 1 && meetings[0]!.data.occurred_at ? { occurred_at: meetings[0]!.data.occurred_at } : {}),
    metadata: { revision_id: document.revisionId ?? null, speaker_lines: parsed.speakerLines, parser_version: 2 }, original: document }, 'connector:google', Boolean(cachedDocument))
  if (relatedId) await ctx.store.link({ from_id: result.entity_id, to_id: relatedId, type: 'meeting_document' }, 'connector:google')
  for (const meeting of meetings) await ctx.store.link({ from_id: result.entity_id, to_id: meeting.id, type: 'meeting_document' }, 'connector:google')
  return result
}

/** Repairs retained data too: Meet's transcript retention must not limit identity repair. */
export async function repairGoogle(connector: Connector, ctx: ConnectorContext) {
  const token = await ctx.google.token(connector.id), people = new GooglePeople(ctx, { Authorization: `Bearer ${token}` })
  const identities = await ctx.store.db.query("SELECT external_id,display_name AS name,verified AS identity_verified FROM identities WHERE provider='google' AND account=$1 AND external_id LIKE 'users/%'", [connector.id])
  let resolved = 0
  await ctx.progress({ stage: 'identities', identities_total: identities.length, identities_completed: 0 })
  for (const [index, row] of identities.entries()) {
    ctx.signal.throwIfAborted()
    const person = await people.resolve(row as ImportInput['participants'][number])
    await ctx.store.refreshParticipants({ provider: 'google', account: connector.id }, [person])
    if (person.email) resolved++
    await ctx.progress({ identities_completed: index + 1, emails_resolved: resolved })
  }
  const documents = await ctx.store.db.query("SELECT external_id,current_version_id FROM sources WHERE provider='google' AND account=$1 AND external_id LIKE 'docs:%'", [connector.id])
  await ctx.progress({ stage: 'document_speakers', documents_total: documents.length, documents_completed: 0 })
  for (const [index, source] of documents.entries()) {
    ctx.signal.throwIfAborted()
    const original = await ctx.store.original(source.current_version_id) as ImportInput
    await importGoogleDocument(connector, ctx, source.external_id.slice(5), undefined, original.original)
    await ctx.progress({ documents_completed: index + 1 })
  }
  await ctx.progress({ stage: 'complete' })
}
