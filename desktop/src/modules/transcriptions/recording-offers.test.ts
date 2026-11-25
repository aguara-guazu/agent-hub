import { expect, it } from "vitest"
import { RecordingOffers, type UpcomingEvent } from "./recording-offers.js"

const hour = (time: string) => `2026-11-25T${time}:00.000Z`

function event(key: string, start: string, end: string): UpcomingEvent {
  return { key, connector_id: "test-calendar", calendar: "primary", event_id: key, title: key,
    start: hour(start), end: hour(end), platform: "Zoom", attendees: [] }
}

it("matches a manual start after the opening offer expired, even if the calendar arrived later", () => {
  const offers = new RecordingOffers()
  const meeting = event("first", "14:30", "14:55")
  const started = Date.parse(hour("14:49"))
  expect(offers.matchAt(started)).toEqual([])
  offers.update({ events: [meeting] })
  expect(offers.open(started)).toEqual([])
  expect(offers.matchAt(started)).toEqual([meeting])
  offers.accept(meeting.key)
  expect(offers.matchAt(started)).toEqual([meeting])
  offers.dismiss(meeting.key)
  expect(offers.matchAt(started)).toEqual([])
})

it("offers both adjacent events within the notification lead time and excludes an event at its exact end", () => {
  const offers = new RecordingOffers()
  const first = event("first", "14:30", "14:55")
  const second = event("second", "14:55", "15:30")
  offers.update({ events: [first, second], settings: { notify: false, lead_minutes: 2 } })
  expect(offers.matchAt(Date.parse(hour("14:52")))).toEqual([first])
  expect(offers.matchAt(Date.parse(hour("14:54")))).toEqual([first, second])
  expect(offers.matchAt(Date.parse(hour("14:55")))).toEqual([second])
})

it("keeps upcoming offers, calendar matching and notifications empty while recording is off", () => {
  const offers = new RecordingOffers()
  const meeting = event("first", "14:30", "14:55")
  const now = Date.parse(hour("14:31"))
  offers.update({ events: [meeting] })
  offers.update({ settings: { enabled: false }, events: [meeting] })
  expect(offers.get(meeting.key)).toBeUndefined()
  expect(offers.open(now)).toEqual([])
  expect(offers.due(now)).toEqual([])
  expect(offers.matchAt(now)).toEqual([])
  offers.update({ settings: { enabled: true }, events: [meeting] })
  expect(offers.due(now)).toEqual([meeting])
})
