import { readFile, realpath } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { googleQuotas, opencodeQuotas, unknownQuota } from './usage-quota-adapters.js'

/** Credentials stay in this process and go only to fixed provider origins. Never return raw errors. */
async function localJson(path:string):Promise<Record<string,any>> {
  try { const text=await readFile(path,'utf8');return text.length<262144?JSON.parse(text):{} } catch { return {} }
}

/** Read the installed CLI's public OAuth client metadata; never execute its login flow. */
async function geminiOAuthClient(home:string,env:NodeJS.ProcessEnv):Promise<{client_id:string;client_secret:string}|undefined> {
  const paths=new Set((env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean))
  paths.add(join(home,'.local/bin'))
  const manifests=new Set<string>()
  for(const directory of paths) {
    manifests.add(join(directory,'node_modules/@google/gemini-cli/package.json'))
    manifests.add(join(dirname(directory),'lib/node_modules/@google/gemini-cli/package.json'))
    const binary=await realpath(join(directory,'gemini')).catch(()=>undefined)
    if(binary)for(let current=dirname(binary),depth=0;depth<8;depth++) {
      manifests.add(join(current,'package.json'))
      const parent=dirname(current);if(parent===current)break;current=parent
    }
  }
  for(const manifest of manifests) {
    if((await localJson(manifest)).name!=='@google/gemini-cli')continue
    try {
      const entry=createRequire(manifest).resolve('@google/gemini-cli-core')
      const source=await readFile(join(dirname(entry),'code_assist/oauth2.js'),'utf8')
      if(source.length>262144)continue
      // Accept only literal metadata from the native module. Never evaluate JavaScript.
      const literal=(name:string)=>new RegExp(`\\bconst\\s+${name}\\s*=\\s*['"]([^'"\\\\\\r\\n]{1,256})['"]\\s*;`).exec(source)?.[1]
      const client_id=literal('OAUTH_CLIENT_ID'),client_secret=literal('OAUTH_CLIENT_SECRET')
      if(client_id && client_secret)return {client_id,client_secret}
    } catch { /* Unsupported installation: leave refresh to the CLI. */ }
  }
  return undefined
}
async function json(url:string,init:RequestInit,fetcher:typeof fetch):Promise<any> {
  const response=await fetcher(url,{...init,redirect:'error'})
  if(!response.ok)throw new Error(response.status===401 || response.status===403?'quota_login_required':'quota_provider_unavailable')
  const reader=response.body?.getReader();if(!reader)throw new Error('quota_provider_unavailable')
  let text=''
  try {for(;;){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);if(text.length>262144)throw new Error('quota_response_too_large')}}
  finally {await reader.cancel()}
  try{return JSON.parse(text)}catch{throw new Error('quota_schema_unsupported')}
}

export async function readHttpQuota(cli:'gemini_cli'|'opencode',home:string,signal:AbortSignal,env=process.env,fetcher:typeof fetch=fetch) {
  const adapter=cli==='gemini_cli'?'gemini-quota':'opencode-go'
  try {
    if(cli==='opencode') {
      const auth=await localJson(join(env.XDG_DATA_HOME || join(home,'.local/share'),'opencode/auth.json'))
      const key=auth['opencode-go']?.type==='api'?auth['opencode-go'].key:undefined
      if(typeof key!=='string' || !key)return [unknownQuota(cli,adapter,Object.keys(auth).length?'quota_provider_not_connected':'quota_login_required')]
      return opencodeQuotas(await json('https://opencode.ai/zen/go/v1/usage',{signal,headers:{Authorization:`Bearer ${key}`}},fetcher))
    }
    const credentials=await localJson(join(home,'.gemini/oauth_creds.json'))
    let access=credentials.access_token
    if(typeof access!=='string')return [unknownQuota(cli,adapter,'quota_login_required')]
    if(typeof credentials.expiry_date!=='number' || credentials.expiry_date<Date.now()+60000) {
      if(typeof credentials.refresh_token!=='string')return [unknownQuota(cli,adapter,'quota_login_required')]
      const client=await geminiOAuthClient(home,env)
      if(!client)return [unknownQuota(cli,adapter,'quota_login_required')]
      // Refresh stays in memory using the installed CLI's client metadata.
      // The CLI owns its credential file and refresh-token lifecycle.
      const refreshed=await json('https://oauth2.googleapis.com/token',{method:'POST',signal,body:new URLSearchParams({
        ...client,refresh_token:credentials.refresh_token,grant_type:'refresh_token',
      })},fetcher)
      if(typeof refreshed.access_token!=='string')return [unknownQuota(cli,adapter,'quota_login_required')]
      access=refreshed.access_token
    }
    const headers={Authorization:`Bearer ${access}`,'Content-Type':'application/json'}
    const loaded=await json('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',{method:'POST',signal,headers,
      body:JSON.stringify({metadata:{ideType:'GEMINI_CLI'},...(env.GOOGLE_CLOUD_PROJECT?{cloudaicompanionProject:env.GOOGLE_CLOUD_PROJECT}:{})})},fetcher)
    const project=loaded.cloudaicompanionProject
    if(typeof project!=='string' || !project)return [unknownQuota(cli,adapter,'quota_project_required')]
    return googleQuotas(await json('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',{method:'POST',signal,headers,body:JSON.stringify({project})},fetcher),'gemini_cli')
  } catch(error) {
    signal.throwIfAborted()
    const reason=error instanceof Error && ['quota_login_required','quota_provider_unavailable','quota_schema_unsupported','quota_response_too_large'].includes(error.message)?error.message:'quota_provider_unavailable'
    return [unknownQuota(cli,adapter,reason)]
  }
}
