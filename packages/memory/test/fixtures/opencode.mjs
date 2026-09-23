// A real child/server speaking the small OpenCode API surface used by the worker.
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : undefined
  appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify({ path: req.url, method: req.method, body }) + '\n')
  if (req.headers.authorization !== `Basic ${Buffer.from(`agenthub:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) { res.writeHead(401).end(); return }
  res.setHeader('content-type', 'application/json')
  if (req.url === '/provider') res.end(JSON.stringify({ connected: ['fixture'], all: [
    { id: 'fixture', name: 'Fixture', models: { 'chat/nested': { name: 'Chat' }, old: { status: 'deprecated' } } },
    { id: 'disconnected', models: { other: {} } },
  ] }))
  else if (req.url === '/session') res.end(JSON.stringify({ id: 'ses_fixture' }))
  else if (req.method === 'DELETE') res.end('true')
  else if (req.url.endsWith('/message')) {
    const content = JSON.parse(body.parts[0].text)
    if (content.scenario === 'timeout') return
    if (content.scenario === 'crash') process.exit(1)
    if (content.scenario === 'invalid') { res.end(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'not JSON' }] })); return }
    if (content.scenario === 'error') { res.end(JSON.stringify({ info: { error: { message: 'SECRET from provider' } } })); return }
    res.end(JSON.stringify({ info: { [content.scenario === 'legacy' ? 'structured_output' : 'structured']: { facts: content.facts ?? [] },
      tokens: { input: 10, output: 5, cache: { read: 2, write: 3 } } } }))
  } else res.writeHead(404).end('{}')
})
server.listen(0, '127.0.0.1', () => { if (!process.env.FIXTURE_NO_START) console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`) })
