import { describe, expect, it, vi } from 'vitest'
import { parseGoogleDocument } from '../src/connectors/google-document.js'
import { GooglePeople, selectGoogleEmail } from '../src/connectors/google-people.js'
import { ProviderHttp } from '../src/connectors/http.js'
import type { ConnectorContext } from '../src/connectors/types.js'

const person = { external_id: 'users/123', person_id: '3287feb3-343f-4d2d-8159-cd9d5c6625c7', name: 'Ana Pérez', email: 'ana@example.com', identity_verified: true }
const paragraph = (text: string, startIndex: number, heading = false) => ({ startIndex, endIndex: startIndex + text.length,
  paragraph: { paragraphStyle: { namedStyleType: heading ? 'HEADING_3' : 'NORMAL_TEXT' }, elements: [{ textRun: { content: text } }] } })

describe('hablantes de documentos y emails verificados', () => {
  it('separa notas de transcripción y usa el roster de la reunión, con marcas de sección explícitas', () => {
    const parsed = parseGoogleDocument({ documentId: 'doc', tabs: [
      { tabProperties: { tabId: 'notes', title: 'Notas' }, documentTab: { body: { content: [paragraph('Ana Pérez: resumen escrito por Gemini, no un diálogo.', 1)] } } },
      { tabProperties: { tabId: 'transcript', title: 'Transcripción' }, documentTab: { body: { content: [paragraph('00:01:30', 10, true), paragraph('Ana Pérez: Entrego el martes.\nInvitado: Gracias.', 20)] } } },
    ] }, [person])
    expect(parsed.fragments[0]!.speaker).toBeUndefined()
    expect(parsed.fragments[2]!.speaker).toBe('users/123')
    expect(parsed.fragments[2]!.text).toBe('Entrego el martes.')
    expect(parsed.fragments[2]!.offset_ms).toBe(90000)
    expect(parsed.fragments[2]!.metadata).toMatchObject({ timestamp_precision: 'section', start_index: 20, speaker_resolution: 'meeting_roster' })
    expect(parsed.participants.find(p => p.external_id === 'users/123')).toMatchObject(person)
    expect(parsed.participants.find(p => p.name === 'Invitado')?.email).toBeUndefined()
    expect(parsed.speakerLines).toBe(2)
  })
  it('no atribuye un homónimo a un email ni mezcla identidades entre documentos', () => {
    const makeDoc = (documentId: string) => ({ documentId, title: 'Transcripción', body: { content: [paragraph('Ana Pérez: Hola.', 1)] } })
    const ambiguous = parseGoogleDocument(makeDoc('one'), [person, { ...person, person_id: '34cc0471-e023-490b-afd9-e180358d6157', external_id: 'users/456', email: 'another@example.com' }])
    expect(ambiguous.participants[0]!.email).toBeUndefined()
    expect(ambiguous.participants[0]!.email_status).toBe('ambiguous')
    expect(ambiguous.fragments[0]!.metadata.speaker_resolution).toBe('ambiguous')
    expect(parseGoogleDocument(makeDoc('two')).participants[0]!.external_id).not.toBe(ambiguous.participants[0]!.external_id)
  })
  it('prefiere un correo de Calendar sólo entre los emails confirmados por el mismo ID Google', () => {
    const profile = { emailAddresses: [{ value: 'personal@example.com', metadata: { primary: true } }, { value: 'work@example.com' }] }
    expect(selectGoogleEmail(profile, ['work@example.com']).email).toBe('work@example.com')
    expect(selectGoogleEmail(profile, ['invented@example.com']).email).toBe('personal@example.com')
    expect(selectGoogleEmail({ emailAddresses: [{ value: 'one@example.com' }, { value: 'two@example.com' }] }).email).toBeUndefined()
  })
  it('consulta por ID estable una sola vez y conserva el email pendiente ante falta de permiso', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 }))
    const progress = vi.fn(async () => {})
    const resolver = new GooglePeople({ http: new ProviderHttp(fetcher), progress } as unknown as ConnectorContext, { Authorization: 'test' })
    const unresolved = { external_id: 'users/123', name: 'Ana Pérez', identity_verified: true }
    expect((await resolver.resolve(unresolved)).email_status).toBe('permission_required')
    expect((await resolver.resolve(unresolved)).email).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/people/123?')
    expect(progress).toHaveBeenCalled()
    await resolver.resolve({ external_id: 'anonymous/123', name: 'Ana Pérez', identity_verified: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
