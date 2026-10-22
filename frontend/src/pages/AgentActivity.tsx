import { useEffect, useRef, useState } from 'react'
import { Modal } from '../components/Modal'
import { api } from '../lib/api'
import { ErrorBox, formatTime } from '../lib/memory'

interface ActivityItem { seq:number; at:string; kind:'user'|'assistant'|'tool'|'system'; text:string }
interface Activity { supported:boolean; reason?:string; generation?:string; state?:string; items:ActivityItem[]; next_cursor:number; truncated?:boolean }
const labels = { user:'Mensaje',assistant:'Agente',tool:'Herramienta',system:'Sistema' }
const states:Record<string,string> = {starting:'Iniciando',busy:'Trabajando',idle:'Disponible',waiting_input:'Esperando respuesta',stopped:'Detenido',failed:'Error',unknown:'Sin confirmar'}

/** Owner UI only. Output stays in this mounted view, outside shared query caches. */
export function AgentActivity({agent,onClose,onMessages}:{agent:{id:string;label:string};onClose:()=>void;onMessages:()=>void}) {
  const [activity,setActivity]=useState<Activity|null>(null),[error,setError]=useState<Error|null>(null)
  const output=useRef<HTMLDivElement>(null),follow=useRef(true)
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined,cursor=0,generation:string|undefined
    const controller=new AbortController()
    async function refresh() {
      if(document.hidden) {timer=setTimeout(()=>void refresh(),2000);return}
      try {
        let result=await api.get<Activity>(`/memory/chat/agents/${encodeURIComponent(agent.id)}/activity?after=${cursor}`,controller.signal)
        if(disposed)return
        // A restarted process has a fresh sequence; fetch its retained prefix too.
        if(generation!==undefined && result.generation!==generation && cursor>0) {
          result=await api.get<Activity>(`/memory/chat/agents/${encodeURIComponent(agent.id)}/activity?after=0`,controller.signal)
          if(disposed)return
        }
        generation=result.generation;cursor=result.next_cursor
        setActivity(previous=>{
          const merged=previous && previous.generation===result.generation ? [...previous.items,...result.items.filter(item=>item.seq>previous.next_cursor)] : result.items
          let size=0,start=merged.length
          while(start>0 && merged.length-start<500 && size+merged[start-1].text.length<=131072)size+=merged[--start].text.length
          return {...result,items:merged.slice(start),truncated:!!(result.truncated || start || (previous && previous.generation===result.generation && previous.truncated))}
        })
        setError(null)
        if(!result.supported)return
      } catch(cause) {if(disposed)return;setError(cause instanceof Error?cause:new Error(String(cause)))}
      if(!disposed)timer=setTimeout(()=>void refresh(),2000)
    }
    void refresh()
    return ()=>{disposed=true;controller.abort();clearTimeout(timer)}
  },[agent.id])
  useEffect(()=>{if(follow.current && output.current)output.current.scrollTop=output.current.scrollHeight},[activity])
  return <Modal open title={`Actividad de ${agent.label}`} onClose={onClose} width={900} footer={<button className="btn" onClick={onMessages}>Ver mensajes en el Hub</button>}>
    <p className="muted">Vista de sólo lectura para vos. Muestra la conversación y las ejecuciones compartidas por el proceso con el Hub.</p>
    <ErrorBox error={error}/>
    {!activity && !error && <p role="status">Cargando actividad…</p>}
    {activity?.supported===false && <p role="status">Esta sesión no comparte su salida con el Hub. Podés consultar sus mensajes y estado registrados.</p>}
    {activity?.supported && <>
      <p role="status">Estado del proceso: {states[activity.state??'unknown'] ?? 'Sin confirmar'}</p>
      {activity.truncated && <p className="muted">Se muestran los eventos recientes; la vista conserva un historial limitado.</p>}
      <div className="agent-activity-output" ref={output} onScroll={()=>{const node=output.current;if(node)follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<40}} aria-label="Actividad del proceso">
        {activity.items.length===0 && <p>Sin eventos de salida disponibles todavía.</p>}
        {activity.items.map(item=><section key={item.seq} className={`agent-activity-item ${item.kind}`}><header><strong>{labels[item.kind]}</strong><time dateTime={item.at}>{formatTime(item.at)}</time></header><pre>{item.text}</pre></section>)}
      </div>
      <p className="muted">La vista se actualiza mientras está abierta. No envía mensajes ni consume tokens.</p>
    </>}
  </Modal>
}
