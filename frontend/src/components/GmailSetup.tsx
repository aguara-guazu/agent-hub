import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useAuthorizeGmailSend } from '../lib/project-automation'
import { useScheduleActions } from '../lib/automations'
import type { DeliveryAvailability, DeliveryTarget, ScheduleView } from '../lib/automations'

type Step = 'explain' | 'waiting' | 'choose'
const STEPS: ReadonlyArray<[Step, string]> = [['explain', '1. Permiso'], ['waiting', '2. Google'], ['choose', '3. Automatizaciones']]
const DISMISS_KEY = 'agenthub.gmail-setup.dismissed'

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

function writeDismissed(): void {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* sin almacenamiento el aviso vuelve a mostrarse en la próxima carga */ }
}

const admitsGmail = (schedule: ScheduleView): boolean => schedule.delivery_allowed?.includes('gmail_self') ?? true
const withoutGmail = (schedules: readonly ScheduleView[]): ScheduleView[] => schedules.filter(schedule => admitsGmail(schedule) && !schedule.delivery.includes('gmail_self'))

/**
 * Aviso de Automatizaciones para recibir las entregas por Gmail. Con el envío sin autorizar abre el asistente desde el permiso; con Gmail
 * disponible y ninguna automatización que lo use, abre directamente la elección de automatizaciones. «Ahora no» lo oculta en este navegador.
 */
export function GmailSetupNotice({ schedules, availability }: { schedules: readonly ScheduleView[]; availability: DeliveryAvailability | undefined }) {
  const [hidden, setHidden] = useState(readDismissed)
  const [open, setOpen] = useState<Step | null>(null)
  const gmail = availability?.gmail_self
  const missing = gmail?.reason === 'scope_missing'
  const unused = gmail?.available === true && schedules.some(admitsGmail) && !schedules.some(schedule => schedule.delivery.includes('gmail_self'))
  const destination = gmail?.destination
  return <>
    {!hidden && (missing || unused) && <div className="memory-callout automations-callout automations-gmail-notice">
      {missing ? <p><strong>Recibe el brief y el cierre en tu correo.</strong> Agent Hub puede enviarlos a {destination ?? 'tu propia cuenta de Google'}; falta autorizar el envío.</p>
        : <p><strong>Gmail está listo para tus entregas.</strong> Elige qué automatizaciones se envían también a {destination ?? 'tu correo'}.</p>}
      <button className="btn btn-sm btn-primary" onClick={() => setOpen(missing ? 'explain' : 'choose')}>{missing ? 'Autorizar Gmail' : 'Elegir automatizaciones'}</button>
      <button className="btn btn-sm" onClick={() => { writeDismissed(); setHidden(true) }}>Ahora no</button>
    </div>}
    {open && <GmailSetupModal initial={open} schedules={schedules} availability={availability} onClose={() => setOpen(null)} />}
  </>
}

/**
 * Asistente de tres pasos: explica el permiso, abre el consentimiento de Google y espera a que la disponibilidad de Gmail pase a lista
 * (la lista de automatizaciones se relee sola), y agrega `gmail_self` a las automatizaciones elegidas conservando sus otros canales.
 */
