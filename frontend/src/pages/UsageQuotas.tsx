import type { UsageQuotaAvailability, UsageQuotaWindow } from '@agenthub/shared'
import { useMemory, ErrorBox, formatTime } from '../lib/memory'
import { CLI_LABELS, type CliKind } from '../lib/types'

const labels={available:'Cuota disponible',low:'Cuota baja',exhausted:'Cuota agotada',cooldown:'Espera temporal',unknown:'Cuota desconocida'}
const reasons:Record<string,string>={quota_login_required:'Iniciá sesión en este cliente para consultar su saldo.',quota_provider_not_connected:'OpenCode tiene proveedores conectados, pero falta conectar OpenCode Go para consultar esa suscripción.',quota_project_required:'La cuenta de Google no informó el proyecto de Code Assist.',quota_provider_unavailable:'El proveedor no respondió a la consulta. El Hub volverá a intentarlo.',additional_capacity_unverified:'La cuota base está medida; falta confirmar cómo se aplican créditos adicionales o sobreconsumo.',no_observation:'Todavía no llegó una lectura nativa.',ambiguous_account:'Hay varias cuentas o perfiles; falta identificar cuál se usará.',
  expired_observation:'La última lectura venció.',reset_requires_observation:'Pasó la hora de reinicio; falta confirmar el saldo nuevo.',configuration_required:'La CLI necesita configurar la lectura de cuotas.',
  unknown_model_scope:'La CLI informa una ventana específica sin IDs de modelo. Su porcentaje es conocido; su aplicación a cada modelo queda por confirmar.',
  subscription_limits_unavailable:'La CLI no expone límites de suscripción para esta autenticación.',native_windows_incomplete:'La CLI entregó sólo parte de las ventanas.',
  native_usage_not_advertised:'Esta CLI no anuncia una consulta nativa de saldo.',native_usage_schema_unsupported:'El formato de cuotas de esta CLI todavía no es compatible.',
  unsupported:'Esta versión de la CLI no ofrece una consulta compatible.',missing_fields:'La CLI todavía no informó sus límites.',unknown_account:'La lectura pertenece a este perfil; la cuenta no está verificada.'}
