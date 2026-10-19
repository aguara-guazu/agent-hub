import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const alias = (nativeId:string) => `${createHash('sha256').update(nativeId).digest('hex')}.json`
/** Native hooks/MCP bind their conversation ID to the owning terminal's Hub identity. No tokens. */
export function bindTuiSession(agentId:string,nativeId:unknown) {
  const env=process.env
  if(env.AGENTHUB_TUI_AGENT!==agentId || !env.AGENTHUB_TUI_BINDINGS || !env.AGENTHUB_TUI_SESSION || typeof nativeId!=='string' || !nativeId)return
  try {
    mkdirSync(env.AGENTHUB_TUI_BINDINGS,{recursive:true,mode:0o700})
    const path=join(env.AGENTHUB_TUI_BINDINGS,alias(nativeId)),temp=`${path}.${process.pid}.tmp`
    writeFileSync(temp,JSON.stringify({id:env.AGENTHUB_TUI_SESSION}),{mode:0o600});renameSync(temp,path)
  } catch { /* An unwritable alias must not fail a native hook or MCP call. */ }
}
export function resumedTuiSession(directory:string,nativeId:string|undefined):string|undefined {
  if(!nativeId)return undefined
  try {const data=JSON.parse(readFileSync(join(directory,alias(nativeId)),'utf8'));return typeof data.id==='string'&&/^tui:[a-f0-9-]{36}$/.test(data.id)?data.id:undefined} catch{return undefined}
}
