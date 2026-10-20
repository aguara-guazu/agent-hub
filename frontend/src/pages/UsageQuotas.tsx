import type { UsageQuotaAvailability, UsageQuotaWindow } from '@agenthub/shared'
import { useMemory, ErrorBox, formatTime } from '../lib/memory'
import { CLI_LABELS, type CliKind } from '../lib/types'

const labels={available:'Cuota disponible',low:'Cuota baja',exhausted:'Cuota agotada',cooldown:'Espera temporal',unknown:'Cuota desconocida'}
const reasons:Record<string,string>={no_observation:'Todavía no llegó una lectura nativa.',ambiguous_account:'Hay varias cuentas o perfiles; falta identificar cuál se usará.',
  expired_observation:'La última lectura venció.',reset_requires_observation:'Pasó la hora de reinicio; falta confirmar el saldo nuevo.',configuration_required:'La CLI necesita configurar la lectura de cuotas.',
  unsupported:'Esta versión de la CLI no ofrece una consulta compatible.',missing_fields:'La CLI todavía no informó sus límites.',unknown_account:'La lectura pertenece a este perfil; la cuenta no está verificada.'}
function amount(window:UsageQuotaWindow) {
  const number=(value:number)=>new Intl.NumberFormat('es-AR',{maximumFractionDigits:1}).format(value)
  if(window.unit==='percent' && window.used!==undefined)return `${number(window.used)} % usado`
  const unit={credits:'créditos',tokens:'tokens',requests:'solicitudes',unknown:'unidades',percent:'%'}[window.unit]
  return window.remaining!==undefined ? `${number(window.remaining)} ${unit} restantes` : window.used!==undefined ? `${number(window.used)} ${unit} usados` : 'Consumo no informado'
}
export function UsageQuotas({clients}:{clients:{id:string;cli_kind:CliKind}[]}) {
  const quota=useMemory<{generated_at:string;clis:({cli:string}&UsageQuotaAvailability)[]}>('usage_status')
  return <section className="hub-usage-quotas" aria-label="Cuotas de uso">
    <div className="hub-list-toolbar"><div><h2>Cuotas de uso</h2><p>Los líderes consultan este mismo estado para planificar sus equipos. Una cuenta puede compartir su saldo entre varios agentes.</p></div>
      <button className="btn btn-sm" onClick={()=>void quota.refetch()}>Actualizar estado</button></div>
    <ErrorBox error={quota.error} retry={quota.refetch}/>
    {quota.isPending ? <p role="status">Cargando cuotas…</p> : <div className="hub-client-grid">{clients.map(client=>{
      const entry=quota.data?.clis.find(item=>item.cli===client.cli_kind),pools=entry?.pools.filter(pool=>pool.binding_ids.some(id=>id===client.id || id.startsWith(`${client.id}:profile:`))) ?? []
      // Never borrow another installation's available balance for this client card.
      const state=pools.length ? entry!.status : 'unknown'
      return <article className="hub-client-card" key={client.id} aria-label={`Cuota de ${CLI_LABELS[client.cli_kind]}`}>
        <h3>{CLI_LABELS[client.cli_kind]}</h3><strong className={`hub-state ${state==='available'?'on':state==='unknown'?'':'pending'}`}>{labels[state]}</strong>
        {!pools.length && <p>Todavía no llegó una lectura nativa de este cliente.</p>}
        {entry?.reason && <p>{reasons[entry.reason] ?? 'La disponibilidad no pudo confirmarse con la información recibida.'}</p>}
        {pools.map(pool=><div key={pool.id} className="hub-client-meta">
          <span>{pool.scope==='account'?'Saldo de cuenta compartido':'Lectura del perfil; cuenta sin verificar'}</span>
          <strong>{labels[pool.status]}{pool.stale?' · lectura pendiente de actualización':''}</strong>
          {pool.reason && <span>{reasons[pool.reason] ?? 'La CLI no entregó una lectura completa compatible.'}</span>}
          <ul>{pool.observation.windows.map(window=><li key={window.id}><strong>{window.id}</strong>: {amount(window)}{window.resets_at && <span> · Reinicio informado: {formatTime(window.resets_at)}</span>}</li>)}</ul>
          {pool.retained_windows?.length ? <details><summary>Restricciones de lecturas anteriores</summary><ul>{pool.retained_windows.map(e=><li key={e.window.id}>{e.window.id}: {amount(e.window)} · Leída {formatTime(e.observed_at)}, válida hasta {formatTime(e.expires_at)}</li>)}</ul></details>:null}
          {pool.retained_status && <span>Aviso anterior: {labels[pool.retained_status.status]} · Válido hasta {formatTime(pool.retained_status.expires_at)}</span>}
          <span>Última lectura: {formatTime(pool.observation.observed_at)}</span>
        </div>)}
      </article>
    })}</div>}
    <p className="field-hint">Desconocido no significa disponible. Las lecturas vencen y el reinicio necesita confirmación de la CLI. Tener cuota no garantiza que alcance hasta terminar una tarea.</p>
  </section>
}
