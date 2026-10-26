import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kiroQuotas, googleQuotas, antigravityQuotas, opencodeQuotas } from './usage-quota-adapters.js'
import { readHttpQuota } from './usage-quota-http.js'
const now=Date.parse('2026-10-22T20:00:00Z'),reset='2026-11-01T00:00:00Z'
const dirs:string[]=[]
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})))})
it('lee créditos Kiro reales y no cuenta el bonus como otra restricción simultánea',()=>{
 const raw={success:true,data:{billingCycleReset:'2026-11-01',overagesEnabled:false,usageBreakdowns:[{resourceType:'CREDIT',hasLimit:true,used:10000,limit:10000}],bonusCredits:[],addOnCredits:[]}}
 expect(kiroQuotas(raw,now)[0]).toMatchObject({model_scope:'all',complete:true,windows:[{used:10000,limit:10000,remaining:0,resets_at:new Date(reset).toISOString()}]})
 expect(kiroQuotas({...raw,data:{...raw.data,overagesEnabled:true}},now)[0]).toMatchObject({model_scope:'unknown',complete:false,reason:'additional_capacity_unverified'})
 expect(kiroQuotas({success:false},now)[0]).toMatchObject({status:'unknown',windows:[]})
})
it('Google conserva cuotas totalmente recuperadas aunque remainingAmount esté ausente',()=>{
 const rows=[{modelId:'gemini-pro',remainingFraction:1,resetTime:reset,tokenType:'REQUESTS'},{modelId:'gemini-pro',remainingFraction:0,resetTime:reset,tokenType:'INPUT_TOKENS'}]
 expect(googleQuotas({buckets:rows},'gemini_cli',now)[0]).toMatchObject({model_scope:'listed',model_ids:['gemini-pro'],complete:true,windows:[{used:0},{used:100}]})
 expect(googleQuotas({buckets:[{...rows[0],remainingFraction:1.3}]},'gemini_cli',now)[0]).toMatchObject({complete:false,windows:[]})
 expect(antigravityQuotas({email:'private',quota:{'gemini-weekly':{remaining_fraction:.75,reset_time:reset}}},now)[0]).toMatchObject({model_scope:'unknown',pool_id:'gemini-weekly',windows:[{used:25}]})
})
it('OpenCode Go no promete cuota universal de proveedores ajenos',()=>{
 const usage=Object.fromEntries(['rolling','weekly','monthly'].map(k=>[k,{percent:20,resetsAt:reset,status:'ok'}]))
 expect(opencodeQuotas({usage},now)[0]).toMatchObject({pool_id:'go',model_scope:'unknown',complete:true,windows:[{used:20},{used:20},{used:20}]})
 expect(opencodeQuotas({usage:{rolling:usage.rolling}},now)[0]?.complete).toBe(false)
})
it('sin credenciales no consulta red ni convierte un perfil ausente en cuota disponible',async()=>{
 const home=await mkdtemp(join(tmpdir(),'quota-auth-'));dirs.push(home)
 const fetcher=vi.fn()
 expect((await readHttpQuota('opencode',home,AbortSignal.timeout(1000),{},fetcher))[0]).toMatchObject({reason:'quota_login_required'})
 expect((await readHttpQuota('gemini_cli',home,AbortSignal.timeout(1000),{},fetcher))[0]).toMatchObject({reason:'quota_login_required'})
 expect(fetcher).not.toHaveBeenCalled()
})
it('envía credenciales OpenCode sólo al endpoint fijo y nunca persiste secretos o errores del proveedor',async()=>{
 const home=await mkdtemp(join(tmpdir(),'quota-auth-'));dirs.push(home)
 await mkdir(join(home,'.local/share/opencode'),{recursive:true})
 await writeFile(join(home,'.local/share/opencode/auth.json'),JSON.stringify({'opencode-go':{type:'api',key:'TEST_SECRET'}}))
 const fetcher=vi.fn(async()=>new Response('TEST_SECRET',{status:401})) as unknown as typeof fetch
 const result=await readHttpQuota('opencode',home,AbortSignal.timeout(1000),{},fetcher)
 expect(fetcher).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/usage',expect.objectContaining({redirect:'error',headers:{Authorization:'Bearer TEST_SECRET'}}))
 expect(result[0]?.reason).toBe('quota_login_required');expect(JSON.stringify(result)).not.toContain('TEST_SECRET')
})
it('Gemini refresca OAuth sin inferencia ni escritura de credenciales y usa el proyecto nativo',async()=>{
 const home=await mkdtemp(join(tmpdir(),'quota-auth-'));dirs.push(home)
 await mkdir(join(home,'.gemini'),{recursive:true})
 const credentials={access_token:'expired',refresh_token:'REFRESH_PRIVATE',expiry_date:1}
 await writeFile(join(home,'.gemini/oauth_creds.json'),JSON.stringify(credentials))
 const bin=await installedGemini(home,`const OAUTH_CLIENT_ID = 'fixture-client';\nconst OAUTH_CLIENT_SECRET = 'fixture-secret';\nthrow new Error('must not execute');`)
 const future=new Date(Date.now()+3600000).toISOString()
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>new Response(JSON.stringify(String(url).includes('/token')?{access_token:'ACCESS_PRIVATE'}:String(url).includes('loadCodeAssist')?{cloudaicompanionProject:'native-project'}:{buckets:[{modelId:'gemini-pro',remainingFraction:.6,resetTime:future}]}))) as unknown as typeof fetch
 const result=await readHttpQuota('gemini_cli',home,AbortSignal.timeout(1000),{PATH:bin},fetcher)
 expect(result[0]).toMatchObject({model_ids:['gemini-pro'],windows:[{used:40,remaining:60}]})
 expect(fetcher).toHaveBeenLastCalledWith('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',expect.objectContaining({body:JSON.stringify({project:'native-project'}),redirect:'error'}))
 expect(JSON.stringify(result)).not.toContain('PRIVATE')
 const refreshBody=(vi.mocked(fetcher).mock.calls[0]?.[1]?.body as URLSearchParams)
 expect(Object.fromEntries(refreshBody)).toMatchObject({client_id:'fixture-client',client_secret:'fixture-secret',refresh_token:'REFRESH_PRIVATE'})
 const {readFile}=await import('node:fs/promises');expect(JSON.parse(await readFile(join(home,'.gemini/oauth_creds.json'),'utf8'))).toEqual(credentials)
})

