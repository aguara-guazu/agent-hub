import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAutomationSettings, useSaveAutomationSettings } from '../lib/automations'

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="hub-switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}

/** Sección «Automatizaciones» de Ajustes: interruptor propio, avisos, jornada y mantener despierta la Mac. */
export function AutomationSettings() {
  const settings = useAutomationSettings()
  const save = useSaveAutomationSettings()
  const data = settings.data
  const [hours, setHours] = useState('')
  useEffect(() => { if (data) setHours(String(data.workday_hours)) }, [data])
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const busy = !data || save.isPending
  const hoursValue = Number(hours)
  const hoursValid = Number.isFinite(hoursValue) && hoursValue > 0 && hoursValue <= 24
  return <>
    {settings.error && <div className="hub-notice error" role="alert"><Icon name="alert" /><div><strong>No pudimos cargar los datos</strong><p>{settings.error.message}</p></div><button className="btn" onClick={() => void settings.refetch()}>Reintentar</button></div>}
    <div className="hub-settings automation-settings">
      <section><div><h2>Automatizaciones</h2><p>Brief, cierre y otras automatizaciones de tus agentes. Al apagarlo se cancelan las ejecuciones y entregas pendientes; no se retiran acciones ya aceptadas por Jira o por tu repositorio. Funciona también con la colaboración apagada.</p></div>
        <Toggle label="Habilitar automatizaciones" checked={data?.automations_enabled ?? true} disabled={busy} onChange={value => save.mutate({ automations_enabled: value })} /></section>
      <section><div><h2>Avisos de automatizaciones nuevas</h2><p>Avisarme con una notificación del sistema cuando un agente programe, cambie o cancele una automatización. Si lo apagas, el aviso en el chat del agente y la vista Programaciones siguen.</p></div>
        <Toggle label="Notificar cuando un agente programe, cambie o cancele una automatización" checked={data?.notify_schedule_created ?? true} disabled={busy} onChange={value => save.mutate({ notify_schedule_created: value })} /></section>
      <section><div><h2>Avisos de entregas</h2><p>Avisarme cuando llegue una entrega, por ejemplo «Brief listo». El clic abre la entrega.</p></div>
        <Toggle label="Notificar cuando llegue una entrega" checked={data?.notify_delivery ?? true} disabled={busy} onChange={value => save.mutate({ notify_delivery: value })} /></section>
      {window.agentHub && <section><div><h2>Mantener la computadora despierta durante el brief</h2><p>Evita que la computadora se suspenda por inactividad mientras se genera y se envía una entrega, y solo durante ese tiempo. No cubre cerrar la tapa de un portátil: el sistema lo trata como suspensión forzada y el brief pendiente corre al abrirla.</p></div>
        <Toggle label="Mantener la computadora despierta hasta completar y enviar el brief" checked={data?.keep_awake ?? true} disabled={busy} onChange={value => save.mutate({ keep_awake: value })} /></section>}
      <section><div><h2>Zona horaria y jornada</h2><p>Zona horaria: la del sistema ({timezone}). La jornada de referencia solo marca el total del cierre; no bloquea nada.</p></div>
        <label className="automation-hours">Jornada (h)<input type="number" min={0.5} max={24} step={0.5} value={hours} aria-label="Jornada de referencia en horas" disabled={busy} aria-invalid={!hoursValid} onChange={event => setHours(event.target.value)} onBlur={() => { if (data && hoursValid && hoursValue !== data.workday_hours) save.mutate({ workday_hours: hoursValue }) }} /></label></section>
      <section><div><h2>Qué detiene cada interruptor</h2><p>Colaboración apagada: se detienen equipos y flota. Automatizaciones apagadas: se detienen brief, cierre y entregas.</p></div></section>
    </div>
  </>
}
