import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexQuotas, claudeQuotas, kiroQuotas, kiroUsageAdvertised, kiroRateLimit, opaqueQuotaAccount } from './usage-quota-adapters.js'
import { collectProtocolQuota, quotaProbeCompatibleArgs, quotaProfileRef, quotaProfileKey, startQuotaCollector, withQuotaLease } from './usage-quota-collector.js'
import { ChatProtocol } from './chat-protocol.js'
import type { NativeChatClient } from './local-chat-client.js'
const now=Date.parse('2026-10-20T00:00:00Z'),reset=now/1000+3600
const paths:string[]=[],processes:ChatProtocol[]=[]
afterEach(async()=>{for(const p of processes.splice(0))await p.close();for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})})
it('conserva pools/ventanas simultáneas de Codex y no convierte crédito en porcentaje',()=>{
 const result=codexQuotas({rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:90,resetsAt:reset},secondary:{usedPercent:30,resetsAt:reset+86400},credits:{balance:'999'}},other:{limitId:'other',primary:{usedPercent:0,resetsAt:reset},secondary:null}}},'opaque',now)
 expect(result).toHaveLength(2);expect(result[0]).toMatchObject({account_ref:'opaque',complete:true,windows:[{id:'primary',used:90,remaining:10},{id:'secondary',used:30,remaining:70}]})
 expect(JSON.stringify(result)).not.toContain('999')
})
it('rechaza tipos no numéricos, NaN, porcentajes imposibles y estructura vacía',()=>{
 for(const usedPercent of ['100',NaN,-1,101,null])expect(codexQuotas({rateLimits:{limitId:'codex',primary:{usedPercent},secondary:null}},undefined,now)[0]).toMatchObject({complete:false,windows:[]})
 expect(codexQuotas({},undefined,now)).toEqual([])
})
it('Claude ignora transcript/context y marca ventanas ausentes o vencidas incompletas',()=>{
 const raw={transcript_path:'SECRET',context_window:{used_percentage:90},rate_limits:{five_hour:{used_percentage:81,resets_at:reset},seven_day:{used_percentage:51,resets_at:reset+86400}}}
 expect(claudeQuotas(raw,now)[0]).toMatchObject({complete:true,windows:[{used:81},{used:51}]})
 expect(JSON.stringify(claudeQuotas(raw,now))).not.toContain('SECRET')
 expect(claudeQuotas({rate_limits:{five_hour:{used_percentage:100,resets_at:reset-7200}}},now)[0]).toMatchObject({complete:false,windows:[]})
 expect(claudeQuotas({context_window:{used_percentage:100}},now)[0]?.windows).toEqual([])
})
it('Kiro negocia método exacto, no adivina schema y rate-limit no declara saldo mensual agotado',()=>{
 expect(kiroUsageAdvertised({agentCapabilities:{_meta:{kiro:{extensionMethods:['_kiro/account/getUsage']}}}})).toBe(true)
 expect(kiroUsageAdvertised({version:'99',methods:['_kiro/account/getUsage']})).toBe(false)
 expect(kiroQuotas({credits:0})[0]).toMatchObject({status:'unknown',reason:'native_usage_schema_unsupported'})
 expect(kiroRateLimit(now)).toMatchObject({status:'cooldown',windows:[]})
})
it('no inspecciona perfiles alternativos con argumentos desconocidos',()=>{
 expect(quotaProbeCompatibleArgs('codex_cli',['--profile','other'])).toBe(false)
 expect(quotaProbeCompatibleArgs('codex_cli',['--model','sol','-c','model_reasoning_effort="high"'])).toBe(true)
 expect(quotaProbeCompatibleArgs('kiro',['--model','sol','--effort','high'])).toBe(true)
 expect(quotaProbeCompatibleArgs('kiro',['--cloud'])).toBe(false)
})
it('deduplica probes entre procesos por perfil y respeta backoff',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-lease-'));paths.push(root)
 let finish:()=>void=()=>{};const collect=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
 const first=withQuotaLease(root,'profile',collect)
 expect(await withQuotaLease(root,'profile',collect)).toBe(false);finish();await first
 expect(await withQuotaLease(root,'profile',collect)).toBe(false);expect(collect).toHaveBeenCalledOnce()
 const fail=vi.fn(async()=>{throw new Error('offline')});await withQuotaLease(root,'other',fail)
 expect(await withQuotaLease(root,'other',fail)).toBe(false)
 const files=readdirSync(join(root,'usage-probes')).map(name=>readFileSync(join(root,'usage-probes',name),'utf8'))
 expect(files.some(file=>JSON.parse(file).failures===1)).toBe(true)
})
const broker=()=>({usageEnabled:()=>true,bindUsage:vi.fn(async()=>({binding_id:'installed',binding_version:1,cli:'codex_cli',provider:'openai'})),reportUsage:vi.fn(async()=>{})})
it('probe Codex real de protocolo sólo inicializa/lee metadatos y descarta cambio de cuenta',async()=>{
 for(const changes of [false,true]){
 const code=`const r=require('node:readline').createInterface({input:process.stdin});let reads=0;const send=x=>console.log(JSON.stringify(x));r.on('line',line=>{const p=JSON.parse(line);if(p.method==='initialized')return;if(p.method==='initialize')return send({id:p.id,result:{}});if(p.method==='account/read')return send({id:p.id,result:{workspaceRouting:{chatgptAccountId:${changes}&&reads++?'changed':'account'}}});if(p.method==='account/rateLimits/read')return send({id:p.id,result:{accountId:'account',rateLimits:{limitId:'codex',primary:{usedPercent:20,resetsAt:${reset}},secondary:null}}});send({id:p.id,error:{code:-1,message:'Unexpected operation'}})});`
 const protocol=new ChatProtocol('codex',process.execPath,['-e',code],process.cwd(),()=>{},async()=>({}));processes.push(protocol)
 const b=broker();await collectProtocolQuota(protocol,'codex_cli',b as unknown as NativeChatClient,'profile-ref')
 expect(protocol.sessionId).toBe('');expect(b.bindUsage).toHaveBeenCalledWith('openai',opaqueQuotaAccount('openai','account'),expect.any(String),'profile-ref',undefined)
 expect(b.reportUsage).toHaveBeenCalledTimes(changes?0:1)
 expect(b.bindUsage).toHaveBeenCalledTimes(changes?2:1)
 if(changes)expect(b.bindUsage).toHaveBeenLastCalledWith('openai',opaqueQuotaAccount('openai','changed'),expect.any(String),'profile-ref',undefined)
 }
})
it('no llama getUsage cuando Kiro no anuncia la extensión',async()=>{
 const code=`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const p=JSON.parse(line);console.log(JSON.stringify(p.method==='initialize'?{id:p.id,result:{agentCapabilities:{}}}:{id:p.id,error:{code:-1,message:'Unexpected call'}}))});`
 const protocol=new ChatProtocol('acp',process.execPath,['-e',code],process.cwd(),()=>{},async()=>({}));processes.push(protocol)
 const b=broker();await collectProtocolQuota(protocol,'kiro',b as unknown as NativeChatClient)
 expect(b.reportUsage.mock.calls[0]).toEqual([expect.anything(),expect.objectContaining({reason:'native_usage_not_advertised'}),undefined])
})