async function installedGemini(home:string,source:string) {
 const bin=join(home,'bin'),pkg=join(bin,'node_modules/@google/gemini-cli'),core=join(pkg,'node_modules/@google/gemini-cli-core')
 await mkdir(join(core,'dist/src/code_assist'),{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@google/gemini-cli'}))
 await writeFile(join(core,'package.json'),JSON.stringify({name:'@google/gemini-cli-core',main:'dist/src/index.js'}))
 await writeFile(join(core,'dist/src/index.js'),'throw new Error("must not execute")')
 await writeFile(join(core,'dist/src/code_assist/oauth2.js'),source)
 return bin
}

it.each([undefined,"const OAUTH_CLIENT_ID = getClient(); const OAUTH_CLIENT_SECRET = 'fixture-secret';"])(
 'Gemini deja el refresco a la CLI si no puede leer metadatos literales instalados (%s)',async source=>{
 const home=await mkdtemp(join(tmpdir(),'quota-client-'));dirs.push(home)
 await mkdir(join(home,'.gemini'),{recursive:true})
 await writeFile(join(home,'.gemini/oauth_creds.json'),JSON.stringify({access_token:'expired',refresh_token:'PRIVATE',expiry_date:1}))
 const bin=source?await installedGemini(home,source):join(home,'empty-bin'),fetcher=vi.fn()
 expect((await readHttpQuota('gemini_cli',home,AbortSignal.timeout(1000),{PATH:bin},fetcher))[0]).toMatchObject({status:'unknown',reason:'quota_login_required'})
 expect(fetcher).not.toHaveBeenCalled()
})

it('Gemini usa un token vigente sin depender de los metadatos de instalación',async()=>{
 const home=await mkdtemp(join(tmpdir(),'quota-client-'));dirs.push(home)
 await mkdir(join(home,'.gemini'),{recursive:true})
 await writeFile(join(home,'.gemini/oauth_creds.json'),JSON.stringify({access_token:'PRIVATE',expiry_date:Date.now()+3600000}))
 const fetcher=vi.fn(async(url:RequestInfo|URL)=>new Response(JSON.stringify(String(url).includes('loadCodeAssist')?{cloudaicompanionProject:'native-project'}:{buckets:[]}))) as unknown as typeof fetch
 await readHttpQuota('gemini_cli',home,AbortSignal.timeout(1000),{},fetcher)
 expect(fetcher).toHaveBeenCalledTimes(2)
 expect(vi.mocked(fetcher).mock.calls.every(([url])=>!String(url).includes('/token'))).toBe(true)
})
