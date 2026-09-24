import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field } from '../lib/memory'
import { useToast } from '../components/Toast'

export function useJiraSettings() {
  return useQuery({ queryKey:['memory','jira-settings'],queryFn:()=>api.get<{default_site_url:string|null}>('/memory/jira-settings') })
}
export function JiraSettings() {
  const settings=useJiraSettings(),cache=useQueryClient(),toast=useToast(),[site,setSite]=useState<string|null>(null)
  const save=useMutation({ mutationFn:()=>api.put<{default_site_url:string|null}>('/memory/jira-settings',{default_site_url:(site ?? settings.data?.default_site_url ?? '').trim() || null}),
    onSuccess:result=>{cache.setQueryData(['memory','jira-settings'],result);setSite(null);void cache.invalidateQueries({queryKey:['memory']});toast.success('Sitio de Jira predeterminado guardado')},onError:e=>toast.error('No se guardó',e.message) })
  return <section className="card memory-panel"><h2>Jira predeterminado</h2><p>Los proyectos usan este sitio cuando no tienen uno propio. En cada proyecto sólo necesitas indicar su clave, por ejemplo EGA.</p>
    <form className="memory-form" onSubmit={e=>{e.preventDefault();save.mutate()}}><Field label="Sitio de Jira predeterminado"><input type="url" placeholder="https://miempresa.atlassian.net" value={site ?? settings.data?.default_site_url ?? ''} onChange={e=>setSite(e.target.value)} disabled={settings.isPending || save.isPending} />
      <span className="field-hint">Puedes cambiar el sitio en cada proyecto. Deja este campo vacío para quitar el predeterminado.</span></Field>
      <ErrorBox error={settings.error ?? save.error} /><button className="btn btn-primary" disabled={settings.isPending || !!settings.error || save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar sitio de Jira'}</button></form>
  </section>
}
