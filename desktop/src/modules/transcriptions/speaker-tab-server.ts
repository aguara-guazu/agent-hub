import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { activeLanguage, t } from "../../i18n.js"

const MAX_FRAME_BYTES = 3_000_000
const key = () => randomBytes(24).toString("hex")

function page() {
  return `<!doctype html><html lang="${activeLanguage()}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t("tray.recordTab")} · Agent Hub</title><style>
:root{color-scheme:light dark;font:16px/1.5 system-ui}body{margin:8vh auto;padding:0 24px;max-width:48rem}
h1{font-size:1.6rem}button{font:inherit;padding:.45em .9em;margin:0 .45em .45em 0;cursor:pointer}
canvas{display:block;max-width:100%;max-height:68vh;cursor:crosshair;touch-action:none}
</style><main><h1>${t("tray.recordTab")}</h1><p>${t("recording.tabHint")}</p>
<button id="start">${t("recording.tabShare")}</button><button id="region" hidden>${t("recording.markSpeaker")}</button>
<button id="stop" hidden>${t("recording.tabStop")}</button>
<p id="status" role="status" data-sharing="${t("recording.tabSharing")}" data-stopped="${t("recording.tabStopped")}" data-ended="${t("recording.tabEnded")}" data-fallback="${t("recording.tabFallback")}" data-mark="${t("recording.markHint")}" data-busy="${t("recording.tabBusy")}" data-ocr="${t("recording.tabOcrFailed")}"></p>
</main><script src="speaker-tab.js" defer></script></html>`
}

/** Ephemeral loopback session for the browser's own tab picker. The URL is scoped to one recording and source selection. */
export async function openSpeakerTab(scriptPath: string, onFrame: (at: number, tile: boolean, image: ArrayBuffer, connected: () => boolean) => Promise<boolean>) {
  const script = await readFile(scriptPath), prefix = `/${key()}/`
  let origin = "", lease = "", events: ServerResponse | undefined, processing = false
  let lastSample = 0, talking = false
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    const finish = (code: number) => { res.writeHead(code).end() }
    const path = req.url ?? ""
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob: mediastream:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), display-capture=(self)")
    if (!path.startsWith(prefix) || `http://${req.headers.host}` !== origin) return finish(404)
    if (req.headers.origin && req.headers.origin !== origin) return finish(403)
    const route = path.slice(prefix.length).split("?")[0]
    if (req.method === "GET" && route === "") { res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" }).end(page()); return }
    if (req.method === "GET" && route === "speaker-tab.js") { res.writeHead(200, { "Content-Type": "text/javascript" }).end(script); return }
    if (req.method === "GET" && route === "events") {
      if (events) return finish(409)
      lease = key(); events = res; talking = false; lastSample = 0
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(`event: ready\ndata: ${lease}\n\n`)
      res.on("close", () => { if (res === events) { events = undefined; lease = "" } })
      return
    }
    if (req.method !== "POST" || route !== "frame") return finish(404)
    if (req.headers.origin !== origin || !events || req.headers["x-hub-session"] !== lease) return finish(403)
    if (req.headers["content-type"] !== "image/png") return finish(415)
    const length = Number(req.headers["content-length"])
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_FRAME_BYTES) return finish(413)
    const params = new URL(path, origin).searchParams
    const at = Number(params.get("at")), tile = params.get("tile")
    if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 15000 || (tile !== "0" && tile !== "1")) return finish(400)
    if (processing) return finish(429)
    const session = lease
    processing = true
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      if (!lease || lease !== session) return finish(410)
      const data = Buffer.concat(chunks)
      if (data.length !== length || length < 24 || data.readUint32BE(0) !== 0x89504e47 || data.readUint32BE(4) !== 0x0d0a1a0a ||
          data.toString("ascii", 12, 16) !== "IHDR" || data.readUint32BE(16) * data.readUint32BE(20) > 6_000_000) return finish(400)
      finish(await onFrame(at, tile === "1", Uint8Array.from(data).buffer, () => lease === session) ? 204 : 503)
    } catch { if (!res.destroyed && !res.headersSent) finish(503) }
    finally { processing = false }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  if (!address || typeof address === "string") { server.close(); throw new Error("Loopback address unavailable") }
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin + prefix,
    sample(level: number) {
      if (!events) return
      const active = level > 0.001, now = Date.now()
      if (active === talking && now - lastSample < (active ? 450 : 5000)) return
      talking = active; lastSample = now
      events.write(`data: ${active ? 1 : 0} ${now}\n\n`)
    },
    close() {
      lease = ""
      events?.end(); events = undefined
      server.close()
      server.closeAllConnections()
    },
  }
}
