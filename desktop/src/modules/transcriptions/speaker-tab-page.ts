import { SpeakerView } from "./speaker-view.js"

const button = (id: string) => document.getElementById(id) as HTMLButtonElement
const start = button("start"), mark = button("region"), stop = button("stop")
const status = document.getElementById("status")!
let events: EventSource | undefined, lease = "", generation = 0
function finish(message: string, expired = false) {
  generation++
  events?.close(); events = undefined; lease = ""
  view.stop()
  mark.hidden = stop.hidden = true
  start.hidden = false; start.disabled = expired
  status.textContent = message
}

const view = new SpeakerView({
  speakerStill: async () => null,
  regionDone: () => {},
  visualFailed: () => finish(status.dataset.stopped!),
  async speakerFrame(at, tile, image) {
    if (!lease) return
    const current = generation
    const response = await fetch(`frame?at=${at}&tile=${tile ? 1 : 0}`, { method: "POST",
      headers: { "Content-Type": "image/png", "X-Hub-Session": lease }, body: image })
    if (!response.ok && response.status !== 429 && current === generation) {
      finish(response.status === 503 ? status.dataset.ocr! : status.dataset.ended!, response.status !== 503)
    }
  },
})

start.onclick = async () => {
  const current = ++generation
  start.disabled = true
  try {
    await view.start(undefined, false, true)
    if (current !== generation) return
    events = new EventSource("events")
    events.addEventListener("ready", (event: MessageEvent<string>) => {
      lease = event.data
      start.hidden = true; mark.hidden = stop.hidden = false
      status.textContent = status.dataset.sharing!
    })
    events.onmessage = event => {
      const [level, at] = event.data.split(" ")
      if (Math.abs(Date.now() - Number(at)) < 1500) view.sample(level === "1" ? 1 : 0)
    }
    events.onerror = () => finish(lease ? status.dataset.ended! : status.dataset.busy!, true)
  } catch { if (current === generation) finish(status.dataset.fallback!) }
}
mark.onclick = () => view.markRegion(status.dataset.mark!)
stop.onclick = () => finish(status.dataset.stopped!)
window.addEventListener("pagehide", () => finish(status.dataset.stopped!))
