import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'
import { ConfirmDialog } from '../components/Modal'

interface CredentialStatus { configured: boolean; stored: boolean }
const queryKey = ['memory-kiro-credentials']
const docs = 'https://kiro.dev/docs/getting-started/authentication/#generate-an-api-key'

export function KiroCredentials({ onChanged }: { onChanged: () => void }) {
  const cache = useQueryClient()
  const status = useQuery({ queryKey, queryFn: () => api.get<CredentialStatus>('/memory/credentials/kiro'), retry: false })
  const [key, setKey] = useState(''), [saved, setSaved] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const changed = async () => {
    onChanged()
    await Promise.all([cache.invalidateQueries({ queryKey }), cache.invalidateQueries({ queryKey: ['memory-extraction-cli', 'kiro'] })])
  }
  // Do not retain secret-bearing mutation variables in the shared query cache.
  const save = useMutation({ mutationFn: () => api.put('/memory/credentials/kiro', { api_key: key.trim() }), onSuccess: async () => {
    setKey(''); setSaved(true); await changed()
  } })
  const remove = useMutation({ mutationFn: () => api.delete('/memory/credentials/kiro'), onSuccess: async () => {
    setConfirmDelete(false); setSaved(false); setKey(''); await changed()
  } })
  const busy = save.isPending || remove.isPending
  return <section className="kiro-credentials" aria-label="Acceso de Kiro">
    <div className="kiro-key-form">
      <div className="spread"><h3>API key de Kiro</h3><span className={`badge ${status.data?.configured ? 'badge-on' : ''}`}>{status.isPending ? 'Consultando…' : status.isError ? 'No se pudo consultar' : status.data?.stored ? 'Guardada en este equipo' : status.data?.configured ? 'Clave disponible' : 'Falta configurar'}</span></div>
      <p>Kiro requiere una clave de tu cuenta para procesar reuniones automáticamente. Se guarda en este equipo con las demás credenciales del Hub.</p>
      <Field label={status.data?.stored ? 'Nueva API key de Kiro (para reemplazarla)' : 'Pegá tu API key de Kiro'}>
        <input aria-label="API key de Kiro" type="password" autoComplete="new-password" spellCheck={false} value={key} placeholder="ksk_…" disabled={busy}
          onChange={e => { setKey(e.target.value); setSaved(false); save.reset() }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (key.trim() && !busy) save.mutate() } }} />
      </Field>
      <div className="memory-button-wrap">
        <button className="btn btn-primary" type="button" disabled={!key.trim() || busy} onClick={() => save.mutate()}>{save.isPending ? 'Guardando clave…' : status.data?.stored ? 'Reemplazar clave' : 'Guardar clave'}</button>
        {status.data?.stored && <button className="btn" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>Quitar clave guardada</button>}
        <a className="btn" href="https://app.kiro.dev" target="_blank" rel="noreferrer">Abrir mi cuenta de Kiro ↗</a>
      </div>
      {saved && <p role="status">Clave guardada. Elegí el modelo y pulsá «Probar modelo» para verificar el acceso.</p>}
      <ErrorBox error={status.error ?? save.error} />
    </div>
    <details className="kiro-guide" open={status.data ? !status.data.configured : false}>
      <summary>¿Cómo obtengo la API key?</summary>
      <ol>
        <li>Entrá a <a href="https://app.kiro.dev" target="_blank" rel="noreferrer">app.kiro.dev</a> con tu cuenta y abrí <strong>API Keys</strong>.</li>
        <li>Creá una clave con un nombre como «Agent Hub» y copiala: Kiro sólo muestra el valor completo al crearla.</li>
        <li>Pegala en el campo de arriba y pulsá <strong>Guardar clave</strong>.</li>
        <li>Elegí modelo y esfuerzo, pulsá <strong>Probar modelo</strong> y, si responde bien, habilitá el envío de fragmentos y pulsá <strong>Guardar configuración</strong>.</li>
      </ol>
      <p className="field-hint">Kiro indica que requiere Pro, Pro+, Pro Max o Power y consume créditos de esa suscripción. Si «API Keys» está deshabilitado para tu organización, pedí su habilitación al administrador antes de continuar. <a href={docs} target="_blank" rel="noreferrer">Instrucciones oficiales ↗</a></p>
      <details className="kiro-guide-photos"><summary>Ver los pasos con capturas</summary>
        <figure><img src="/guides/kiro/sign-in.png" alt="Acceso público de Kiro con los proveedores de inicio de sesión" loading="lazy" /><figcaption>1. Iniciá sesión en Kiro. Después abrí «API Keys» en tu cuenta.</figcaption></figure>
        <figure><img src="/guides/kiro/save-key.png" alt="Campo API key de Kiro y botón Guardar clave en Agent Hub" loading="lazy" /><figcaption>2. Pegá y guardá la clave. Captura con datos de demostración, sin una clave real.</figcaption></figure>
        <figure><img src="/guides/kiro/test-model.png" alt="Selección de modelo y esfuerzo, y botón Probar modelo en Agent Hub" loading="lazy" /><figcaption>3. Probá el modelo antes de guardar la configuración. Modelo de ejemplo.</figcaption></figure>
      </details>
    </details>
    <ConfirmDialog open={confirmDelete} title="Quitar clave de Kiro" message={<>Se elimina la clave guardada en este equipo; no se revoca en tu cuenta de Kiro. Las próximas tareas necesitarán una clave disponible.<ErrorBox error={remove.error} /></>}
      confirmLabel="Quitar clave" destructive busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} />
  </section>
}
