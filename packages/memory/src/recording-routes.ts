import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { id, parse } from "./contracts.js"
import { deleteRecordingAudio, listRecordings, recordingSettings, registerRecording } from "./recordings.js"
import type { MemoryStore } from "./store.js"
import type { UpcomingEvents } from "./upcoming-events.js"

/** Owner-only routes of local meeting recordings; the desktop app registers a recording once it stops capturing. */
export function registerRecordingRoutes(app: FastifyInstance, context: () => Promise<{ store: MemoryStore; directory: string }>, upcoming: UpcomingEvents, authorize: (request: FastifyRequest) => Promise<unknown>) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  app.get("/api/memory/recordings", { preHandler: auth }, async () => listRecordings((await context()).store))
  app.get("/api/memory/recordings/upcoming", { preHandler: auth }, async () => ({ settings: await recordingSettings((await context()).store), events: await upcoming.list() }))
  app.post("/api/memory/recordings", { preHandler: auth, bodyLimit: 262_144 }, async (request, reply) => {
    const { store, directory } = await context()
    return reply.code(201).send(await registerRecording(store, directory, request.body))
  })
  app.delete("/api/memory/recordings/:id/audio", { preHandler: auth }, async request => {
    const { id: recordingId } = parse(z.object({ id }).strict(), request.params)
    return deleteRecordingAudio((await context()).store, recordingId)
  })
}
