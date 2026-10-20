import { createHash } from 'node:crypto'
import type { UsageQuotaObservation, UsageQuotaWindow } from '@agenthub/shared'

const record=(value:unknown):Record<string,any> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,any> : {}
const finite=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value)
const epoch=(value:unknown):string|undefined=>finite(value) && value>0 && value<8.64e12 ? new Date(value*1000).toISOString() : undefined
export const quotaProvider=(cli:string)=>({codex_cli:'openai',claude_code:'anthropic',kiro:'kiro'}[cli] ?? cli)
export function unknownQuota(cli:string,adapter:string,reason:string,now=Date.now()):UsageQuotaObservation {
  return {cli,provider:quotaProvider(cli),pool_id:'subscription',observed_at:new Date(now).toISOString(),
    expires_at:new Date(now+300000).toISOString(),source:{kind:'native',adapter},model_scope:'unknown',windows:[],status:'unknown',complete:false,reason}
}
function percentWindow(id:string,raw:unknown,field:string,reset:string):UsageQuotaWindow|undefined {
  const value=record(raw),used=value[field]
  if(!finite(used) || used<0 || used>100)return undefined
  const resetsAt=epoch(value[reset])
  return {id,unit:'percent',used,limit:100,remaining:100-used,...(resetsAt?{resets_at:resetsAt}:{})}
}
/** Identity comes from a native routing ID, never an email or credential file. */
export function codexAccountId(raw:unknown):string|undefined {
  const value=record(record(raw).workspaceRouting).chatgptAccountId
  return typeof value==='string' && value.length>0 && value.length<512 ? value : undefined
}
export const opaqueQuotaAccount=(provider:string,id:string)=>createHash('sha256').update(JSON.stringify([provider,id])).digest('hex')
/** Documented app-server rate limits. Null optional windows differ from malformed windows. */
export function codexQuotas(raw:unknown,accountRef?:string,now=Date.now()):UsageQuotaObservation[] {
  const response=record(raw),byId=record(response.rateLimitsByLimitId)
  const buckets=Object.keys(byId).length ? Object.values(byId) : [response.rateLimits]
  const result:UsageQuotaObservation[]=[]
  for(const rawBucket of buckets.slice(0,50)) {
    const bucket=record(rawBucket),id=bucket.limitId
    if(typeof id!=='string' || !id || id.length>200)continue
    let complete=true
    const windows:UsageQuotaWindow[]=[]
    for(const name of ['primary','secondary']) {
      if(bucket[name]===null)continue
      const window=percentWindow(name,bucket[name],'usedPercent','resetsAt')
      if(window && (!window.resets_at || Date.parse(window.resets_at)>now)) {
        const duration=record(bucket[name]).windowDurationMins
        if(finite(duration) && duration>0)window.duration_minutes=duration
        windows.push(window)
      } else complete=false
    }
    if(!windows.length)complete=false
    const observation:UsageQuotaObservation={...unknownQuota('codex_cli','codex-app-server','native_windows_incomplete',now),
      pool_id:id,model_scope:id==='codex'?'all':'unknown',...(accountRef?{account_ref:accountRef}:{}),windows,complete,
      source:{kind:'native',adapter:'codex-app-server',reference:'https://learn.chatgpt.com/docs/app-server'}}
    delete observation.status
    if(complete)delete observation.reason
    if(typeof bucket.rateLimitReachedType==='string' && bucket.rateLimitReachedType) {observation.status='exhausted';observation.reason='native_limit_reached'}
    else if(response.ordinaryUsageAllowed===false || bucket.spendControlReached===true) {observation.complete=false;observation.reason='native_usage_unavailable'}
    result.push(observation)
  }
  return result.length ? result : [{...unknownQuota('codex_cli','codex-app-server','native_windows_unavailable',now),...(accountRef?{account_ref:accountRef}:{})}]
}
/** Statusline data is explicitly optional until the first API response. Never trigger one to measure. */
export function claudeQuotas(raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  const limits=record(record(raw).rate_limits),windows:UsageQuotaWindow[]=[]
  let complete=true
  for(const id of ['five_hour','seven_day']) {
    const window=percentWindow(id,limits[id],'used_percentage','resets_at')
    if(window && window.resets_at && Date.parse(window.resets_at)>now)windows.push({...window,duration_minutes:id==='five_hour'?300:10080})
    else complete=false
  }
  if(limits.spend_limit!==undefined) {
    const spend=percentWindow('spend_limit',limits.spend_limit,'used_percentage','resets_at')
    if(spend && spend.resets_at && Date.parse(spend.resets_at)>now)windows.push(spend);else complete=false
  }
  const observation:UsageQuotaObservation={...unknownQuota('claude_code','claude-statusline','native_windows_incomplete',now),windows,complete,model_scope:'all',
    source:{kind:'native',adapter:'claude-statusline',reference:'https://code.claude.com/docs/en/statusline'}}
  delete observation.status
  if(complete)delete observation.reason
  return [observation]
}
export function kiroUsageAdvertised(init:unknown):boolean {
  const methods=record(record(record(record(init).agentCapabilities)._meta).kiro).extensionMethods
  return Array.isArray(methods) && methods.includes('_kiro/account/getUsage')
}
/** The documented method has no published stable result schema yet. Fail closed on unknown shapes. */
export function kiroQuotas(_raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  return [unknownQuota('kiro','kiro-acp','native_usage_schema_unsupported',now)]
}
/** A native rate-limit event establishes throttling, not monthly credit exhaustion or a reset time. */
export function kiroRateLimit(now=Date.now()):UsageQuotaObservation {
  return {...unknownQuota('kiro','kiro-acp','native_rate_limit',now),status:'cooldown',expires_at:new Date(now+60000).toISOString()}
}
