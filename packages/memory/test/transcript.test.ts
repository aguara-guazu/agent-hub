import { describe, expect, it } from 'vitest'
import { parseTranscript, splitText } from '../src/transcript.js'
import { GoogleAuth } from '../src/google-auth.js'
import { Vault } from '../src/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('importación y OAuth', () => {
  it('conserva nombres y timestamps de VTT sin inventar fechas absolutas', () => {
    const result = parseTranscript('WEBVTT\n\n00:00:02.100 --> 00:00:04.900\n<v Ana>Una decisión.</v>\n\n00:00:05.000 --> 00:00:07.000\nLuis: Confirmado.')
    expect(result).toHaveLength(2); expect(result[0]!.offset_ms).toBe(2100)
    expect(result[0]!.speaker).toBe('Ana'); expect(result[0]!.start_time).toBeUndefined()
  })
  it('preserva marcas de hora ambiguas como texto', () => {
    const result = parseTranscript('10:30 Ana: Podemos reunirnos los martes.\nNecesitamos confirmar la zona.\nLuis: De acuerdo.')
    expect(result[0]!.metadata.timestamp_label).toBe('10:30')
    expect(result[0]!.text).toContain('zona')
    expect(result[0]!.offset_ms).toBeUndefined()
  })
  it('preserva todas las palabras al dividir documentos grandes', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ')
    expect(splitText(text).map(p => p.text).join('')).toBe(text)
  })
  it('OAuth usa PKCE y consume cada state una sola vez', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-oauth-'))
    try {
      const vault = new Vault(dir); vault.save('google-client', { client_id: 'client' })
      const auth = new GoogleAuth(vault, 'http://127.0.0.1:8765/api/memory/google/callback', async () => new Response(JSON.stringify({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 })))
      const url = new URL(auth.start('connector')), state = url.searchParams.get('state')!
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('access_type')).toBe('offline')
      expect(await auth.finish(state, 'code')).toBe('connector')
      await expect(auth.finish(state, 'code')).rejects.toThrow('venció')
      expect(await auth.token('connector')).toBe('token')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
