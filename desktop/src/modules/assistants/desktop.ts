import { randomUUID } from 'node:crypto'

interface Notice {
  id: string
  revision: number
  delivery_id?: string
  route: string
  title: string
  body: string
}

export function assistantFeed(
  coreFetch: (path: string, init?: RequestInit) => Promise<Response>,
  show: (notice: Notice) => boolean,
  available: () => boolean,
) {
  const consumer = randomUUID()
  let timer: NodeJS.Timeout | undefined,
    polling: Promise<void> | undefined,
    stopped = false,
    presented: Notice | undefined
  const post = (path: string, body: unknown) =>
    coreFetch('/api/assistants/notices/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  async function acknowledge() {
    if (!presented) return true
    const ack = await post(presented.id + '/seen', { revision: presented.revision, delivery_id: presented.delivery_id })
    if (ack.ok) presented = undefined
    return ack.ok
  }
  async function read() {
    // Retry the receipt before claiming another interruption, including when its subject has since been resolved.
    if (!(await acknowledge()) || stopped || !available()) return
    const response = await post('claim', { consumer })
    if (!response.ok || stopped || !available()) return
    const { items } = (await response.json()) as { items: Notice[] }
    const notice = items[0]
    if (!notice || !show(notice)) return
    presented = notice
    await acknowledge()
  }
  function poll() {
    if (!available() || stopped) return Promise.resolve()
    polling ??= read()
      .catch(() => {})
      .finally(() => {
        polling = undefined
      })
    return polling
  }
  return {
    poll,
    start() {
      stopped = false
      timer ??= setInterval(() => void poll(), 15_000).unref()
      void poll()
    },
    close() {
      stopped = true
      clearInterval(timer)
      timer = undefined
    },
  }
}
