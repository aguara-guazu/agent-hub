import { randomUUID } from 'node:crypto'
import type { LocalChat } from './local-chat.js'

export interface QuotaNoticeEvent {
  key:string; cli:string; provider:string; pool_id:string; state:string; previous_state:string;
  observed_at:string; binding_ids:string[]
  model_ids?:string[]
  account_ref?:string
}
const activeTeam = "('launching','launched','partial','uncertain','active')"
export interface ResumptionMember { member_id:string; worktree_name:string; cli:string; model:string; result:'resumed'|'restarted'|'unsupported'|'failed'; reason:string }
export interface LeaderClosedEvent { key:string; team_id:string; observed_at:string; members:string[] }
export interface ResumptionEvent { key:string; team_id:string; observed_at:string; members:ResumptionMember[] }

/** Informational system notices: no synthetic participant, impersonated chat author or model polling. */
export class UsageNotices {
  constructor(private chat:LocalChat) {}
  private get db() { return this.chat.db }
  async publish(event:QuotaNoticeEvent,notify=true) {
    if(!['low','exhausted','cooldown'].includes(event.state) && !(event.state==='available' && ['low','exhausted','cooldown'].includes(event.previous_state)))return
    const recipients=new Map<string,{channel_id:string;direct_channel:boolean;team_ids:Set<string>}>()
    const targetFor=(recipient:string,channel:string)=>{
      let target=recipients.get(recipient)
      if(!target){target={channel_id:channel,direct_channel:false,team_ids:new Set<string>()};recipients.set(recipient,target)}
      return target
    }
    for(const binding of event.binding_ids) {
      const client=binding.replace(/:profile:[a-f0-9]{64}$/,'')
      const channels=await this.db.query(`SELECT DISTINCT c.id,c.leader_id FROM chat_channels c
        JOIN chat_sessions source ON source.channel_id=c.id AND source.agent_id=$1 AND source.cli_kind=$2
        JOIN chat_sessions leader ON leader.id=c.leader_id
        WHERE c.closed_at IS NULL AND source.closed_at IS NULL AND source.removed_at IS NULL
        AND leader.closed_at IS NULL AND leader.removed_at IS NULL`,[client,event.cli])
      for(const c of channels)targetFor(c.leader_id,c.id).direct_channel=true
      const teams=await this.db.query(`SELECT DISTINCT t.id,t.master_channel_id,t.created_by,m.model FROM chat_team_plans t
        JOIN chat_channels c ON c.id=t.master_channel_id AND c.leader_id=t.created_by AND c.closed_at IS NULL
        JOIN chat_sessions leader ON leader.id=t.created_by AND leader.closed_at IS NULL AND leader.removed_at IS NULL
        JOIN chat_team_members m ON m.team_id=t.id AND m.state='joined'
        JOIN chat_sessions source ON source.id=m.session_id AND source.agent_id=$1 AND source.cli_kind=$2
        WHERE t.state IN ${activeTeam} AND source.closed_at IS NULL AND source.removed_at IS NULL`,[client,event.cli])
      for(const t of teams)if(!event.model_ids?.length || event.model_ids.includes(t.model))targetFor(t.created_by,t.master_channel_id).team_ids.add(t.id)
    }
    for(const [recipient,target] of recipients)await this.db.query(`INSERT INTO usage_quota_notices(id,event_key,recipient_id,channel_id,team_id,payload)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,recipient_id) DO NOTHING`,
      [randomUUID(),event.key,recipient,target.channel_id,target.direct_channel?null:[...target.team_ids][0] ?? null,
        JSON.stringify({...event,routing:{direct_channel:target.direct_channel,team_ids:[...target.team_ids].sort()}})])
    if(notify && recipients.size)this.chat.events.emit('change')
  }
  /** What the Hub did for a team's members when their quota came back; one notice per team and event, addressed to the current leader. */
  async publishResumption(event:ResumptionEvent,notify=true) {
    const team=(await this.db.query(`SELECT t.created_by,t.master_channel_id FROM chat_team_plans t
      JOIN chat_channels c ON c.id=t.master_channel_id AND c.leader_id=t.created_by AND c.closed_at IS NULL
      JOIN chat_sessions leader ON leader.id=t.created_by AND leader.closed_at IS NULL AND leader.removed_at IS NULL
      WHERE t.id=$1 AND t.state IN ${activeTeam}`,[event.team_id]))[0]
    if(!team || !event.members.length)return false
    const payload={kind:'fleet_resumption',key:event.key,state:'restored',observed_at:event.observed_at,members:event.members,
      routing:{direct_channel:false,team_ids:[event.team_id]}}
    const inserted=await this.db.query(`INSERT INTO usage_quota_notices(id,event_key,recipient_id,channel_id,team_id,payload)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,recipient_id) DO NOTHING RETURNING id`,
    [randomUUID(),event.key,team.created_by,team.master_channel_id,event.team_id,JSON.stringify(payload)])
    if(notify && inserted.length)this.chat.events.emit('change')
    return inserted.length>0
  }
  /**
   * The quota came back but the team's leader session is closed, so its members wait. The person sees it as a team event; the
   * notice also reaches the leader if that same conversation is reopened. One of each per team and episode.
   */
  async publishLeaderClosed(event:LeaderClosedEvent,notify=true) {
    const team=(await this.db.query(`SELECT t.created_by,t.master_channel_id,t.objective FROM chat_team_plans t
      JOIN chat_channels c ON c.id=t.master_channel_id AND c.closed_at IS NULL WHERE t.id=$1 AND t.state IN ${activeTeam}`,[event.team_id]))[0]
    if(!team || !event.members.length)return false
    const objective=String(team.objective ?? '').replace(/\s+/g,' ').trim().slice(0,80)
    const message=`El líder del equipo «${objective}» está cerrado; reábrelo para que el equipo continúe (${event.members.join(', ')} esperan su reanudación por cuota).`
    const payload={kind:'leader_closed',key:event.key,state:'restored',observed_at:event.observed_at,members:event.members,message,
      routing:{direct_channel:false,team_ids:[event.team_id]}}
    const inserted=await this.db.query(`INSERT INTO usage_quota_notices(id,event_key,recipient_id,channel_id,team_id,payload)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,recipient_id) DO NOTHING RETURNING id`,
    [randomUUID(),event.key,team.created_by,team.master_channel_id,event.team_id,JSON.stringify(payload)])
    if(!inserted.length)return false
    await this.db.query(`INSERT INTO chat_team_events(id,team_id,type,source_channel_id,payload) VALUES($1,$2,'quota_leader_closed',$3,$4)`,
      [randomUUID(),event.team_id,team.master_channel_id,JSON.stringify({message,members:event.members,observed_at:event.observed_at})])
    if(notify)this.chat.events.emit('change')
    return true
  }
  private valid = `EXISTS(SELECT 1 FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
    WHERE s.id=usage_quota_notices.recipient_id AND s.closed_at IS NULL AND s.removed_at IS NULL
    AND c.id=usage_quota_notices.channel_id AND c.closed_at IS NULL AND c.leader_id=s.id)
    AND (json_extract(payload,'$.routing.direct_channel')=1
      OR EXISTS(SELECT 1 FROM chat_team_plans t JOIN json_each(usage_quota_notices.payload,'$.routing.team_ids') association ON association.value=t.id
        WHERE t.created_by=usage_quota_notices.recipient_id AND t.master_channel_id=usage_quota_notices.channel_id AND t.state IN ${activeTeam})
      OR (json_type(payload,'$.routing') IS NULL AND (team_id IS NULL OR EXISTS(SELECT 1 FROM chat_team_plans t WHERE t.id=usage_quota_notices.team_id
        AND t.created_by=usage_quota_notices.recipient_id AND t.state IN ${activeTeam}))))`
  async pending(recipient:string,read=false) {
    const agent=(await this.db.query('SELECT agent_id FROM chat_sessions WHERE id=$1',[recipient]))[0]
    if(!agent || !this.chat.usageEnabled(agent.agent_id))return []
    const rows=await this.db.query(`SELECT id,payload,created_at FROM usage_quota_notices WHERE recipient_id=$1
      AND read_at IS NULL AND ${this.valid} ORDER BY created_at,id LIMIT 50`,[recipient])
    if(read)for(const row of rows)await this.db.query('UPDATE usage_quota_notices SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2',[row.id,recipient])
    return rows
  }
  async claim(recipient:string) {
    const agent=(await this.db.query('SELECT agent_id FROM chat_sessions WHERE id=$1',[recipient]))[0]
    if(!agent || !this.chat.usageEnabled(agent.agent_id))return []
    return this.db.query(`UPDATE usage_quota_notices SET attempts=attempts+1,
      next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||min(300,30*(attempts+1))||' seconds')
      WHERE recipient_id=$1 AND read_at IS NULL AND notified_at IS NULL AND attempts<5 AND next_attempt_at<=now() AND ${this.valid}
      RETURNING id,payload,created_at`,[recipient])
  }
  async notified(recipient:string,ids:string[]) {
    for(const id of ids)await this.db.query('UPDATE usage_quota_notices SET notified_at=COALESCE(notified_at,now()) WHERE id=$1 AND recipient_id=$2',[id,recipient])
  }
}
export const usageWakeText = 'Agent Hub: cambió la disponibilidad de cuota de tu equipo. Consultá memory_usage_status con tu session_key para leer el estado actual y los avisos. Conservá el progreso antes de reasignar; un aviso no autoriza cambiar cuenta, modelo ni gasto. No hagas polling.'
