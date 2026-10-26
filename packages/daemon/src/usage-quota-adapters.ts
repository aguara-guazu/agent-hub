import { createHash } from 'node:crypto'
import type { UsageQuotaObservation, UsageQuotaWindow } from '@agenthub/shared'

const record=(value:unknown):Record<string,any> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,any> : {}
const finite=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value)
const epoch=(value:unknown):string|undefined=>finite(value) && value>0 && value<8.64e12 ? new Date(value*1000).toISOString() : undefined
export const quotaProvider=(cli:string)=>({codex_cli:'openai',claude_code:'anthropic',kiro:'kiro',gemini_cli:'google',antigravity:'google-antigravity',opencode:'opencode',claude_desktop:'anthropic'}[cli] ?? cli)
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
  // Without a native pool identity there is no quota observation. Do not invent a persistent placeholder.
  return result
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
/** Validated against Kiro's native getUsage result. Credits are shared, never multiplied by model count. */
export function kiroQuotas(raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  const response=record(raw),data=record(response.data)
  const base=unknownQuota('kiro','kiro-acp','native_usage_schema_unsupported',now)
  if(response.success!==true || !Array.isArray(data.usageBreakdowns))return [base]
  const windows:UsageQuotaWindow[]=[]
  let complete=data.overagesEnabled===false && Array.isArray(data.bonusCredits) && data.bonusCredits.length===0 && Array.isArray(data.addOnCredits) && data.addOnCredits.length===0
  const reset=typeof data.billingCycleReset==='string' && /^\d{4}-\d{2}-\d{2}$/.test(data.billingCycleReset)?new Date(data.billingCycleReset+'T00:00:00Z').toISOString():undefined
  for(const row of data.usageBreakdowns.slice(0,30)) {
    if(row.resourceType!=='CREDIT' || row.hasLimit!==true || !finite(row.used) || row.used<0 || !finite(row.limit) || row.limit<0){complete=false;continue}
    windows.push({id:'monthly-credits',unit:'credits',used:row.used,limit:row.limit,remaining:Math.max(0,row.limit-row.used),...(reset?{resets_at:reset}:{})})
  }
  // Bonus/add-on pools and paid overages are alternatives, not simultaneous constraints.
  // Until their applicability is known, show the base measurement without declaring exhaustion.
  if(!complete)return [{...base,model_scope:'unknown',windows,reason:'additional_capacity_unverified'}]
  if(windows.length!==1)return [base]
  delete base.status;delete base.reason
  return [{...base,model_scope:'all',windows,complete:true}]
}

/** Google reports remainingFraction, including 1 when remainingAmount is omitted. */
export function googleQuotas(raw:unknown,cli:'gemini_cli'|'antigravity',now=Date.now()):UsageQuotaObservation[] {
  const rows=record(raw).buckets
  const adapter=cli==='gemini_cli'?'gemini-quota':'antigravity-statusline'
  if(!Array.isArray(rows) || !rows.length)return [unknownQuota(cli,adapter,'native_windows_incomplete',now)]
  const grouped=new Map<string,UsageQuotaObservation>()
  for(const row of rows.slice(0,100)) {
    const model=row.modelId,fraction=row.remainingFraction,reset=row.resetTime
    if(typeof model!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,150}$/.test(model))continue
    let observation=grouped.get(model)
    if(!observation){observation={...unknownQuota(cli,adapter,'native_windows_incomplete',now),pool_id:model,model_scope:cli==='gemini_cli'?'listed':'unknown',...(cli==='gemini_cli'?{model_ids:[model]}:{}),complete:true};delete observation.status;delete observation.reason;grouped.set(model,observation)}
    if(!finite(fraction) || fraction<0 || fraction>1 || typeof reset!=='string' || !Number.isFinite(Date.parse(reset)) || Date.parse(reset)<=now){observation.complete=false;observation.reason='native_windows_incomplete';continue}
    const id=typeof row.tokenType==='string' && /^[a-zA-Z0-9_-]{1,50}$/.test(row.tokenType)?row.tokenType:'quota'
    if(observation.windows.some(w=>w.id===id)){observation.complete=false;continue}
    observation.windows.push({id,unit:'percent',used:(1-fraction)*100,remaining:fraction*100,limit:100,resets_at:new Date(reset).toISOString()})
  }
  return grouped.size?[...grouped.values()]:[unknownQuota(cli,adapter,'native_windows_incomplete',now)]
}
export function antigravityQuotas(raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  return googleQuotas({buckets:Object.entries(record(record(raw).quota)).map(([modelId,value])=>({modelId,remainingFraction:record(value).remaining_fraction,resetTime:record(value).reset_time}))},'antigravity',now)
}
/** A native rate-limit event establishes throttling, not monthly credit exhaustion or a reset time. */
export function kiroRateLimit(now=Date.now()):UsageQuotaObservation {
  return {...unknownQuota('kiro','kiro-acp','native_rate_limit',now),status:'cooldown',expires_at:new Date(now+60000).toISOString()}
}

