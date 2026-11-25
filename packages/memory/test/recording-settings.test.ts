import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { expect, it, vi } from "vitest"
import { MemoryDatabase } from "../src/database.js"
import { registerRecordingRoutes } from "../src/recording-routes.js"
import { MemoryStore } from "../src/store.js"
import { UpcomingEvents } from "../src/upcoming-events.js"
import type { GoogleAuth } from "../src/google-auth.js"

it("persists the opt-out, skips calendar access and preserves preferences sent by older clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-recording-settings-"))
  const db = new MemoryDatabase(join(directory, "memory.sqlite"))
  const app = Fastify()
  try {
    await db.migrate()
    const store = new MemoryStore(db, directory)
    const upcoming = new UpcomingEvents(async () => store, {} as GoogleAuth)
    const list = vi.spyOn(upcoming, "list").mockResolvedValue([])
    registerRecordingRoutes(app, async () => ({ store, directory }), upcoming, async () => {})
    const url = "/api/memory/recordings/settings"
    const update = async (payload: object) => {
      const response = await app.inject({ method: "PUT", url, payload })
      expect(response.statusCode).toBe(200)
      return response.json()
    }
    await db.query("INSERT INTO settings(key,value) VALUES('recording',$1)", [JSON.stringify({ notify: false, retention_days: 7 })])
    expect((await app.inject({ url })).json()).toMatchObject({ enabled: true, notify: false })
    expect(await update({ enabled: false })).toMatchObject({ enabled: false, notify: false, retention_days: 7 })
    expect(await update({ notify: true, lead_minutes: 10, retention_days: 30 })).toMatchObject({ enabled: false })
    const snapshot = await app.inject({ url: "/api/memory/recordings/upcoming" })
    expect(snapshot.json()).toMatchObject({ settings: { enabled: false }, events: [], verifiedCalendars: [] })
    expect(list).not.toHaveBeenCalled()
    expect(await update({ enabled: true })).toMatchObject({ enabled: true, notify: true, lead_minutes: 10 })
    await app.inject({ url: "/api/memory/recordings/upcoming" })
    expect(list).toHaveBeenCalledOnce()
  } finally { await app.close(); await db.close(); await rm(directory, { recursive: true, force: true }) }
})
