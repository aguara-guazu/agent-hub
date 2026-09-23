// A real child/server speaking the small OpenCode API surface used by the worker.
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
let pending = [], waiting
function answer(res, content) {
  res.end(JSON.stringify({ info: { [content.scenario === 'legacy' ? 'structured_output' : 'structured']: content.code ? { code: content.code } : { facts: content.facts ?? [] },
    tokens: { input: 10, output: 5, cache: { read: 2, write: 3 } } } }))
}
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
  else if (req.url === '/permission') res.end(JSON.stringify(pending))
  else if (req.url === '/permission/per_fixture/reply') {
    if (body.reply !== 'reject') { res.writeHead(400).end('{}'); return }
    pending = []; res.end('true'); answer(waiting, { facts: ['evidence'] })
  }
  else if (req.method === 'DELETE') res.end('true')
  else if (req.url.endsWith('/message')) {
    const content = JSON.parse(body.parts[0].text)
    if (content.scenario === 'timeout') return
    if (content.scenario === 'crash') process.exit(1)
    if (content.scenario === 'invalid') { res.end(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'not JSON' }] })); return }
    if (content.scenario === 'error') { res.end(JSON.stringify({ info: { error: { message: 'SECRET from provider' } } })); return }
    if (['text', 'malformed', 'wrong_schema', 'structured_text'].includes(content.scenario)) {
      const text = content.scenario === 'malformed' ? 'not JSON' : JSON.stringify({ facts: content.scenario === 'wrong_schema' ? [123] : ['evidence'] })
      const error = body.format ? content.scenario === 'structured_text' ? { name: 'StructuredOutputError' }
        : { name: 'APIError', data: { statusCode: 400, isRetryable: false, message: 'only auto is supported for tool_choice' } } : undefined
      res.end(JSON.stringify({ info: { error }, parts: [{ type: 'text', text }] })); return
    }
    if (content.error) { res.end(JSON.stringify({ info: { error: content.error } })); return }
    if (content.scenario === 'permission') { waiting = res; pending = [{ id: 'per_other', sessionID: 'ses_other' }, { id: 'per_fixture', sessionID: 'ses_fixture', permission: 'bash' }]; return }
    answer(res, body.format?.schema.properties.code ? { code: 'AGENTHUB_OK' } : content)
  } else res.writeHead(404).end('{}')
})
server.listen(0, '127.0.0.1', () => { if (!process.env.FIXTURE_NO_START) console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`) })
