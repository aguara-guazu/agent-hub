import { afterEach, expect, it } from 'vitest'
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeUsage } from './usage-quota-claude.js'
const paths:string[]=[]
// Cancellation requests termination before the OS releases the child's working directory.
afterEach(async()=>{for(const p of paths.splice(0))await rm(p,{recursive:true,force:true,maxRetries:10,retryDelay:100})})
it('consulta control nativo sin prompts, hooks, MCP ni lectura de transcripciones',async()=>{
 const root=mkdtempSync(join(tmpdir(),'claude-quota-'));paths.push(root)
 const script=join(root,'fixture.cjs'),capture=join(root,'calls.jsonl')
 writeFileSync(script,`const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const p=JSON.parse(l);fs.appendFileSync(${JSON.stringify(capture)},l+'\\n');process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:p.request_id,subtype:'success',response:p.request.subtype==='get_usage'?{rate_limits_available:true,rate_limits:{five_hour:{utilization:18}}}:{}}})+'\\n')});`)
 const data=await readClaudeUsage(process.execPath,[script],root,process.env,AbortSignal.timeout(3000))
 expect(data).toMatchObject({rate_limits_available:true})
 const packets=readFileSync(capture,'utf8').trim().split('\n').map(x=>JSON.parse(x))
 expect(packets.map(p=>p.type)).toEqual(['control_request','control_request'])
 expect(packets.map(p=>p.request)).toEqual([{subtype:'initialize'},{subtype:'get_usage',skip_behaviors:true}])
})
it('un protocolo que no responde vence sin empezar un turno',async()=>{
 const root=mkdtempSync(join(tmpdir(),'claude-quota-timeout-'));paths.push(root)
 const script=join(root,'fixture.cjs');writeFileSync(script,'process.stdin.resume();setInterval(()=>{},1000)')
 await expect(readClaudeUsage(process.execPath,[script],root,process.env,AbortSignal.timeout(100))).rejects.toThrow('native_usage_timeout')
})
