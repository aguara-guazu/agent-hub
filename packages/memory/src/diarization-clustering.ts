interface NativeSegment { start: number; end: number; speaker: number }

/** Native clustering allocates for its entire input. Give it bounded pieces and keep one global clock for voice attribution. */
export function diarizationSegments(duration: number, speech: { start: number; end: number }[] | undefined,
  processBlock: (start: number, end: number) => NativeSegment[]): NativeSegment[] {
  const segments: NativeSegment[] = []
  let nextSpeaker = 0
  for (let start = 0; start < duration; start += 240) {
    const end = Math.min(duration, start + 240)
    if (speech && !speech.some(region => region.start < end && region.end > start)) continue
    const from = Math.max(0, start - 2), to = Math.min(duration, end + 2)
    if (to - from < 1) continue
    const localIds = new Map<number, number>()
    for (const segment of processBlock(from, to)) {
      const begin = Math.max(start, from + segment.start), finish = Math.min(end, from + segment.end)
      if (finish <= begin) continue
      let speaker = localIds.get(segment.speaker)
      if (speaker === undefined) { speaker = nextSpeaker++; localIds.set(segment.speaker, speaker) }
      segments.push({ start: begin, end: finish, speaker })
    }
  }
  return segments
}

/** Split before computing voiceprints: a native cluster can contain different people on either side of a pause. */
export interface SpeechTurn {
  start: number
  end: number
  region: number
  source: number | null
  overlap: boolean
}

export function speechTurns(segments: { start: number; end: number; speaker: number }[], speech: { start: number; end: number }[]): SpeechTurn[] {
  const turns: SpeechTurn[] = []
  for (const [region, span] of speech.entries()) {
    const candidates = segments.filter(turn => turn.start < span.end && turn.end > span.start)
    const cuts = [...new Set([span.start, span.end, ...candidates.flatMap(turn => [turn.start, turn.end]).filter(time => time > span.start && time < span.end)])].sort((a, b) => a - b)
    let last: SpeechTurn | undefined
    for (let index = 0; index < cuts.length - 1; index++) {
      const start = cuts[index]!, end = cuts[index + 1]!
      const active = candidates.filter(turn => turn.start < end && turn.end > start)
      const source = active.length === 1 ? active[0]!.speaker : null
      if (last && source !== null && source === last.source) last.end = end
      else {
        last = { start, end, region, source, overlap: active.length > 1 }
        turns.push(last)
      }
    }
  }
  return turns
}

export interface EmbeddedTurn { embedding: number[]; seconds: number; index: number }
interface Group { indices: number[]; seconds: number; sum: number[]; embedding: number[] }

const dot = (a: number[], b: number[]): number => a.reduce((sum, value, index) => sum + value * b[index]!, 0)
const normalize = (values: number[]): number[] => { const norm = Math.sqrt(dot(values, values)) || 1; return values.map(value => value / norm) }

/** Agglomerate clean utterance embeddings, retaining short uncertain utterances separately. */
export function clusterSpeech(prints: EmbeddedTurn[], similarity: number): Group[] {
  const groups: (Group | null)[] = prints.map(print => {
    const weight = Math.min(10, print.seconds)
    return { indices: [print.index], seconds: print.seconds, sum: print.embedding.map(value => value * weight), embedding: print.embedding }
  })
  // Cache distances so successive merges do not repeat every vector dot product. Keep only each row's best
  // candidate; recompute that row when its best group changes. Memory is quadratic in utterances, not audio.
  const size = groups.length
  const distances = Array.from({ length: size }, () => new Float32Array(size))
  const nearest = new Int32Array(size).fill(-1)
  const scores = new Float32Array(size).fill(-1)
  const refresh = (index: number): void => {
    nearest[index] = -1; scores[index] = -1
    for (let other = 0; other < size; other++) if (other !== index && groups[other] && distances[index]![other]! > scores[index]!) {
      nearest[index] = other; scores[index] = distances[index]![other]!
    }
  }
  for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) distances[a]![b] = distances[b]![a] = dot(groups[a]!.embedding, groups[b]!.embedding)
  for (let index = 0; index < size; index++) refresh(index)
  for (;;) {
    let kept = -1, best = similarity
    for (let index = 0; index < size; index++) if (groups[index] && scores[index]! > best) { best = scores[index]!; kept = index }
    if (kept < 0) break
    const absorbed = nearest[kept]!, group = groups[kept]!, other = groups[absorbed]!
    group.indices.push(...other.indices)
    group.seconds += other.seconds
    group.sum = group.sum.map((value, index) => value + other.sum[index]!)
    group.embedding = normalize(group.sum)
    groups[absorbed] = null
    for (let index = 0; index < size; index++) if (groups[index] && index !== kept) distances[kept]![index] = distances[index]![kept] = dot(group.embedding, groups[index]!.embedding)
    for (let index = 0; index < size; index++) if (groups[index]) {
      if (index === kept || nearest[index] === kept || nearest[index] === absorbed) refresh(index)
      else if (distances[index]![kept]! > scores[index]!) { nearest[index] = kept; scores[index] = distances[index]![kept]! }
    }
  }
  return groups.filter((group): group is Group => group !== null)
}
