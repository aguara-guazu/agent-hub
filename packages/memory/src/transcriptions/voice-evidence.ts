import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { speakerHints } from "./recordings.js"
import type { VoiceTurn } from "../diarization.js"
import type { StoredVoice, VoiceProposal } from "./recording-processing.js"
import type { MemoryStore } from "../store.js"

export interface VisualHint { offset: number; name: string; voice: number | null }

export async function alignWindowHints(directory: string, start: number, systemOffset: number, turns: VoiceTurn[]): Promise<VisualHint[]> {
  const raw = await readFile(join(directory, "speaker-hints.json"), "utf8").catch(() => "")
  if (!raw) return []
  let hints
  try { hints = speakerHints.parse(JSON.parse(raw)) } catch { return [] }
  return hints.flatMap(hint => {
    const offset = hint.at - start
    const seconds = offset / 1000 - systemOffset
    if (offset < 0 || offset > 3 * 3600000) return []
    // Do not anchor an identity on a change of speaker. The visual indicator may lag behind the audio.
    const nearby = turns.filter(t => t.start < seconds + 0.4 && t.end > seconds - 0.6)
    const active = nearby.find(t => t.start <= seconds && t.end >= seconds)
    const voice = active && active.voice > 0 && nearby.every(t => t.voice === active.voice) ? active.voice : null
    return [{ offset, name: hint.name, voice }]
  })
}

export const canonicalName = (name: string) => name.trim().normalize("NFC").toLocaleLowerCase()

/** Reference voiceprints are compared locally. Only explicit "remember" decisions seed future meetings. */
export async function rememberedVoices(store: MemoryStore, recordingId: string, voices: StoredVoice[]) {
  const references = await store.db.query<{ person: string; name: string; vector: number[] }>(`SELECT p.id AS person,p.title AS name,j.value->'embedding' AS "vector:json"
    FROM recordings r,json_each(r.speakers) j JOIN entities p ON p.id=j.value->>'person_id'
    WHERE r.id<>$1 AND j.value->>'status'='confirmed' AND j.value->>'remember'=1
      AND p.kind='person' AND p.data->>'merged_into' IS NULL`, [recordingId])
  const proposals = new Map<number, VoiceProposal>()
  for (const voice of voices) {
    if (voice.seconds < 3) continue
    const scores = new Map<string, { person: string; name: string; score: number }>()
    for (const ref of references) {
      if (!ref.vector?.length || ref.vector.length !== voice.embedding.length) continue
      const score = ref.vector.reduce((sum, x, i) => sum + x * voice.embedding[i]!, 0)
      if (score > (scores.get(ref.person)?.score ?? 0)) scores.set(ref.person, { ...ref, score })
    }
    const [best, next] = [...scores.values()].sort((a, b) => b.score - a.score)
    if (best && best.score >= 0.85 && best.score - (next?.score ?? 0) >= 0.08) {
      proposals.set(voice.voice, { name: best.name, email: "", person_id: best.person, confidence: "medium",
        reason: "La voz se parece a una muestra que confirmaste para otras reuniones." })
    }
  }
  return proposals
}
