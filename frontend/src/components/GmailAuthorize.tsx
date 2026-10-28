import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from './Modal'
import { useAuthorizeGmailSend } from '../lib/project-automation'

/** «Falta autorizar el envío»: atajo que guarda la opción en la fuente y abre la autorización de Google. */
export function GmailAuthorize({ destination }: { destination?: string }) {
  const { google, authorize } = useAuthorizeGmailSend()
  const [asking, setAsking] = useState(false)
  if (!google) return <small className="automations-muted"> Conecta Google en <Link to="/memory/sources">Fuentes y ajustes</Link>.</small>
  return <>
    <button type="button" className="btn btn-sm" disabled={authorize.isPending} onClick={() => setAsking(true)}>Autorizar</button>
    <ConfirmDialog open={asking} title="Autorizar el envío de correos" confirmLabel="Continuar con Google" cancelLabel="Ahora no" busy={authorize.isPending} onClose={() => setAsking(false)}
      onConfirm={() => authorize.mutate(undefined, { onSettled: () => setAsking(false) })}
      message={<><p>Google mostrará una pantalla de advertencia porque el cliente OAuth es tuyo y no está verificado.</p><p>Agent Hub solo enviará correos a {destination ?? 'tu propia dirección'}; nunca a terceros.</p><p>Google vuelve a pedir todos los permisos (lectura y envío); es normal.</p></>} />
  </>
}
