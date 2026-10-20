import { join } from 'node:path'
import { Manifest, planJsonValue, region, readRegion, type FileChange, type DriftItem } from './atomic.js'
import type { Snapshot, GatewayEndpoint } from './base.js'
import { hookCommand } from './memory-hooks.js'

/** Claim only an absent or previously managed statusLine. A custom command remains byte-for-byte intact. */
export function planUsageStatusline(snapshot:Snapshot,endpoint:GatewayEndpoint,home:string):[FileChange[],DriftItem[]] {
  if(snapshot.cli_kind!=='claude_code' || endpoint.transport!=='stdio' || !endpoint.args.includes('gateway') || !endpoint.args.includes('--state-dir'))return [[],[]]
  const path=join(home,'.claude/settings.json'),manifest=Manifest.load(home),keyPath=['statusLine']
  const enabled=snapshot.servers.some(server=>server.tools.some(tool=>tool.name==='chat_join'))
  if(!enabled && manifest.digestFor(path,region('json_value',keyPath))===null)return [[],[]]
  const args=endpoint.args.map(arg=>arg==='gateway'?'usage-statusline':arg)
  const value=enabled?{type:'command',command:hookCommand(endpoint.command,args,true)}:null
  const [change,drift]=planJsonValue({home,path,keyPath,value,manifest,cliKind:'claude_code',summary:'Cuotas nativas de Claude Code en statusLine'})
  // Custom statuslines are valid user configuration, not corruption. Explain the required opt-in.
  if(drift.length) {
    let custom=false
    try { custom=!!readRegion(path,region('json_value',keyPath)) } catch { /* preserve parse error */ }
    if(custom)for(const item of drift)item.reason='Statusline personal conservada; cuotas requieren integrar el comando usage-statusline con el mismo JSON de stdin (sin reemplazar la salida personal).'
  }
  return [change?[change]:[],drift]
}
