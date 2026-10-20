import { launchQuotaHookProbe } from './usage-quota-hook.js'
import { createHmac } from 'node:crypto'
import { inspectNativeProcess, orcaWorkspaceId } from '@agenthub/gateway'
import type { DaemonState } from './state.js'

/** Only a real CLI ancestor is a liveness witness. Shared daemons are deliberately excluded. */
export async function cliProcess(kind: string): Promise<{ process_id: number; process_started: string } | undefined> {
  let pid = process.ppid
  for (let i=0; i<8 && pid>1; i++) {
    const info=await inspectNativeProcess(pid)
    if(!info)return undefined
    const name=kind==='claude_code'?'claude':kind==='codex_cli'?'codex':''
    const invocation=info.command.split(/\s+-c\s+/)[0]!
    if(name && new RegExp(`(?:^|[/\\\\])${name}(?:\\.exe)?(?:\\s|$)`).test(invocation) && !/\b(daemon|app-server|queue)\b/.test(invocation))
      return {process_id:pid,process_started:info.started}
    pid=info.parent
  }
  return undefined
}

export async function localChatHook(state: DaemonState, agentId: string, kind: string, raw: Record<string, any>, override?: string): Promise<{ output?: Record<string, unknown>; error?: string; code?: number }> {
  if(process.env.AGENTHUB_TUI_SESSION && process.env.AGENTHUB_TUI_AGENT===agentId)return {}
  const credentials = state.loadCredentials(), snapshot = state.loadSnapshot(agentId)
  if (!credentials || !snapshot) return {}
  const servers = snapshot['servers'] as { tools?: { name:string }[] }[] | undefined
  if (!servers?.some(s=>s.tools?.some(t=>t.name==='chat_join'))) return {}
  const nativeId = raw.session_id ?? raw.sessionID ?? raw.conversationId
  const cwd = raw.cwd ?? raw.workspacePaths?.[0], originalEvent = override ?? raw.hook_event_name
  const event = originalEvent==='PreInvocation' ? 'BeforeAgent' : originalEvent
  if (typeof nativeId !== 'string' || !nativeId || typeof cwd !== 'string' || !cwd || !event) return {}
  if (kind==='antigravity' && event==='Stop' && raw.fullyIdle!==true) return {}
  // A stable routing capability per native conversation, never the daemon credential itself.
  const sessionKey = createHmac('sha256',credentials.token).update(JSON.stringify([agentId,nativeId])).digest('hex')
  const url = new URL(credentials.controlPlaneUrl)
  // Native waking is a local-machine capability; never transmit this endpoint to a remote control plane.
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return {}
  url.pathname = '/api/memory/chat/native'; url.search=''; url.hash=''
  const watchStarted = new Date().toISOString()
  const base = { agent_id:agentId, native_id:nativeId, cwd, orca_workspace_id:orcaWorkspaceId(), session_key:sessionKey, ...(event==='Watch' ? {watch_started:watchStarted}: {}) }
  const processInfo = ['SessionStart','UserPromptSubmit','Stop','Watch'].includes(event) ? await cliProcess(kind) : undefined
  const send = async (name: string, timeout=1800) => {
    const response = await fetch(url,{ method:'POST', headers:{ Authorization:`Bearer ${credentials.token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ ...base,event:name,at:new Date().toISOString(),...processInfo }), signal:AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(String(response.status))
    return await response.json() as any
  }
  if (event==='Watch' && kind==='claude_code') {
    // Held by the native asyncRewake hook. No model polling and no detached orphan shell.
    // The native host kills this process when the conversation ends.
    for (;;) {
      try {
        const result = await send('Watch',30000)
        if (result.closed || result.session?.closed_at) return {}
        if (result.messages?.length || result.bootstrap) return { error:`${result.context}\nTu session_key es ${sessionKey}.`, code:2 }
      } catch (error) {
        if (['401','403','404','409','410'].includes((error as Error).message)) return {}
        await new Promise(resolve=>setTimeout(resolve,5000))
      }
    }
  }
  try {
    const result = await send(event)
    if(kind==='codex_cli' && ['SessionStart','Stop'].includes(event) && processInfo)launchQuotaHookProbe(state,agentId,nativeId,cwd,processInfo)
    if (['SessionStart','UserPromptSubmit','BeforeAgent','PreToolUse','BeforeTool'].includes(event)) {
      const waiting=result.channel.kind==='virtual' && !result.channel.activated_at
      const context = waiting
        ? `Agent Hub · conexión local preparada en ${result.channel.path}, sin canal activo. Tu identidad es ${result.session.label} (${result.session.id}) y tu session_key es ${sessionKey}. No crees un canal silenciosamente: usá memory_chat_create_channel sólo si la persona pide explícitamente un canal virtual descartable. Leé la skill local-collaboration. El Hub escucha en segundo plano sin consumir turnos; no hagas polling.`
        : `Agent Hub · colaboración local. Tu identidad es ${result.session.label} (${result.session.id}), canal ${result.channel.id} (${result.channel.path}). Tu session_key es ${sessionKey}; usala en todas las herramientas memory_chat_*. Consultá memory_chat_join con tu session_key; si needs_nickname es true, inventá tu propio nick único con memory_chat_set_nick antes de escribir. Conservá el nick al reanudar. Leé la skill local-collaboration. Al comenzar cada turno leé memory_chat_inbox, atendé mensajes dentro del alcance autorizado y respondé en el hilo. ${result.team?.guidance ?? ''} El Hub escucha en segundo plano: no hagas polling ni crees subagentes para escuchar. ${result.pending.length ? `Hay ${result.pending.length} menciones sin leer: leelas antes de continuar.` : ''}`
      // Do not repeat the full bootstrap before every ordinary tool call.
      if (event==='SessionStart' || event==='UserPromptSubmit' || event==='BeforeAgent' || result.pending.length) {
        if(kind==='antigravity')return originalEvent==='PreInvocation' ? {output:{injectSteps:[{ephemeralMessage:context}]}} : {}
        return { output:{ hookSpecificOutput:{ hookEventName:event, additionalContext:context } } }
      }
    }
  } catch (error) {
    if ((error as Error).message==='409' && ['SessionStart','UserPromptSubmit','BeforeAgent'].includes(event)) {
      const context='Agent Hub: no se registró colaboración local porque la ubicación no está disponible, el canal fue cerrado o la ruta Git no es un worktree válido. No hagas polling ni inicialices Git automáticamente para eludir el rechazo.'
      if(kind==='antigravity')return originalEvent==='PreInvocation' ? {output:{injectSteps:[{ephemeralMessage:context}]}} : {}
      return {output:{hookSpecificOutput:{hookEventName:event,additionalContext:context}}}
    }
    // Offline Hub must not break a CLI turn or imply registration succeeded. Next event retries.
  }
  return {}
}