it('Codex respeta el bloqueo nativo aunque el porcentaje de ventana parezca libre',()=>{
 expect(codexQuotas({rateLimits:{limitId:'codex',primary:{usedPercent:5,resetsAt:reset},secondary:null,rateLimitReachedType:'credits'}},undefined,now)[0]).toMatchObject({status:'exhausted',reason:'native_limit_reached'})
 expect(codexQuotas({ordinaryUsageAllowed:false,rateLimits:{limitId:'codex',primary:{usedPercent:5,resetsAt:reset},secondary:null}},undefined,now)[0]).toMatchObject({complete:false,reason:'native_usage_unavailable'})
})
it('Claude incluye spend_limit y no descarta una restricción adicional malformed',()=>{
 const base={five_hour:{used_percentage:5,resets_at:reset},seven_day:{used_percentage:5,resets_at:reset}}
 expect(claudeQuotas({rate_limits:{...base,spend_limit:{used_percentage:100,resets_at:reset}}},now)[0]?.windows).toHaveLength(3)
 expect(claudeQuotas({rate_limits:{...base,spend_limit:{used_percentage:'100'}}},now)[0]?.complete).toBe(false)
})

it.each(['codex_cli','claude_code'])('perfil %s comparte binding por defecto y separa configuración de proyecto sin depender de sesión ni mtime',cli=>{
 const root=mkdtempSync(join(tmpdir(),'quota-profile-'));paths.push(root)
 const one=join(root,'one'),two=join(root,'two');mkdirSync(one);mkdirSync(two)
 const env={HOME:root},base=quotaProfileRef(cli,'/cli',env,one)
 expect(base).toMatch(/^[a-f0-9]{64}$/)
 expect(quotaProfileRef(cli,'/cli',env,two)).toBe(base)
 const subdir=cli==='codex_cli'?'.codex':'.claude',config=join(one,subdir,cli==='codex_cli'?'config.toml':'settings.local.json')
 mkdirSync(join(one,subdir));writeFileSync(config,'private contents never read')
 const scoped=quotaProfileRef(cli,'/cli',env,one),lease=quotaProfileKey(cli,'/cli',env,one)
 expect(scoped).not.toBe(base);expect(quotaProfileRef(cli,'/cli',env,two)).toBe(base)
 mkdirSync(join(one,'nested'));expect(quotaProfileRef(cli,'/cli',env,join(one,'nested'))).toBe(scoped)
 utimesSync(config,new Date(),new Date(Date.now()+10000))
 expect(quotaProfileRef(cli,'/cli',env,one)).toBe(scoped)
 expect(quotaProfileKey(cli,'/cli',env,one)).not.toBe(lease)
 expect(quotaProfileRef(cli,'/cli',{HOME:root,CODEX_HOME:'/alternative'},two)).not.toBe(base)
})
it('preserva duración nativa de Codex sin inferirla del nombre primary',()=>{
 const raw={rateLimits:{limitId:'codex',primary:{usedPercent:20,resetsAt:reset,windowDurationMins:15},secondary:null}}
 expect(codexQuotas(raw,undefined,now)[0]?.windows[0]?.duration_minutes).toBe(15)
 expect(codexQuotas({rateLimits:{...raw.rateLimits,primary:{usedPercent:20,resetsAt:reset}}},undefined,now)[0]?.windows[0]?.duration_minutes).toBeUndefined()
})