export function GmailSetupModal({ initial, schedules, availability, onClose }: { initial: Step; schedules: readonly ScheduleView[]; availability: DeliveryAvailability | undefined; onClose: () => void }) {
  const toast = useToast()
  const actions = useScheduleActions()
  const destination = availability?.gmail_self.destination
  const { google, ambiguous, authorize } = useAuthorizeGmailSend(destination)
  const [step, setStep] = useState<Step>(initial)
  const [pending] = useState(() => withoutGmail(schedules))
  const [selected, setSelected] = useState<string[]>(() => pending.map(schedule => schedule.id))
  const [saving, setSaving] = useState(false)
  const ready = availability?.gmail_self.available === true
  useEffect(() => { if (step === 'waiting' && ready) setStep('choose') }, [step, ready])
  const openGoogle = (): void => authorize.mutate(undefined, { onSuccess: () => setStep('waiting') })
  const toggle = (id: string): void => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  const save = async (): Promise<void> => {
    setSaving(true)
    let added = 0
    for (const schedule of pending.filter(item => selected.includes(item.id))) {
      const delivery = Array.from(new Set<DeliveryTarget>(['hub_inbox', 'app_window', ...schedule.delivery, 'gmail_self']))
      try { await actions.delivery.mutateAsync({ id: schedule.id, revision: schedule.revision, delivery }); added++ } catch { /* el error ya se mostró; se sigue con las demás */ }
    }
    setSaving(false)
    if (added > 0) toast.success('Gmail agregado', added === 1 ? 'Una automatización se enviará también por correo.' : `${added} automatizaciones se enviarán también por correo.`)
    if (added === selected.length) onClose()
  }
  const busy = authorize.isPending || saving
  const footer = step === 'explain' ? <>
    <button className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
    <button className="btn btn-primary" onClick={openGoogle} disabled={busy || !google}>Continuar con Google</button>
  </> : step === 'waiting' ? <>
    <button className="btn" onClick={onClose}>Cerrar</button>
    <button className="btn" onClick={openGoogle} disabled={busy}>Abrir Google de nuevo</button>
  </> : <>
    <button className="btn" onClick={onClose} disabled={busy}>{pending.length ? 'Ahora no' : 'Cerrar'}</button>
    {pending.length > 0 && <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !ready || selected.length === 0}>Agregar Gmail</button>}
  </>
  return <Modal open title="Recibir las entregas por Gmail" onClose={onClose} busy={busy} footer={footer}>
    <div className="automations-form">
      <ol className="automations-steps">{STEPS.map(([key, label]) => <li key={key} className={key === step ? 'current' : undefined} aria-current={key === step ? 'step' : undefined}>{label}</li>)}</ol>
      {step === 'explain' && <>
        <p>Agent Hub enviará el brief, el cierre y el estado de tus proyectos a {destination ?? 'tu propia dirección de Google'}; nunca a terceros. Para eso Google tiene que conceder el permiso de envío.</p>
        <p>Google mostrará una pantalla de advertencia porque el cliente OAuth es tuyo y no está verificado, y volverá a pedir todos los permisos (lectura y envío); es normal.</p>
        {ambiguous && <p className="automations-warning">Hay varias cuentas de Google: autoriza el envío en <Link to="/memory/sources" onClick={onClose}>Fuentes y ajustes</Link>, en la cuenta que corresponde.</p>}
        {!ambiguous && !google && <p className="automations-warning">Primero conecta Google en <Link to="/memory/sources" onClick={onClose}>Fuentes y ajustes</Link>.</p>}
      </>}
      {step === 'waiting' && <>
        <p>Completa el permiso en el navegador y vuelve a esta ventana. Avanza sola cuando Google confirme el envío.</p>
        <p className="automations-muted">Si en el navegador aparece «Google no concedió el envío», vuelve a abrir Google y acepta el permiso de envío de correos.</p>
      </>}
      {step === 'choose' && (pending.length === 0 ? <p>Todas tus automatizaciones ya se envían por Gmail.</p> : <>
        <p>{ready ? `Gmail quedó listo${destination ? ` para ${destination}` : ''}.` : 'Gmail todavía no está listo.'} Elige qué automatizaciones se envían también por correo; la app sigue recibiéndolas.</p>
        <fieldset><legend>Automatizaciones</legend>
          {pending.map(schedule => <label key={schedule.id} className="automations-choice"><input type="checkbox" checked={selected.includes(schedule.id)} onChange={() => toggle(schedule.id)} disabled={busy} /> {schedule.title}</label>)}
        </fieldset>
        <p className="automations-muted">Cada una se puede cambiar después con la acción «Canales».</p>
      </>)}
    </div>
  </Modal>
}
