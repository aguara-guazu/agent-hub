import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile)
export interface NativeProcess { parent:number; started:string; command:string }
/** null proves exit; undefined means inspection is unavailable. Never infer death from a timeout. */
export async function inspectNativeProcess(pid:number):Promise<NativeProcess|null|undefined> {
  if(!Number.isSafeInteger(pid)||pid<1)return undefined
  try {
    if(process.platform==='win32') {
      const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){@{parent=$p.ParentProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`
      const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:3000,maxBuffer:32768,windowsHide:true})
      if(!result.stdout.trim())return null
      const value=JSON.parse(result.stdout)
      return typeof value.started==='string'&&typeof value.command==='string'?{parent:Number(value.parent),started:value.started,command:value.command}:undefined
    }
    const row=(await exec('ps',['-p',String(pid),'-o','ppid=','-o','lstart=','-o','command='],{timeout:1000,maxBuffer:32768})).stdout.trim()
    if(!row)return null
    const match=/^(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(row)
    return match?{parent:Number(match[1]),started:match[2]!.trim(),command:match[3]!}:undefined
  } catch(error) { return process.platform!=='win32'&&String((error as NodeJS.ErrnoException).code)==='1'?null:undefined }
}
