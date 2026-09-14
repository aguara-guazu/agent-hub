import { z } from 'zod'
import type { ImportInput } from '../contracts.js'
import type { ConnectorContext } from './types.js'
import { ProviderError } from './http.js'

type Person = ImportInput['participants'][number]
export function selectGoogleEmail(profile: any, attendeeEmails: string[] = []) {
  const emails = (profile.emailAddresses ?? []).filter((e: any) => z.email().safeParse(e.value).success)
  const candidates = [...new Set<string>(emails.map((e: any) => e.value.toLowerCase()))]
  const attendees = candidates.filter(e => attendeeEmails.map(v => v.toLowerCase()).includes(e))
  const primary = [...new Set<string>(emails.filter((e: any) => e.metadata?.primary).map((e: any) => e.value.toLowerCase()))]
  return { email: attendees.length === 1 ? attendees[0] : primary.length === 1 ? primary[0] : candidates.length === 1 ? candidates[0] : undefined, candidates }
}

/** Google user IDs provide identity; a matching display name alone never does. */
export class GooglePeople {
  private profiles = new Map<string, Promise<any>>()
  constructor(private ctx: ConnectorContext, private headers: Record<string, string>) {}
  async resolve(person: Person, attendeeEmails: string[] = []): Promise<Person> {
    if (!/^users\/[^/]+$/.test(person.external_id)) return { ...person, email_status: 'missing' }
    const resource = person.external_id.replace(/^users\//, 'people/')
    try {
      if (!this.profiles.has(resource)) {
        const url = new URL(`https://people.googleapis.com/v1/${resource}`)
        url.searchParams.set('personFields', 'names,emailAddresses,metadata')
        for (const source of ['READ_SOURCE_TYPE_PROFILE', 'READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_OTHER_CONTACT']) url.searchParams.append('sources', source)
        this.profiles.set(resource, this.ctx.http.json(url.toString(), this.headers))
      }
      const profile = await this.profiles.get(resource)
      const { email, candidates } = selectGoogleEmail(profile, attendeeEmails)
      return { ...person, ...(email ? { email } : {}), email_candidates: candidates.slice(0, 30),
        email_status: email ? 'verified' : candidates.length ? 'ambiguous' : 'missing', email_source: `google_people:${resource}` }
    } catch (error) {
      if (!(error instanceof ProviderError && [403, 404].includes(error.httpStatus))) throw error
      await this.ctx.progress({ identity_warning: error.httpStatus === 403 ? 'Google no permitió leer algunos perfiles. Revisá People API y reconectá Google para autorizar contactos y directorio.' : 'Google no publicó el email de algunos participantes.' })
      return { ...person, email_status: error.httpStatus === 403 ? 'permission_required' : 'missing' }
    }
  }
}
