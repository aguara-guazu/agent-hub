import { UsageNotices, usageWakeText } from './usage-notices.js'
import { inspectNativeProcess } from '@agenthub/gateway'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findExtractionCli } from './cli-extraction.js'
import { LocalChat } from './local-chat.js'
import { teamBootstrap } from './local-chat-team.js'

const exec = promisify(execFile)
export const chatWakeText = (ids: string[]) => `Agent Hub: tenés menciones o avisos privados pendientes (${ids.join(', ')}). Leé memory_chat_inbox con tu session_key antes de continuar y verificá team.leader_id. Para menciones respondé en su hilo; para avisos privados de estado pedile al agente que se reporte en el Hub, usando work_thread_id si está disponible. Nunca leas la terminal, salida, logs ni transcripción de otro agente. Usá memory_chat_ack con el id recibido sólo cuando hayas atendido el pedido. No hagas polling ni envíes respuestas automáticas sin contenido.`

/** Only the local Hub owns the dispatcher. No inference process is created to listen. */
export class LocalChatRuntime {
  private timer?: ReturnType<typeof setInterval>
  private running: Promise<void> | undefined
  private stopped = false
  private watchers = new Map<string,{ started:string; controller:AbortController }>()
  private controllers = new Set<AbortController>()
  constructor(readonly chat: LocalChat, private queue = async (nativeId: string, text: string) => {
    const binary = findExtractionCli('codex_cli')
    if (!binary) throw new Error('Codex CLI no está instalado')
    // No shell and no incoming message body in the command. Keep the existing CLI's approvals intact.
    const js = binary.endsWith('.js')
    await exec(js ? process.execPath : binary, [...(js ? [binary] : []),'queue','--thread',nativeId,'--message',text],
      { timeout: 15000, maxBuffer: 65536, windowsHide: true, env: { ...process.env, ...(js ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } })
  }, private enabled: (agentId:string) => boolean = () => true,
  private inspectProcess:typeof inspectNativeProcess = inspectNativeProcess) {}
  start() {
    if (this.timer) return
    this.chat.events.on('change',this.kick)
    this.timer = setInterval(this.kick,5000); this.timer.unref(); this.kick()
  }
  private kick = () => {
    if (!this.stopped && !this.running) this.running = this.tick().catch(() => {}).finally(() => { this.running = undefined })
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.chat.events.off('change',this.kick)
    for (const c of this.controllers) c.abort()
    await this.running
  }
  async tick() {
    // PID birth time prevents a recycled PID from keeping a dead session online.
    const processes = await this.chat.db.query('SELECT s.id,s.process_id,s.process_started FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.closed_at IS NULL AND c.closed_at IS NULL AND s.process_id IS NOT NULL')
    for (const s of processes) {
      const live=await this.inspectProcess(s.process_id)
      if(live===undefined)continue
      if(live && !s.process_started)continue // No birth identity: a live PID cannot prove replacement.
      if(live && live.started===s.process_started) {
        await this.chat.db.query('UPDATE chat_sessions SET lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[s.id,new Date(Date.now()+90000).toISOString()])
      } else {
        await this.chat.closeTurnForPid(s.id)
        await this.chat.db.query("UPDATE chat_sessions SET state='offline',closed_at=now() WHERE id=$1",[s.id])
      }
    }
    await this.chat.processTurnAlerts()
    // Native queue addresses the exact conversation and verifies it at delivery time.
    // A managed app-server may not expose a per-TUI PID to hooks; its idle lease is
    // advisory presence, not a reason to silently suppress durable notifications.
    const sessions = await this.chat.db.query(`SELECT s.* FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
      WHERE s.capability='codex_queue' AND s.native_id IS NOT NULL AND s.state='idle' AND s.closed_at IS NULL AND c.closed_at IS NULL
      AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL)
      AND (EXISTS(SELECT 1 FROM chat_deliveries d WHERE d.recipient_id=s.id AND d.read_at IS NULL AND d.cancelled_at IS NULL AND d.next_attempt_at<=now() AND d.attempts<5)
        OR EXISTS(SELECT 1 FROM chat_status_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.handled_at IS NULL AND n.cancelled_at IS NULL AND n.notified_at IS NULL AND n.next_attempt_at<=now() AND n.attempts<5) OR EXISTS(SELECT 1 FROM usage_quota_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.next_attempt_at<=now() AND n.attempts<5))`)
    for (const s of sessions) {
      if (this.stopped) return
      if (!this.enabled(s.agent_id)) continue
      const deliveries = await this.claim(s.id)
      const quota=new UsageNotices(this.chat),notices=await quota.claim(s.id)
      if (!deliveries.length && !notices.length) continue
      try {
        await this.queue(s.native_id,[deliveries.length?chatWakeText(deliveries.map(d=>d.message_id)):'',notices.length?usageWakeText:''].filter(Boolean).join('\n'))
        await quota.notified(s.id,notices.map(n=>String(n.id)))
        await this.notified(s.id,deliveries.map(d=>d.message_id))
      } catch {
        await this.chat.db.query('UPDATE chat_sessions SET wake_error=$2 WHERE id=$1',[s.id,'No se pudo notificar con codex queue; comprobá versión, sesión y conexión. Se reintentará hasta 5 veces.'])
        for (const d of deliveries) {
          const table=d.kind==='status_notice'?'chat_status_notices':'chat_deliveries',column=d.kind==='status_notice'?'id':'message_id'
          await this.chat.db.query(`UPDATE ${table} SET error='No se pudo notificar a la CLI' WHERE recipient_id=$1 AND ${column}=$2 AND cancelled_at IS NULL`,[s.id,d.message_id])
        }
      }
    }
    const newcomers=await this.chat.db.query(`SELECT s.* FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE c.leader_id IS NOT NULL AND c.closed_at IS NULL AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND s.team_seen=0 AND s.bootstrap_attempts<5 AND (s.bootstrap_sent_at IS NULL OR s.bootstrap_sent_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')) AND s.closed_at IS NULL AND s.state='idle' AND s.capability='codex_queue' AND s.native_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM chat_deliveries d WHERE d.recipient_id=s.id AND d.read_at IS NULL AND d.cancelled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM chat_status_notices n WHERE n.recipient_id=s.id AND n.read_at IS NULL AND n.cancelled_at IS NULL)`)
    for(const s of newcomers) {
      if(!this.enabled(s.agent_id))continue
      if(!await this.claimBootstrap(s.id))continue
      try {await this.queue(s.native_id,teamBootstrap)}catch{await this.chat.db.query("UPDATE chat_sessions SET wake_error='No se pudo iniciar el registro automático' WHERE id=$1",[s.id])}
    }
  }
  private async claimBootstrap(sid:string) {
    return (await this.chat.db.query(`UPDATE chat_sessions SET bootstrap_sent_at=now(),bootstrap_attempts=bootstrap_attempts+1
      WHERE id=$1 AND team_seen=0 AND bootstrap_attempts<5 AND state='idle' AND closed_at IS NULL
      AND (bootstrap_sent_at IS NULL OR bootstrap_sent_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds')) RETURNING id`,[sid])).length>0
  }
  private async claim(sid: string) {
    return this.chat.db.transaction(async()=>{
      await this.chat.cancelInvalidTurnAlerts()
      const mentions=await this.chat.db.query(`UPDATE chat_deliveries SET attempts=attempts+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(300,30*(attempts+1))||' seconds')
      WHERE recipient_id=$1 AND read_at IS NULL AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=$1 AND s.closed_at IS NULL AND s.removed_at IS NULL AND s.state='idle') AND attempts<5 AND next_attempt_at<=now() RETURNING message_id`,[sid])
      const notices=await this.chat.db.query(`UPDATE chat_status_notices SET attempts=attempts+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(300,30*(attempts+1))||' seconds')
        WHERE recipient_id=$1 AND read_at IS NULL AND handled_at IS NULL AND cancelled_at IS NULL AND notified_at IS NULL
        AND EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=$1 AND s.closed_at IS NULL AND s.removed_at IS NULL AND s.state='idle')
        AND attempts<5 AND next_attempt_at<=now() RETURNING id AS message_id`,[sid])
      return [...mentions.map(d=>({message_id:String(d.message_id),kind:'mention'})),...notices.map(d=>({message_id:String(d.message_id),kind:'status_notice'}))]
    })
  }
  private async notified(sid: string, ids: string[]) {
    for (const id of ids) {
      await this.chat.db.query('UPDATE chat_deliveries SET notified_at=COALESCE(notified_at,now()),error=NULL WHERE recipient_id=$1 AND message_id=$2 AND cancelled_at IS NULL',[sid,id])
      await this.chat.db.query('UPDATE chat_status_notices SET notified_at=COALESCE(notified_at,now()),error=NULL WHERE recipient_id=$1 AND id=$2 AND cancelled_at IS NULL',[sid,id])
    }
    await this.chat.db.query('UPDATE chat_sessions SET wake_error=NULL WHERE id=$1',[sid])
  }
  /** Native asyncRewake hook, not a model tool. HTTP waits are renewed without consuming context. */
  async wait(sid: string, signal?: AbortSignal, started = new Date().toISOString()) {
    const previous = this.watchers.get(sid)
    if (previous && previous.started > started) return { closed:true,messages:[] }
    previous?.controller.abort()
    const controller = new AbortController(); this.controllers.add(controller)
    this.watchers.set(sid,{started,controller})
    const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{ once:true })
    if (signal?.aborted || this.stopped) controller.abort()
    const deadline = Date.now()+25000
    try {
      while (!controller.signal.aborted && Date.now()<deadline) {
        const s = (await this.chat.db.query('SELECT s.*,c.leader_id,c.orca_workspace_id,c.closed_at AS channel_closed_at,c.kind AS channel_kind,c.activated_at FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.id=$1',[sid]))[0]
        if (!s || s.closed_at || s.channel_closed_at || !this.enabled(s.agent_id)) return { closed:true, messages:[] }
        if (s.state === 'idle') {
          if(s.leader_id && await this.claimBootstrap(sid)) {
            return {messages:[],bootstrap:true,context:teamBootstrap}
          }
          const deliveries = await this.claim(sid)
          const quota=new UsageNotices(this.chat),notices=await quota.claim(sid)
          if (deliveries.length || notices.length) {
            const ids = deliveries.map(d=>String(d.message_id)); await this.notified(sid,ids)
            await quota.notified(sid,notices.map(n=>String(n.id)))
            return { messages:[...ids,...notices.map(n=>String(n.id))], context:[ids.length?chatWakeText(ids):'',notices.length?usageWakeText:''].filter(Boolean).join('\n') }
          }
        }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); this.chat.events.off('change',finish); controller.signal.removeEventListener('abort',finish); resolve() }
          const timer = setTimeout(finish,Math.min(5000,Math.max(1,deadline-Date.now())))
          this.chat.events.once('change',finish); controller.signal.addEventListener('abort',finish,{once:true})
          if (controller.signal.aborted) finish()
        })
      }
      return { messages:[], ...(this.watchers.get(sid)?.started !== started ? {closed:true} : {}) }
    } finally { signal?.removeEventListener('abort',abort); this.controllers.delete(controller) }
  }
}
