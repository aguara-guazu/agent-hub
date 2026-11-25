import { expect, it } from "vitest"
import { diarizationSegments } from "../src/diarization-clustering.js"

it("processes a 151-minute recording with bounded native inputs and continuous timestamps", () => {
  const duration = 151 * 60
  const segments = diarizationSegments(duration, undefined, (from, to) => {
    expect(to - from).toBeLessThanOrEqual(244)
    return [{ start: 0, end: to - from, speaker: 0 }]
  })
  expect(segments[0]?.start).toBe(0)
  expect(segments.at(-1)?.end).toBe(duration)
  for (const [index, segment] of segments.slice(1).entries()) {
    expect(segment.start).toBe(segments[index]!.end)
    expect(segment.speaker).not.toBe(segments[index]!.speaker)
  }
})

it("skips silent blocks without moving a later voice to the start of the recording", () => {
  const calls: number[] = []
  const segments = diarizationSegments(151 * 60, [{ start: 816, end: 821 }], (from) => {
    calls.push(from)
    return [{ start: 816 - from, end: 821 - from, speaker: 0 }]
  })
  expect(calls).toHaveLength(1)
  expect(segments).toEqual([{ start: 816, end: 821, speaker: 0 }])
})
