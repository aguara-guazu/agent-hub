import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
const exec=promisify(execFile)
export interface NativeProcess { parent:number; started:string; command:string }
/** Prefix of the Linux birth identity: boot_id plus start time in clock ticks since boot. */
const LINUX_START='linux:'
/**
 * True when a stored birth identity uses the stable Linux format. A value from an older version (ps lstart text)
 * cannot be compared with it: callers must treat it as "no birth identity", never as a different process.
 */
export function isStableProcessStart(value:string|null|undefined):boolean { return typeof value==='string' && value.startsWith(LINUX_START) }
/**
 * ps lstart is derived from btime, which drifts on WSL2 and on hosts whose clock is stepped, so the same live PID
 * reports a different text over time. /proc/<pid>/stat starttime (ticks since boot) and boot_id never change.
 */
async function linuxStart(pid:number, signal?:AbortSignal):Promise<string|undefined> {
  try {
    const [stat,boot]=await Promise.all([readFile(`/proc/${pid}/stat`,{encoding:'utf8',signal}),readFile('/proc/sys/kernel/random/boot_id',{encoding:'utf8',signal})])
    // comm may contain spaces and parentheses: the fields after the last ')' start at field 3 (state).
    const ticks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]
    return ticks && /^\d+$/.test(ticks) && boot.trim() ? `${LINUX_START}${boot.trim()}:${ticks}` : undefined
  } catch { return undefined }
}
/** null proves exit; undefined means inspection is unavailable. Never infer death from a timeout. */
export async function inspectNativeProcess(pid:number, signal?:AbortSignal):Promise<NativeProcess|null|undefined> {
  if(!Number.isSafeInteger(pid)||pid<1||signal?.aborted)return undefined
  try {
    if(process.platform==='win32') {
      const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){@{parent=$p.ParentProcessId;started=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`
      const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:3000,maxBuffer:32768,windowsHide:true,signal})
      if(!result.stdout.trim())return null
      const value=JSON.parse(result.stdout)
      return typeof value.started==='string'&&typeof value.command==='string'?{parent:Number(value.parent),started:value.started,command:value.command}:undefined
    }
    const before=process.platform==='linux'?await linuxStart(pid,signal):undefined
    const row=(await exec('ps',['-p',String(pid),'-o','ppid=','-o','lstart=','-o','command='],{timeout:1000,maxBuffer:32768,signal,env:{...process.env,LC_ALL:'C'}})).stdout.trim()
    if(!row)return null
    const match=/^(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(row)
    if(!match)return undefined
    if(process.platform==='linux') {
      const stable=await linuxStart(pid,signal)
      if(signal?.aborted)return undefined
      // Without /proc the identity would change format between calls; report inspection as unavailable instead.
      // ps and /proc are separate reads: a PID reused between them would pair one process's command with another's identity.
      return stable&&stable===before?{parent:Number(match[1]),started:stable,command:match[3]!}:undefined
    }
    return {parent:Number(match[1]),started:match[2]!.trim(),command:match[3]!}
  } catch(error) { return !signal?.aborted&&process.platform!=='win32'&&String((error as NodeJS.ErrnoException).code)==='1'?null:undefined }
}
