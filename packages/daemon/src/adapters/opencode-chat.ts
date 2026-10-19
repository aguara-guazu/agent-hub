/** Generated plugin stays dependency-free: the broker protocol lives in the Hub executable. */
export function openCodeMemoryPlugin(command:string,args:string[],enabled:boolean,chat:boolean) {
  return `// Managed by Agent Hub. One listener per native OpenCode session.
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
export const AgentHubMemory = async ({ directory, client }) => {
  const command = ${JSON.stringify(command)}, args = ${JSON.stringify(args)}
  if (process.env.AGENTHUB_TUI_SESSION) return {}
  const sessions = new Map()
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const emit = event => { if (${JSON.stringify(enabled)}) spawnSync(command, args, { input: JSON.stringify({ cwd: directory, ...event }), env, timeout: 2500, windowsHide: true, stdio: ['pipe','ignore','ignore'] }) }
  const attach = id => {
    if (!${JSON.stringify(chat)} || !id) return Promise.resolve(null)
    if (sessions.has(id)) return sessions.get(id).ready
    const child = spawn(command, args.map(a => a === 'memory-hook' ? 'chat-bridge' : a), { env, stdio: ['pipe','pipe','ignore'], windowsHide: true })
    let resolve
    const state = { child, context: '', ready: new Promise(r => { resolve = r }) }
    sessions.set(id, state)
    const lines = createInterface({ input: child.stdout })
    const finish = () => { clearTimeout(timer); lines.close(); if (sessions.get(id) === state) sessions.delete(id); resolve(null) }
    const timer = setTimeout(() => { child.kill(); finish() }, 10000)
    child.on('error', finish); child.on('close', finish); child.stdin.on('error', finish)
    lines.on('line', line => {
      let packet
      try { packet = JSON.parse(line) } catch { return }
      if (packet.context) { clearTimeout(timer); state.context = packet.context; resolve(state) }
      if (packet.text) {
        // The SDK targets this exact session; never touch the TUI's composer or approval keys.
        void client.session.promptAsync({ path: { id }, query: { directory }, body: { parts: [{ type: 'text', text: packet.text }] } })
          .then(result => { if (result.error) throw new Error('Prompt rejected') })
          .catch(() => { /* Broker retries until the inbox is read. */ })
      }
    })
    child.stdin.write(JSON.stringify({ session_id: id, cwd: directory }) + '\\n')
    return state.ready
  }
  const lifecycle = async (id, event) => {
    const state = await attach(id)
    if (state?.child.stdin.writable) state.child.stdin.write(JSON.stringify({ event }) + '\\n')
    if (event === 'SessionEnd') { state?.child.stdin.end(); sessions.delete(id) }
  }
  const dispose = () => { for (const s of sessions.values()) { s.child.stdin.end(); s.child.kill() } sessions.clear() }
  process.once('exit', dispose)
  return {
    'chat.message': async input => { await lifecycle(input.sessionID, 'UserPromptSubmit') },
    'experimental.chat.system.transform': async (input, output) => {
      const state = await attach(input.sessionID)
      if (state?.context) output.system.push(state.context)
    },
    'tool.execute.before': async (input, output) => { if (input.tool.startsWith('hub_')) emit({ hook_event_name: 'PreToolUse', session_id: input.sessionID, tool_name: input.tool, tool_input: output.args }) },
    event: async ({ event }) => {
      const id = event.properties?.sessionID ?? event.properties?.info?.id
      if (event.type === 'server.instance.disposed') { dispose(); process.removeListener('exit', dispose); return }
      if (event.type === 'session.created') await attach(id)
      if (event.type === 'session.status' && event.properties.status?.type === 'busy') await lifecycle(id, 'HubPromptSubmit')
      if (['session.idle','session.error','session.deleted'].includes(event.type)) {
        const name = event.type === 'session.error' ? 'StopFailure' : event.type === 'session.deleted' ? 'SessionEnd' : 'Stop'
        await lifecycle(id, name)
        emit({ hook_event_name: name, session_id: id })
      }
    }
  }
}
`
}