it('desvincula disponibilidad anterior si el accountId de la cuota contradice identidad nativa',async()=>{
 const protocol={initialize:async()=>({}),request:vi.fn(async(method:string)=>method==='account/read'?{workspaceRouting:{chatgptAccountId:'A'}}:{accountId:'B'})} as unknown as ChatProtocol
 const b=broker();await collectProtocolQuota(protocol,'codex_cli',b as unknown as NativeChatClient,'profile')
 expect(b.bindUsage).toHaveBeenNthCalledWith(1,'openai',opaqueQuotaAccount('openai','A'),expect.any(String),'profile',undefined)
 expect(b.bindUsage).toHaveBeenNthCalledWith(2,'openai',undefined,expect.any(String),'profile',undefined)
 expect(b.reportUsage).not.toHaveBeenCalled()
})

it('el propietario anterior no borra el lease de un reemplazo después de expiración',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-lease-owner-'));paths.push(root)
 const key=createHash('sha256').update('same').digest('hex'),directory=join(root,'usage-probes'),lock=join(directory,key+'.lock')
 let releaseFirst:()=>void=()=>{},releaseSecond:()=>void=()=>{}
 const first=withQuotaLease(root,'same',()=>new Promise<void>(resolve=>{releaseFirst=resolve}))
 const originalToken=readdirSync(lock)[0]
 utimesSync(lock,new Date(0),new Date(0));rmSync(join(directory,key+'.json'))
 const second=withQuotaLease(root,'same',()=>new Promise<void>(resolve=>{releaseSecond=resolve}))
 const replacementToken=readdirSync(lock)[0];expect(replacementToken).not.toBe(originalToken)
 releaseFirst();await first
 expect(existsSync(lock)).toBe(true);expect(readdirSync(lock)).toEqual([replacementToken])
 releaseSecond();await second;expect(existsSync(lock)).toBe(false)
})
it('OFF evita inicializar protocolo y procesos de probe aunque colaboración siga habilitada',async()=>{
 const p={initialize:vi.fn(async()=>({}))} as unknown as ChatProtocol,b={...broker(),usageEnabled:()=>false}
 await collectProtocolQuota(p,'codex_cli',b as unknown as NativeChatClient)
 expect(p.initialize).not.toHaveBeenCalled();expect(b.bindUsage).not.toHaveBeenCalled()
 const root=mkdtempSync(join(tmpdir(),'quota-off-'));paths.push(root)
 const stop=startQuotaCollector({root,cli:'codex_cli',command:'/must-not-run',prefix:[],args:[],cwd:root,env:{},broker:b as unknown as NativeChatClient,signal:new AbortController().signal})
 await stop();expect(existsSync(join(root,'usage-probes'))).toBe(false)
})
it('declara scope de modelos desconocido para pools dedicados sin mapping nativo',()=>{
 const pool=(limitId:string)=>({limitId,primary:{usedPercent:100,resetsAt:reset},secondary:null})
 expect(codexQuotas({rateLimitsByLimitId:{codex:pool('codex'),special:pool('special')}},undefined,now).map(p=>[p.pool_id,p.model_scope])).toEqual([['codex','all'],['special','unknown']])
})
it('la cancelación de metadata no cierra una conversación del protocolo existente',async()=>{
 const code=`require('node:readline').createInterface({input:process.stdin}).on('line',()=>{});`
 const protocol=new ChatProtocol('codex',process.execPath,['-e',code],process.cwd(),()=>{},async()=>({}));processes.push(protocol)
 const controller=new AbortController(),request=protocol.request('account/rateLimits/read',{},5000,controller.signal)
 controller.abort(new Error('absolute deadline'))
 await expect(request).rejects.toThrow('absolute deadline')
 expect(protocol.child.killed).toBe(false)
})

it('una lectura Codex vacía activa backoff sin publicar un pool provisional',async()=>{
 const protocol={initialize:async()=>({}),request:vi.fn(async(method:string)=>method==='account/read'?{workspaceRouting:{chatgptAccountId:'A'}}:{})} as unknown as ChatProtocol
 const b=broker()
 await expect(collectProtocolQuota(protocol,'codex_cli',b as unknown as NativeChatClient,'profile')).rejects.toThrow('native_usage_unavailable')
 expect(b.reportUsage).not.toHaveBeenCalled()
})
