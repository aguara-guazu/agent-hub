import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { open, readFile, rm, stat } from "node:fs/promises"
import { renameRetry } from "@agenthub/gateway/platform"
import { z } from "zod"

const checkpointSchema = z.object({
  schema: z.literal(1), key: z.string(), position: z.number().int().nonnegative(),
  phrases: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() })
    .refine(phrase => phrase.end >= phrase.start)),
})
export type TranscriptCheckpoint = z.infer<typeof checkpointSchema>

/** The decoded input, model, language and speech filter must all match before work can be reused. */
export async function transcriptKey(pcm: string, settings: unknown, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(settings)).update("\0")
  for await (const chunk of createReadStream(pcm, { signal })) hash.update(chunk)
  return hash.digest("hex")
}

export async function readTranscriptCheckpoint(path: string, key: string, total: number): Promise<TranscriptCheckpoint> {
  try {
    if ((await stat(path)).size <= 16 * 1024 * 1024) {
      const parsed = checkpointSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
      if (parsed.success && parsed.data.key === key && parsed.data.position <= total &&
        parsed.data.phrases.every(phrase => phrase.end <= parsed.data.position / 16000)) return parsed.data
    }
  } catch { /* Missing, corrupt or obsolete checkpoints are rebuilt from the original audio. */ }
  return { schema: 1, key, position: 0, phrases: [] }
}

/** Kept beside the recording and removed with its audio retention. Never replace the last good checkpoint partially. */
export async function saveTranscriptCheckpoint(path: string, checkpoint: TranscriptCheckpoint): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(JSON.stringify(checkpoint)); await file.sync() } finally { await file.close() }
    await renameRetry(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
