import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

/** Experimental native get_usage, version-gated by its response. No user prompt or transcript scan. */
export function readClaudeUsage(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal):Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const child=spawn(command,[...args,'--print','--input-format','stream-json','--output-format','stream-json','--verbose',
      '--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings','{"disableAllHooks":true}'],{cwd,env,stdio:'pipe',windowsHide:true})
    const init=randomUUID(),usage=randomUUID(),lines=createInterface({input:child.stdout})
    let settled=false,bytes=0,timer:ReturnType<typeof setTimeout>|undefined
    const finish=(error?:Error,value?:unknown)=>{
      if(settled)return;settled=true
      signal.removeEventListener('abort',abort);lines.close();child.stdin.end();child.kill('SIGTERM')
      timer=setTimeout(()=>child.kill('SIGKILL'),1000);timer.unref()
      if(error)reject(error);else resolve(value)
    }
    const abort=()=>finish(new Error('native_usage_timeout'))
    const send=(request_id:string,request:Record<string,unknown>)=>child.stdin.write(JSON.stringify({type:'control_request',request_id,request})+'\n')
    signal.addEventListener('abort',abort,{once:true})
    child.stderr.resume();child.stdin.on('error',()=>finish(new Error('native_usage_unavailable')))
    child.once('error',()=>finish(new Error('native_usage_unavailable')))
    child.once('close',()=>{clearTimeout(timer);finish(new Error('native_usage_unavailable'))})
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576)finish(new Error('native_usage_invalid'))})
    lines.on('line',line=>{
      if(settled)return
      try {
        const packet=JSON.parse(line),response=packet.response
        if(packet.type!=='control_response' || ![init,usage].includes(response?.request_id))return
        if(response.subtype!=='success'){finish(new Error('native_usage_unsupported'));return}
        if(response.request_id===init)send(usage,{subtype:'get_usage',skip_behaviors:true})
        else finish(undefined,response.response)
      }catch{finish(new Error('native_usage_invalid'))}
    })
    send(init,{subtype:'initialize'})
  })
}
