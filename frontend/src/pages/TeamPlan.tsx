import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, formatTime } from '../lib/memory'
import { CLI_LABELS, type CliKind } from '../lib/types'

type Member = {id:string;role:string;task:string;prompt?:string;cli:string;model:string;effort?:string;nickname?:string|null;
  state?:string;work_thread_id?:string;workspace_path?:string;session_id?:string|null;
  runtime?:{state:string;updated_at?:string};work?:{status:string;summary:string;waiting_for?:string;updated_at:string}|null;
  last_report?:{id:string;thread_id:string;text:string;created_at:string}|null}
type Plan = {
  id:string; digest:string; objective:string; state:string;root_thread_id?:string;master_channel_id?:string;
  parent:{path:string;kind?:string}; base_revision:string;
  plan:{permissions:string;members:Member[]};members?:Member[];
  progress:{workspaces_created:number;processes_accepted:number;joined:number;total:number};
}
const runtimeLabels:Record<string,string>={busy:'Proceso activo',idle:'Proceso en reposo',waiting_input:'Espera una respuesta',unknown:'Proceso sin confirmar',stopped:'Proceso detenido',exited:'Proceso finalizado',failed:'Error de proceso',starting:'Iniciando proceso'}
const planLabels:Record<string,string>={prepared:'Pendiente de aprobación',launching:'Iniciando',launched:'Lanzado',active:'Activo',partial:'Lanzamiento parcial',uncertain:'Lanzamiento sin confirmar',paused:'Pausado',cancelled:'Cancelado',completed:'Cerrado'}
export function TeamPlan({id,compact:requestedCompact=false,onThread}:{id:string;compact?:boolean;onThread?:(thread:string,channel?:string)=>void}) {
  const cache=useQueryClient()
  const plan=useQuery({queryKey:['memory','team-plan',id],queryFn:()=>api.get<Plan>(`/memory/teams/${encodeURIComponent(id)}`),refetchInterval:5000,refetchIntervalInBackground:false})
  const approve=useMutation({mutationFn:(digest:string)=>api.post<Plan>(`/memory/teams/${encodeURIComponent(id)}/approve`,{digest}),
    onSuccess:result=>{cache.setQueryData(['memory','team-plan',id],result);void cache.invalidateQueries({queryKey:['memory']})}})
  const value=plan.data,compact=requestedCompact && value?.state!=='prepared'
  return <section aria-label="Plan del equipo" className={`team-overview ${compact?'compact':''}`}>
    <div className="team-overview-heading"><h3>{compact?'Equipo':'Plan del equipo'}</h3>{value && <span className="local-chat-tag">{planLabels[value.state] ?? value.state}</span>}</div>
    <ErrorBox error={plan.error} retry={plan.refetch}/>
    {plan.isPending && <p role="status">Cargando equipo…</p>}
    {value && <>
      <p className="team-progress">Incorporados: {value.progress.joined}/{value.progress.total} · Procesos aceptados: {value.progress.processes_accepted}/{value.progress.total}</p>
      {!compact && value.state!=='prepared' && <p className="team-evidence-note">El proceso y el trabajo tienen estados distintos. Los avances que ves abajo provienen de reportes en el Hub.</p>}
      <div className="team-members">{(value.members?.length?value.members:value.plan.members).map(m=>{
        const definition=value.plan.members.find(item=>item.id===m.id)
        const status=m.work?.status==='completed'?'Entrega reportada':m.work?.status==='waiting'?'En espera':m.work?'Avance reportado':m.last_report?'Con reporte':'Sin reporte de trabajo'
        return <article className="team-member" key={m.id}>
          <div className="team-member-heading"><strong>{m.nickname ?? m.role.split(':')[0]}</strong><span className={`local-chat-tag ${m.work?.status==='completed'?'resolved':''}`}>{status}</span></div>
          {!compact && m.nickname && <p className="team-role">{m.role}</p>}
          <p className="team-model">{CLI_LABELS[m.cli as CliKind] ?? m.cli} · {m.model}{m.effort?` · ${m.effort}`:''}</p>
          {!compact && <p className="team-task">{m.task}</p>}
          <small>{m.runtime ? runtimeLabels[m.runtime.state] ?? 'Estado de proceso sin confirmar' : m.state==='joined'?'Incorporado; proceso sin confirmar':m.state==='prepared' || value.state==='prepared'?'Todavía no iniciado':'Aún no se incorporó'}</small>
          {!compact && m.work && <p className="team-work-summary">{m.work.summary}</p>}
          {!compact && m.last_report && <blockquote className="team-last-report"><p>{m.last_report.text}</p><small>Último mensaje · {formatTime(m.last_report.created_at)}</small></blockquote>}
          {compact && (m.work || m.last_report) && <p className="team-report-preview" title={m.work?.summary ?? m.last_report?.text}>{m.work?.summary ?? m.last_report?.text}</p>}
          {onThread && <div className="team-member-actions">
            {m.work_thread_id && <button className="btn btn-sm" onClick={()=>onThread(m.work_thread_id!,value.master_channel_id)}>Ver tarea y conversación</button>}
            {m.last_report && m.last_report.thread_id!==m.work_thread_id && <button className="btn btn-sm" onClick={()=>onThread(m.last_report!.thread_id,value.master_channel_id)}>Ver último reporte</button>}
          </div>}
          {!compact && <details><summary>Instrucciones y espacio de trabajo</summary><p>{m.workspace_path ?? 'Se creará al iniciar'}</p><pre>{definition?.prompt ?? m.prompt}</pre></details>}
        </article>
      })}</div>
      {onThread && value.root_thread_id && <button className="btn btn-sm" onClick={()=>onThread(value.root_thread_id!,value.master_channel_id)}>Abrir coordinación general</button>}
      {!compact && <details className="team-plan-details" open={!compact || value.state==='prepared'}><summary>Objetivo, permisos y base del equipo</summary>
        <p>{value.objective}</p><p>{value.parent.kind==='virtual'?'Espacio virtual':'Repositorio'}: {value.parent.path}</p><p>Base: {value.base_revision}</p>
        <p>{value.plan.permissions==='full_access'?'Los trabajadores tendrán acceso completo a archivos y comandos.':'Los trabajadores conservarán los permisos de sus clientes.'}</p>
        {value.parent.kind==='virtual' && <p>Los espacios virtuales conservan conversaciones y archivos propios. No copian ni aíslan los archivos de la carpeta de origen.</p>}
        <p>Espacios creados: {value.progress.workspaces_created}/{value.progress.total}</p>
      </details>}
      {value.state==='prepared' && <button className="btn btn-primary" disabled={approve.isPending} onClick={()=>approve.mutate(value.digest)}>{approve.isPending?'Iniciando…':'Aprobar e iniciar este equipo'}</button>}
      <ErrorBox error={approve.error}/>
    </>}
  </section>
}
export function TeamPreference() {
  const cache=useQueryClient()
  const preference=useQuery({queryKey:['memory','team-preference'],queryFn:()=>api.get<{preferred_backend:'hub'|'native'}>('/memory/teams/preferences')})
  const save=useMutation({mutationFn:(preferred_backend:string)=>api.put('/memory/teams/preferences',{preferred_backend}),onSuccess:()=>cache.invalidateQueries({queryKey:['memory','team-preference']})})
  return <label className="field">Preferencia para formar equipos
    <select aria-label="Preferencia para formar equipos" value={preference.data?.preferred_backend ?? 'hub'} disabled={!preference.data || save.isPending} onChange={e=>save.mutate(e.target.value)}>
      <option value="hub">Agent Hub</option><option value="native">Subagentes del cliente</option>
    </select><ErrorBox error={preference.error ?? save.error}/>
  </label>
}
