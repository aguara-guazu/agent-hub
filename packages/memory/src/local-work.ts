import { createHash } from 'node:crypto'
import { z } from 'zod'
import { check, id } from './contracts.js'
import type { Sql } from './database.js'

const session = {session_key:z.string().min(32).max(200).optional()}
export const workUpdateInput = z.object({
  ...session,thread_id:id,work_id:z.string().trim().min(1).max(200),
  request_id:z.string().min(1).max(200),expected_version:z.number().int().min(0),
  event:z.enum(['started','progress','waiting','completed']),
  summary:z.string().trim().min(1).max(2000),
  waiting_for:z.enum(['human','permission','agent','tool','schedule']).optional(),
  report_message_id:id.optional(),
}).strict().superRefine((v,ctx)=>{
  if((v.event==='waiting')!==Boolean(v.waiting_for))ctx.addIssue({code:'custom',message:'waiting_for corresponde únicamente al evento waiting'})
  if((v.event==='completed')!==Boolean(v.report_message_id))ctx.addIssue({code:'custom',message:'completed requiere el mensaje de reporte; otros eventos no lo aceptan'})
})
export const workDefinitions = {
  chat_work_update:['Registrar progreso comprobado, espera explícita o finalización de tu trabajo autorizado en un hilo. No enviar heartbeats como progreso. completed requiere un reporte propio ya persistido en ese hilo; no afirma que el destinatario lo leyó. expected_version=0 crea; reusar request_id exacto evita duplicados.',workUpdateInput],
  chat_work_list:['Leer estados de trabajo del hilo propio o del equipo vinculado y su última observación watchdog en modo shadow. Son declaraciones de agentes, separadas de la presencia y de recibos de lectura. La observación no ejecuta ni autoriza acciones; puede estar desactualizada. No despierta ni reinicia agentes.',z.object({...session,thread_id:id,limit:z.number().int().min(1).max(100).default(40),offset:z.number().int().min(0).default(0)}).strict()],
} satisfies Record<string,[string,z.ZodType]>

/** Called inside LocalChat's transaction after identity and thread authorization. */
export async function updateWork(sql:Sql,sessionId:string,input:z.infer<typeof workUpdateInput>) {
  const payload={thread_id:input.thread_id,work_id:input.work_id,expected_version:input.expected_version,event:input.event,
    summary:input.summary,waiting_for:input.waiting_for??null,report_message_id:input.report_message_id??null}
  const requestHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const prior=(await sql.query('SELECT request_hash,snapshot FROM chat_work_events WHERE session_id=$1 AND request_id=$2',[sessionId,input.request_id]))[0]
  if(prior){check(prior.request_hash===requestHash,'request_id ya usado con otro estado de trabajo',409);return prior.snapshot}
  const current=(await sql.query('SELECT * FROM chat_work_state WHERE session_id=$1 AND work_id=$2',[sessionId,input.work_id]))[0]
  check((current?.version??0)===input.expected_version,'Versión de trabajo desactualizada; volvé a leer el estado',409)
  check(!current || current.thread_id===input.thread_id,'El trabajo pertenece a otro hilo',409)
  check(current?.status!=='completed','Un trabajo finalizado no se reabre; usá otro work_id',409)
  check(current ? input.event!=='started' : input.event==='started','Primero registrá started; un trabajo existente no se inicia de nuevo',409)
  if(input.report_message_id) {
    check((await sql.query('SELECT id FROM chat_messages WHERE id=$1 AND thread_id=$2 AND author_id=$3',
      [input.report_message_id,input.thread_id,sessionId])).length,'El reporte debe ser un mensaje propio del mismo hilo',400)
  }
  const now=new Date().toISOString(),status=input.event==='waiting'?'waiting':input.event==='completed'?'completed':'active'
  // Starting work, presence, Stop and heartbeat are not proof of task progress.
  const progress=input.event==='progress'?now:current?.last_progress_at??null
  const rows=await sql.query(`INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,waiting_for,last_progress_at,reported_at,report_message_id,version,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(session_id,work_id) DO UPDATE SET status=excluded.status,summary=excluded.summary,waiting_for=excluded.waiting_for,
      last_progress_at=excluded.last_progress_at,reported_at=excluded.reported_at,report_message_id=excluded.report_message_id,
      version=excluded.version,updated_at=excluded.updated_at RETURNING *`,
    [sessionId,input.work_id,input.thread_id,status,input.summary,input.waiting_for??null,progress,input.event==='completed'?now:null,
      input.report_message_id??null,(current?.version??0)+1,now])
  const result={...rows[0],source:'agent' as const,report_receipt:input.event==='completed'?'persisted':null}
  await sql.query('INSERT INTO chat_work_events(session_id,request_id,request_hash,snapshot) VALUES($1,$2,$3,$4)',
    [sessionId,input.request_id,requestHash,JSON.stringify(result)])
  return result
}
