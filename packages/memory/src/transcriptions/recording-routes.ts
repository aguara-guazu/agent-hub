import type { ModuleEnabled } from "@agenthub/shared/modules"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { id, parse } from "../contracts.js"
import { deleteRecordingAudio, listRecordings, recordingSettings, recordingSettingsInput, recordingSettingsPatch, registerRecording } from "./recordings.js"
import type { MemoryStore } from "../store.js"
import type { UpcomingEvents } from "./upcoming-events.js"
import { decideVoice, listPendingVoices } from "./voice-naming.js"

/** Owner-only routes of local meeting recordings; the desktop app registers a recording once it stops capturing. */
export function registerRecordingRoutes(app: FastifyInstance, context: () => Promise<{ store: MemoryStore; directory: string }>, upcoming: UpcomingEvents, authorize: (request: FastifyRequest) => Promise<unknown>, enabled: ModuleEnabled = () => true) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  const effectiveSettings = async () => {
    const settings = await recordingSettings((await context()).store)
    return { ...settings, enabled: settings.enabled && enabled('transcriptions') }
  }
  app.get("/api/memory/recordings", { preHandler: auth }, async () => listRecordings((await context()).store))
  app.get("/api/memory/recordings/upcoming", { preHandler: auth }, async () => {
    const settings = await effectiveSettings()
    if (!settings.enabled || !enabled('connections')) return { settings, events: [], verifiedCalendars: [] }
    return { settings, events: await upcoming.list(), verifiedCalendars: upcoming.verifiedCalendars }
  })
  app.post("/api/memory/recordings", { preHandler: auth, bodyLimit: 262_144 }, async (request, reply) => {
    const { store, directory } = await context()
    return reply.code(201).send(await registerRecording(store, directory, request.body))
  })
  app.get("/api/memory/recordings/settings", { preHandler: auth }, effectiveSettings)
  app.put("/api/memory/recordings/settings", { preHandler: auth, bodyLimit: 4096 }, async request => {
    const patch = parse(recordingSettingsPatch, request.body), { store } = await context()
    const [row] = await store.db.query("INSERT INTO settings(key,value) VALUES('recording',$1) ON CONFLICT(key) DO UPDATE SET value=json_patch(settings.value,excluded.value) RETURNING value", [JSON.stringify(patch)])
    return parse(recordingSettingsInput, row!.value)
  })
  app.get("/api/memory/recordings/voices", { preHandler: auth }, async () => {
    const { store } = await context()
    return (await recordingSettings(store)).enabled ? listPendingVoices(store) : { items: [] }
  })
  app.post("/api/memory/recordings/:id/voices/:voice", { preHandler: auth, bodyLimit: 4096 }, async request => {
    const { id: recordingId, voice } = parse(z.object({ id, voice: z.coerce.number().int().min(1).max(1000) }).strict(), request.params)
    return decideVoice((await context()).store, recordingId, voice, request.body)
  })
  app.delete("/api/memory/recordings/:id/audio", { preHandler: auth }, async request => {
    const { id: recordingId } = parse(z.object({ id }).strict(), request.params)
    return deleteRecordingAudio((await context()).store, recordingId)
  })
}