function windowName(window:UsageQuotaWindow) {
  const duration=window.duration_minutes
  if(duration===300 || window.id==='five_hour')return '5 horas'
  if(duration===10080 || window.id==='seven_day')return '7 días'
  if(window.id==='monthly-credits' || window.id==='monthly')return 'Mes'
  if(window.id==='quota')return 'Consumo'
  return duration?`${duration} minutos`:window.id==='spend_limit'?'Límite de gasto':window.id
}
function amount(window:UsageQuotaWindow) {
  const number=(value:number)=>new Intl.NumberFormat('es-AR',{maximumFractionDigits:1}).format(value)
  if(window.unit==='percent' && window.used!==undefined)return `${number(window.used)} % usado`
  const unit={credits:'créditos',tokens:'tokens',requests:'solicitudes',unknown:'unidades',percent:'%'}[window.unit]
  if(window.unit==='credits' && window.used!==undefined && window.limit!==undefined)return `${number(window.used)} / ${number(window.limit)} créditos usados`
  return window.remaining!==undefined ? `${number(window.remaining)} ${unit} restantes` : window.used!==undefined ? `${number(window.used)} ${unit} usados` : 'Consumo no informado'
}
export function UsageQuotas({clients}:{clients:{id:string;cli_kind:CliKind}[]}) {
  const quota=useMemory<{generated_at:string;clis:({cli:string}&UsageQuotaAvailability)[]}>('usage_status')
  return <section className="hub-usage-quotas" aria-label="Cuotas de uso">
    <div className="hub-list-toolbar"><div><h2>Cuotas de uso</h2><p>Los líderes consultan este mismo estado para planificar sus equipos. Las cuotas se obtienen del proveedor o de la CLI, sin generar respuestas de IA. Varios agentes pueden compartir el mismo saldo.</p></div>
      <button className="btn btn-sm" onClick={()=>void quota.refetch()}>Ver última lectura</button></div>
    <ErrorBox error={quota.error} retry={quota.refetch}/>
    {quota.isPending ? <p role="status">Cargando cuotas…</p> : <div className="hub-client-grid">{[...clients].sort((a,b)=>Number(!['claude_code','codex_cli','kiro'].includes(a.cli_kind))-Number(!['claude_code','codex_cli','kiro'].includes(b.cli_kind))).map(client=>{
      const entry=quota.data?.clis.find(item=>item.cli===client.cli_kind),pools=entry?.pools.filter(pool=>pool.binding_ids.some(id=>id===client.id || id.startsWith(`${client.id}:profile:`))) ?? []
      // Never borrow another installation's available balance for this client card.
      const state=pools.length ? entry!.status : 'unknown'
      const hasValues=pools.some(pool=>pool.observation.windows.length>0)
      const unsupported=client.cli_kind==='claude_desktop'
      return <article className="hub-client-card" key={client.id} aria-label={`Cuota de ${CLI_LABELS[client.cli_kind]}`}>
        <h3>{CLI_LABELS[client.cli_kind]}</h3><strong className={`hub-state ${state==='available'?'on':state==='unknown'?'':'pending'}`}>{unsupported?'Sin consulta compatible':state==='unknown' && hasValues?'Lectura parcial':labels[state]}</strong>
        {!pools.length && <p>{unsupported?'Claude Desktop necesita su propia conexión de cuenta; no se le atribuye el saldo de Claude Code sin verificar que sea la misma.':client.cli_kind==='antigravity'?'Abrí Antigravity CLI para recibir sus cuotas nativas. /usage actualiza la lectura.':'Esperando la consulta automática. Si persiste, comprobá el inicio de sesión de la CLI y que la herramienta de cuotas esté habilitada.'}</p>}
        {entry?.reason && pools.length>0 && (entry.reason!=='unknown_model_scope' || hasValues) && <p>{reasons[entry.reason] ?? 'La disponibilidad no pudo confirmarse con la información recibida.'}</p>}
        {[...pools].sort((a,b)=>Number(a.model_scope!=='all')-Number(b.model_scope!=='all')).map(pool=><div key={pool.id} className="hub-client-meta quota-pool">
          <strong>{pool.pool_id==='subscription' || pool.pool_id==='codex'?'Cuota general':pool.pool_id==='gemini-weekly'?'Gemini · cuota semanal':pool.pool_id==='3p-weekly'?'Otros modelos · cuota semanal':pool.pool_id.startsWith('model-')?`Ventana específica: ${pool.pool_id.slice(6)}`:pool.pool_id}</strong>
          <span>{pool.scope==='account'?'Saldo de cuenta compartido':'Lectura del perfil; cuenta sin verificar'}</span>
          <strong>{pool.status==='unknown' && pool.observation.windows.length?'Consumo informado; alcance por confirmar':labels[pool.status]}{pool.stale?' · lectura pendiente de actualización':''}</strong>
          {pool.reason && <span>{reasons[pool.reason] ?? 'La CLI no entregó una lectura completa compatible.'}</span>}
          <ul>{pool.observation.windows.map(window=><li key={window.id}><strong>{windowName(window)}</strong>: {amount(window)}{window.resets_at && <span> · Reinicio informado: {formatTime(window.resets_at)}</span>}</li>)}</ul>
          {pool.retained_windows?.length ? <details><summary>Restricciones de lecturas anteriores</summary><ul>{pool.retained_windows.map(e=><li key={e.window.id}>{e.window.id}: {amount(e.window)} · Leída {formatTime(e.observed_at)}, válida hasta {formatTime(e.expires_at)}</li>)}</ul></details>:null}
          {pool.retained_status && <span>Aviso anterior: {labels[pool.retained_status.status]} · Válido hasta {formatTime(pool.retained_status.expires_at)}</span>}
          <details><summary>Origen y vigencia</summary><div className="quota-source"><span>Fuente: {pool.observation.source.adapter==='claude-control'?'Claude Code · consulta nativa':pool.observation.source.adapter==='codex-app-server'?'Codex · app-server':pool.observation.source.adapter}</span>
          <span>Válida hasta: {formatTime(pool.observation.expires_at)}</span>
          <span>Última lectura: {formatTime(pool.observation.observed_at)}</span></div></details>
        </div>)}
      </article>
    })}</div>}
    <p className="field-hint">Desconocido no significa disponible. Las lecturas vencen y el reinicio necesita confirmación de la CLI. Tener cuota no garantiza que alcance hasta terminar una tarea.</p>
  </section>
}
