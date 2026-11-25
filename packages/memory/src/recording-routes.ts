import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { id, parse } from "./contracts.js"
import { deleteRecordingAudio, listRecordings, recordingSettings, recordingSettingsInput, registerRecording } from "./recordings.js"
import type { MemoryStore } from "./store.js"
import type { UpcomingEvents } from "./upcoming-events.js"
import { decideVoice, listPendingVoices } from "./voice-naming.js"

/** Owner-only routes of local meeting recordings; the desktop app registers a recording once it stops capturing. */
export function registerRecordingRoutes(app: FastifyInstance, context: () => Promise<{ store: MemoryStore; directory: string }>, upcoming: UpcomingEvents, authorize: (request: FastifyRequest) => Promise<unknown>) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  app.get("/api/memory/recordings", { preHandler: auth }, async () => listRecordings((await context()).store))
  app.get("/api/memory/recordings/upcoming", { preHandler: auth }, async () => ({ settings: await recordingSettings((await context()).store), events: await upcoming.list(), verifiedCalendars: upcoming.verifiedCalendars }))
  app.post("/api/memory/recordings", { preHandler: auth, bodyLimit: 262_144 }, async (request, reply) => {
    const { store, directory } = await context()
    return reply.code(201).send(await registerRecording(store, directory, request.body))
  })
  app.get("/api/memory/recordings/settings", { preHandler: auth }, async () => recordingSettings((await context()).store))
  app.put("/api/memory/recordings/settings", { preHandler: auth, bodyLimit: 4096 }, async request => {
    const settings = parse(recordingSettingsInput, request.body), { store } = await context()
    await store.db.query("INSERT INTO settings(key,value) VALUES('recording',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(settings)])
    return settings
  })
  app.get("/api/memory/recordings/voices", { preHandler: auth }, async () => listPendingVoices((await context()).store))
  app.post("/api/memory/recordings/:id/voices/:voice", { preHandler: auth, bodyLimit: 4096 }, async request => {
    const { id: recordingId, voice } = parse(z.object({ id, voice: z.coerce.number().int().min(1).max(1000) }).strict(), request.params)
    return decideVoice((await context()).store, recordingId, voice, request.body)
  })
  app.delete("/api/memory/recordings/:id/audio", { preHandler: auth }, async request => {
    const { id: recordingId } = parse(z.object({ id }).strict(), request.params)
    return deleteRecordingAudio((await context()).store, recordingId)
  })
}
