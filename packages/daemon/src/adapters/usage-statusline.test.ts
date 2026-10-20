import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planUsageStatusline } from './usage-statusline.js'
import { applyChanges } from './atomic.js'
import { gatewayEndpoint, type Snapshot } from './base.js'
let home:string
const snapshot={cli_kind:'claude_code',servers:[{tools:[{name:'chat_join'}]}]} as Snapshot
const endpoint=gatewayEndpoint({command:'/a path/node',args:['/app/cli.js','gateway','--agent','agent','--state-dir','/state']})
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'quota-statusline-'));mkdirSync(join(home,'.claude'))})
afterEach(()=>rmSync(home,{recursive:true,force:true}))
it('instala sólo cuando falta, conserva otras claves y reconoce lo ya gestionado',()=>{
 const path=join(home,'.claude/settings.json');writeFileSync(path,JSON.stringify({personal:true}))
 const [changes,drift]=planUsageStatusline(snapshot,endpoint,home)
 expect(drift).toEqual([]);expect(applyChanges(changes).drift).toEqual([])
 const config=JSON.parse(readFileSync(path,'utf8'));expect(config.personal).toBe(true)
 const command=config.statusLine.command,encoded=/-EncodedCommand\s+(\S+)/.exec(command)?.[1]
 expect(encoded?Buffer.from(encoded,'base64').toString('utf16le'):command).toContain('usage-statusline')
 expect(planUsageStatusline(snapshot,endpoint,home)).toEqual([[],[]])
})
it('no modifica statusline personal o editada después del plan',()=>{
 const path=join(home,'.claude/settings.json'),personal='{"statusLine":{"type":"command","command":"echo personal"},"other":1}'
 writeFileSync(path,personal);const [changes,drift]=planUsageStatusline(snapshot,endpoint,home)
 expect(changes).toEqual([]);expect(drift[0]?.reason).toContain('personal conservada');expect(readFileSync(path,'utf8')).toBe(personal)
 writeFileSync(path,'{}');const [plan]=planUsageStatusline(snapshot,endpoint,home);writeFileSync(path,personal)
 expect(applyChanges(plan).drift).toHaveLength(1);expect(readFileSync(path,'utf8')).toBe(personal)
})
it('no reclama statusline al desactivar colaboración y retira sólo la propia',()=>{
 const disabled={...snapshot,servers:[]};expect(planUsageStatusline(disabled,endpoint,home)).toEqual([[],[]])
 applyChanges(planUsageStatusline(snapshot,endpoint,home)[0]);applyChanges(planUsageStatusline(disabled,endpoint,home)[0])
 expect(JSON.parse(readFileSync(join(home,'.claude/settings.json'),'utf8')).statusLine).toBeNull()
})
