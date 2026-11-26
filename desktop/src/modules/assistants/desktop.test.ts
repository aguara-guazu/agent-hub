import { expect, it, vi } from 'vitest'
import { assistantFeed } from './desktop.js'
import { allowedRoute } from '../../navigation.js'

it('opens only a Hub conversation and acknowledges the displayed revision after presentation', async () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const notice = { id, revision: 4, route: '/assistants/' + id, title: 'Atlas 8/10', body: 'Entrega' }
  const show = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  let ack = 0
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (_path.endsWith('/claim')) {
      expect(JSON.parse(String(init?.body)).consumer).toMatch(/^[a-f0-9-]{36}$/)
      return Response.json({ items: ack >= 2 ? [] : [notice] })
    }
    expect(JSON.parse(String(init?.body))).toEqual({ revision: 4 })
    return new Response('', { status: ++ack === 1 ? 503 : 200 })
  })
  const feed = assistantFeed(fetcher, show, () => true)
  await feed.poll()
  expect(ack).toBe(0)
  await Promise.all([feed.poll(), feed.poll()])
  await feed.poll()
  expect(ack).toBe(2)
  expect(show).toHaveBeenCalledTimes(2)
  expect(allowedRoute('/assistants?notice=' + id)).toBeTruthy()
  expect(allowedRoute(notice.route)).toBe(notice.route)
  expect(allowedRoute('/assistants?project=' + id)).toBeTruthy()
  expect(allowedRoute('/assistants/' + id + '?next=https://example.invalid')).toBeNull()
  feed.close()
  await feed.poll()
  expect(ack).toBe(2)
})