/** Structured /usage in current Claude CLI. Optional model buckets are never treated as universal balance. */
export function claudeControlQuotas(raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  const response=record(raw),limits=record(response.rate_limits)
  const source={kind:'native' as const,adapter:'claude-control',reference:'https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.301/sdk.d.ts'}
  if(response.rate_limits_available!==true)return [{...unknownQuota('claude_code','claude-control','subscription_limits_unavailable',now),source}]
  const convert=(raw:unknown)=>{const value=record(raw);return {used_percentage:value.utilization,resets_at:typeof value.resets_at==='string'?Date.parse(value.resets_at)/1000:undefined}}
  const [base]=claudeQuotas({rate_limits:{five_hour:convert(limits.five_hour),seven_day:convert(limits.seven_day)}},now)
  base!.source=source
  const result=[base!]
  const scoped=new Map<string,unknown>()
  for(const key of ['seven_day_opus','seven_day_sonnet','seven_day_oauth_apps'])if(limits[key]!=null)scoped.set(key,limits[key])
  if(Array.isArray(limits.model_scoped))for(const item of limits.model_scoped.slice(0,30)) {
    if(typeof item?.display_name==='string')scoped.set('model-'+item.display_name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,100),item)
  }
  // New servers carry authoritative rows even when the legacy model_scoped array is omitted.
  if(Array.isArray(limits.limits))for(const row of limits.limits.slice(0,30)) {
    if(['session','weekly_all'].includes(row?.kind))continue
    const label=row?.scope?.model?.display_name ?? row?.scope?.surface?.display_name ?? row?.kind
    if(typeof label==='string')scoped.set('model-'+label.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,100),{utilization:row.percent,resets_at:row.resets_at})
  }
  for(const [pool_id,value] of scoped) {
    const window=percentWindow('seven_day',convert(value),'used_percentage','resets_at')
    const valid=window?.resets_at && Date.parse(window.resets_at)>now
    result.push({...unknownQuota('claude_code','claude-control','unknown_model_scope',now),source,pool_id,complete:!!valid,
      windows:valid?[{...window!,duration_minutes:10080}]:[]})
  }
  return result
}

/** OpenCode Go's read-only usage endpoint returns three simultaneous percentage windows. */
export function opencodeQuotas(raw:unknown,now=Date.now()):UsageQuotaObservation[] {
  const usage=record(record(raw).usage),base=unknownQuota('opencode','opencode-go','native_windows_incomplete',now)
  base.pool_id='go';base.model_scope='unknown';base.windows=[];base.complete=true
  delete base.status;delete base.reason
  for(const id of ['rolling','weekly','monthly']) {
    const row=record(usage[id]),reset=row.resetsAt
    if(!finite(row.percent) || row.percent<0 || row.percent>100 || typeof reset!=='string' || !Number.isFinite(Date.parse(reset)) || Date.parse(reset)<=now){base.complete=false;base.reason='native_windows_incomplete';continue}
    base.windows.push({id,unit:'percent',used:row.percent,remaining:100-row.percent,limit:100,resets_at:new Date(reset).toISOString(),...(id==='rolling'?{duration_minutes:300}:id==='weekly'?{duration_minutes:10080}:{})})
  }
  // Go's subscription does not cover every third-party provider configured in OpenCode.
  return [base]
}
