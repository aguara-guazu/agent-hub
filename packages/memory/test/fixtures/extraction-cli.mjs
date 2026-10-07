import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { setInterval } from 'node:timers'

const [provider, ...args] = process.argv.slice(2)
const log = value => process.stdout.write(JSON.stringify(value) + '\n')
const record = value => appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify(value) + '\n')
record({ provider, args, cwd: process.cwd(), pid: process.pid })
if (args.includes('--delete-session')) process.exit(0)
if (args.includes('--list-models')) { log({ models: [{ model_id: 'fixture', model_name: 'Fixture' }] }); process.exit(0) }
if (args.includes('app-server') || args.includes('--input-format')) {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    const event = JSON.parse(line)
    record({ event })
    if (provider === 'claude_code') log({ type: 'control_response', response: { request_id: 'models', subtype: 'success', response: { models: [{ value: 'sonnet', resolvedModel: 'fixture', displayName: 'Fixture' }] } } })
    else if (event.method === 'initialize') log({ id: event.id, result: {} })
    else if (event.method === 'model/list') log({ id: event.id, result: { data: [{ model: event.params.cursor ? 'second' : 'fixture', displayName: 'Fixture' }], nextCursor: event.params.cursor ? null : 'next' } })
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    record({ input })
    const model = args[args.indexOf('--model') + 1]
    if (model === 'hang') { setInterval(() => {}, 1000); return }
    if (model === 'auth-error' || model === 'rate-limit') {
      process.stderr.write(model === 'auth-error' ? 'Authentication failed SECRET private transcript' : '429 rate limit SECRET')
      process.exit(1)
    }
    const text = model === 'bad-json' ? 'not json' : JSON.stringify(model === 'bad-schema' ? { code: 42 } : { code: 'AGENTHUB_OK' })
    if (provider === 'claude_code') log({ subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, modelUsage: { [model]: {} } })
    else if (provider === 'codex_cli') {
      log({ type: 'item.completed', item: { type: 'agent_message', text } })
      if (model !== 'incomplete') log({ type: 'turn.completed', usage: { input_tokens: 15, output_tokens: 3 } })
    } else {
      log({ type: 'metadata', data: { sessionId: 'fixture-session' } })
      log({ type: 'runFinished', data: { status: 'success', stopReason: 'end_turn', sessionId: 'fixture-session', finalText: text, finalTextTruncated: model === 'incomplete' } })
    }
  })
}
