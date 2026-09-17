import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Modal, ConfirmDialog } from '../components/Modal'
import { ServerForm } from '../components/ServerForm'
import type { ServerFormPayload } from '../components/ServerForm'
import { SkillForm } from '../components/SkillForm'
import type { SkillFormPayload } from '../components/SkillForm'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { LOCAL_KEY, resourceEnabled, useLocalRule, useOverview } from '../lib/local'
import type { LocalClient } from '../lib/local'
import { queryKeys, useServers, useSkills, useToolCalls } from '../lib/queries'
import { CLI_FILE_SKILLS, CLI_LABELS } from '../lib/types'
import type { MatrixRow, McpServer, ResourceType, Skill } from '../lib/types'

/** Cliente OAuth propio para proveedores sin registro dinámico (Google, Slack, HubSpot). */
function OAuthClientForm({ server, onSaved }: { server: McpServer; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const toast = useToast()
  const settings = useQuery({ queryKey: ['oauth-settings'], queryFn: () => api.get<{ redirect_url: string }>('/oauth/settings'), enabled: open })
  const save = useMutation({
    mutationFn: () => api.post(`/catalog/servers/${server.id}/oauth/client`, { client_id: clientId.trim(), ...(clientSecret ? { client_secret: clientSecret } : {}) }),
    onSuccess: async () => { setClientSecret(''); setOpen(false); await onSaved(); toast.success('Credenciales guardadas', 'Ahora usá «Conectar cuenta».') },
    onError: e => toast.error('No se guardaron las credenciales', e.message),
  })
  return <div className="hub-oauth-client">
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(value => !value)}>{server.oauth_client_configured ? 'Cambiar credenciales de cliente' : 'Usar credenciales de cliente propias'}</button>
    {open && <form className="hub-oauth-client-form" onSubmit={event => { event.preventDefault(); if (clientId.trim()) save.mutate() }}>
      <p className="field-hint">Para proveedores sin registro dinámico de clientes: creá una app OAuth en el proveedor con esta URL de retorno y pegá acá su client ID y, si la tiene, su secreto. Quedan en un archivo privado de esta computadora, nunca en la base.</p>
      {settings.data && <code className="mono">{settings.data.redirect_url}</code>}
      <div className="hub-oauth-client-fields">
        <input aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" />
        <input aria-label="Client secret (opcional)" type="password" placeholder="Client secret (opcional)" value={clientSecret} onChange={event => setClientSecret(event.target.value)} autoComplete="off" />
        <button className="btn btn-sm btn-primary" type="submit" disabled={save.isPending || !clientId.trim()}>Guardar</button>
      </div>
    </form>}
  </div>
}

export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="hub-switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    onClick={() => onChange(!checked)}><span /></button>
}
function Heading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="hub-heading"><div><div className="hub-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="hub-actions">{children}</div></div>
}
function LoadError({ error, retry }: { error: Error | null; retry: () => unknown }) {
  return error ? <div className="hub-notice error" role="alert"><Icon name="alert" /><div><strong>No pudimos cargar los datos</strong><p>{error.message}</p></div><button className="btn" onClick={() => void retry()}>Reintentar</button></div> : null
}
function Loading() { return <div className="hub-loading" role="status"><Icon name="refresh" /> Cargando tu hub…</div> }
function Empty({ kind, title, children }: { kind: 'catalog' | 'skills'; title: string; children: ReactNode }) {
  return <div className="hub-empty"><div className="hub-empty-symbol"><Icon name={kind} /></div><span className="hub-eyebrow">UN SOLO LUGAR PARA TODO</span><h2>{title}</h2>{children}<div className="hub-empty-clients"><span>Claude Code</span><span>Codex</span><span>Gemini</span><span>Kiro</span><span>OpenCode</span><span>Claude Desktop</span></div></div>
}
function ClientAccess({ row, clients, type, id }: { row?: MatrixRow; clients: LocalClient[]; type: ResourceType; id: string }) {
  const change = useLocalRule()
  if (!clients.length) return <Link className="hub-inline-link" to="/clients">Conectar tus clientes <span>↗</span></Link>
  return <div className="hub-access"><span>Disponible en</span><div>{clients.map(client => {
    const checked = Boolean(row?.cells[client.id]?.exposed)
    return <button key={client.id} className={`hub-client-pill ${checked ? 'active' : ''}`} type="button" aria-pressed={checked}
      aria-label={`${checked ? 'Deshabilitar' : 'Habilitar'} ${CLI_LABELS[client.cli_kind]}`}
      title={client.enabled ? `Cambiar disponibilidad en ${CLI_LABELS[client.cli_kind]}` : 'Este cliente está pausado'}
      disabled={change.isPending || !client.enabled}
      onClick={() => change.mutate({ type, id, enabled: !checked, client: client.id })}>
      <span className="dot" />{CLI_LABELS[client.cli_kind]}</button>
  })}</div></div>
}
function SearchBar({ value, set, count, noun }: { value: string; set: (value: string) => void; count: number; noun: string }) {
  return <div className="hub-toolbar"><label className="hub-search"><Icon name="search" /><input aria-label={`Buscar ${noun}`} placeholder={`Buscar ${noun}…`} value={value} onChange={event => set(event.target.value)} /></label><span>{count} {noun}</span></div>
}

export function HubCatalog() {
  const servers = useServers()
  const overview = useOverview()
  const cache = useQueryClient()
  const toast = useToast()
  const rule = useLocalRule()
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<McpServer | 'new' | null>(null)
  const [removing, setRemoving] = useState<McpServer | null>(null)
  const [importing, setImporting] = useState(false)
  const [filter, setFilter] = useState('all')
  const invalidate = async () => { await Promise.all([cache.invalidateQueries({ queryKey: queryKeys.servers }), cache.invalidateQueries({ queryKey: LOCAL_KEY })]) }
  const save = useMutation({
    mutationFn: async (payload: ServerFormPayload) => {
      const server = form && form !== 'new' ? await api.patch<McpServer>(`/catalog/servers/${form.id}`, payload) : await api.post<McpServer>('/catalog/servers', payload)
      // A newly saved server should be usable immediately, with a visible connection result.
      // Saving succeeded even if the following connection attempt cannot finish.
      setForm(null)
      await invalidate()
      return api.post<McpServer>(`/catalog/servers/${server.id}/probe`)
    },
    onSuccess: async server => { await invalidate(); if (server.last_probe_error) toast.error('Guardado; falta conectar', server.last_probe_error); else toast.success('MCP listo', `${server.tools.length} herramientas disponibles`) },
    onError: async error => { await invalidate(); toast.error('No se completó la configuración', error.message) },
  })
  const probe = useMutation({ mutationFn: (id: string) => api.post<McpServer>(`/catalog/servers/${id}/probe`), onSuccess: async result => { await invalidate(); if (result.last_probe_error) toast.error('No se pudo conectar', result.last_probe_error); else toast.success('Conexión verificada', `${result.tools.length} herramientas`) }, onError: e => toast.error('Error de conexión', e.message) })
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/catalog/servers/${id}/approve`), onSuccess: invalidate, onError: e => toast.error('No se pudo aceptar el cambio', e.message) })
  const connect = useMutation({
    mutationFn: (id: string) => api.post<{ status: string; authorization_url?: string }>(`/catalog/servers/${id}/oauth/start`),
    onSuccess: async result => {
      await invalidate()
      if (result.authorization_url) {
        // En Electron esto abre el navegador del sistema; en un navegador, una pestaña nueva.
        window.open(result.authorization_url, '_blank', 'noopener')
        toast.success('Autorizá en el navegador', 'Cuando termines, la tarjeta se actualiza sola.')
      } else toast.success('Cuenta autorizada')
    },
    onError: e => toast.error('No se pudo iniciar la autorización', e.message),
  })
  const disconnect = useMutation({ mutationFn: (id: string) => api.post(`/catalog/servers/${id}/oauth/logout`), onSuccess: async () => { await invalidate(); toast.success('Cuenta desconectada') }, onError: e => toast.error('No se pudo desconectar', e.message) })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/catalog/servers/${id}`), onSuccess: async () => { setRemoving(null); await invalidate(); toast.success('MCP eliminado') }, onError: e => toast.error('No se pudo eliminar', e.message) })
  const rows = overview.data?.rows ?? []
  const serverRow = (id: string) => rows.find(row => row.resource_type === 'mcp_server' && row.resource_id === id)
  const all = servers.data ?? []
  const visible = all.filter(server => `${server.display_name} ${server.slug} ${server.description}`.toLowerCase().includes(search.toLowerCase()) &&
    (filter === 'all' || (filter === 'on' ? resourceEnabled(serverRow(server.id)) : !resourceEnabled(serverRow(server.id)))))
  const enabledCount = all.filter(s => resourceEnabled(serverRow(s.id))).length
  return <>
    <Heading eyebrow="TU HUB LOCAL" title="MCP servers" description="Conectá una vez. Usá tus herramientas en todos tus clientes.">
      <button className="btn" onClick={() => setImporting(true)}>Importar JSON</button>
      <button className="btn btn-primary" onClick={() => setForm('new')}><Icon name="plus" />Agregar MCP</button>
    </Heading>
    <LoadError error={servers.error ?? overview.error} retry={() => { void servers.refetch(); void overview.refetch() }} />
    {servers.isLoading ? <Loading /> : all.length === 0 ? <Empty kind="catalog" title="Tus herramientas, conectadas."><p>Agregá un MCP server y elegí dónde usarlo.<br />El hub mantiene la configuración de tus clientes al día.</p><button className="btn btn-primary btn-lg" onClick={() => setForm('new')}><Icon name="plus" />Agregar mi primer MCP</button><button className="btn btn-ghost" onClick={() => setImporting(true)}>Ya tengo una configuración JSON</button></Empty> : <>
      <div className="hub-stats"><div><span className="hub-stat-value">{all.length}</span><span>MCP servers</span></div><div><span className="hub-stat-value mint">{enabledCount}</span><span>Habilitados</span></div><div><span className="hub-stat-value">{all.reduce((n, s) => n + s.tools.length, 0)}</span><span>Herramientas</span></div><div><span className="hub-stat-value">{overview.data?.clients.filter(c => c.enabled).length ?? 0}</span><span>Clientes activos</span></div></div>
      <div className="hub-list-toolbar"><div className="hub-tabs">{[['all', 'Todos'], ['on', 'Habilitados'], ['off', 'Apagados']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div><SearchBar value={search} set={setSearch} count={visible.length} noun="servers" /></div>
      <div className="hub-resource-list">{visible.map(server => {
        const row = serverRow(server.id)
        const enabled = resourceEnabled(row)
        const changed = server.tools.filter(tool => tool.quarantined).length
        const busy = probe.isPending && probe.variables === server.id
        return <article className={`hub-resource ${!enabled ? 'disabled' : ''}`} key={server.id}>
          <div className="hub-resource-main"><div className="hub-resource-icon"><Icon name="catalog" /></div><div className="hub-resource-title"><div><h2>{server.display_name}</h2><span className="hub-tag">{server.transport === 'http' ? 'HTTP' : 'STDIO'}</span></div><p>{server.description || (server.transport === 'http' ? server.url : [server.command, ...server.args].join(' '))}</p></div><span className={`hub-state ${enabled ? 'on' : ''}`}><span className="dot" />{enabled ? 'Habilitado' : 'Apagado'}</span><Switch checked={enabled} disabled={rule.isPending} label={`${enabled ? 'Apagar' : 'Habilitar'} ${server.display_name} en todos los clientes`} onChange={value => rule.mutate({ type: 'mcp_server', id: server.id, enabled: value })} /></div>
          {server.last_probe_error && !(server.oauth_status === 'required' && server.last_probe_error.startsWith('requiere autorizar')) && <div className="hub-notice error"><Icon name="alert" /><span>{server.last_probe_error}{enabled && server.oauth_status !== 'required' && <span className="faint"> · se reintenta solo cada 30 s</span>}</span></div>}
          {server.auth === 'oauth' && <div className={`hub-notice ${server.oauth_status === 'required' ? 'error' : 'ok'}`}><Icon name={server.oauth_status === 'required' ? 'alert' : 'check'} /><span>{server.oauth_status === 'required' ? 'Falta autorizar la cuenta: se abre el navegador y volvés acá.' : 'Cuenta autorizada. Los tokens quedan en un archivo privado de esta computadora.'}</span>{server.oauth_status === 'required'
            ? <button className="btn btn-sm btn-primary" disabled={connect.isPending && connect.variables === server.id} onClick={() => connect.mutate(server.id)}>{connect.isPending && connect.variables === server.id ? 'Abriendo…' : 'Conectar cuenta'}</button>
            : <button className="btn btn-sm" disabled={disconnect.isPending && disconnect.variables === server.id} onClick={() => disconnect.mutate(server.id)}>Desconectar</button>}</div>}
          {server.auth === 'oauth' && server.oauth_status === 'required' && <OAuthClientForm server={server} onSaved={invalidate} />}
          {changed > 0 && <div className="hub-notice"><Icon name="alert" /><span>{changed} herramientas cambiaron o dejaron de estar disponibles. Revisá sus definiciones antes de habilitarlas.</span><button className="btn btn-sm" disabled={approve.isPending} onClick={() => approve.mutate(server.id)}>Aceptar cambios</button></div>}
          <div className="hub-resource-footer"><ClientAccess row={row} clients={overview.data?.clients ?? []} type="mcp_server" id={server.id} /><div className="hub-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => probe.mutate(server.id)}><Icon name="refresh" />{busy ? 'Conectando…' : 'Probar conexión'}</button><button className="btn btn-ghost btn-sm" onClick={() => setForm(server)}>Editar</button><button className="btn btn-ghost btn-sm destructive" aria-label={`Eliminar ${server.display_name}`} onClick={() => setRemoving(server)}><Icon name="x" /></button></div></div>
          <details className="hub-tools"><summary>{server.tools.length} herramientas <Icon name="chevron" /></summary><div>{server.tools.length === 0 ? <p>No se descubrieron herramientas. Probá la conexión para actualizar la lista.</p> : server.tools.map(tool => {
            const toolRow = rows.find(r => r.resource_type === 'mcp_tool' && r.resource_id === tool.id)
            const on = enabled && !tool.quarantined && resourceEnabled(toolRow)
            return <div className="hub-tool" key={tool.id}><div><code>{tool.name}</code><p>{tool.quarantined ? tool.quarantine_reason : tool.description || 'Sin descripción'}</p></div><Switch checked={on} disabled={!enabled || tool.quarantined || rule.isPending} label={`${on ? 'Apagar' : 'Habilitar'} herramienta ${tool.name}`} onChange={value => rule.mutate({ type: 'mcp_tool', id: tool.id, enabled: value })} /></div>
          })}</div></details>
        </article>
      })}</div>{visible.length === 0 && <p className="hub-no-results">No hay servers que coincidan con la búsqueda.</p>}
    </>}
    <ServerForm open={form !== null} server={form === 'new' ? null : form} busy={save.isPending} onSubmit={payload => save.mutate(payload)} onClose={() => setForm(null)} />
    <ConfirmDialog open={removing !== null} title="Eliminar MCP server" onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} busy={remove.isPending} confirmLabel="Eliminar" destructive message={<p>Se eliminará <strong>{removing?.display_name}</strong> del hub y dejará de estar disponible a través del hub en tus clientes.</p>} />
    <ImportMcp open={importing} close={() => setImporting(false)} saved={invalidate} />
  </>
}

function ImportMcp({ open, close, saved }: { open: boolean; close: () => void; saved: () => Promise<void> }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  async function importServers() {
    setError('')
    let entries: Array<[string, Record<string, unknown>]>
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const source = parsed.mcpServers ?? parsed.mcp_servers
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Pegá un objeto con la clave mcpServers o mcp_servers.')
      entries = Object.entries(source).filter(([name]) => name !== 'hub') as typeof entries
      if (!entries.length) throw new Error('No hay servers para importar. La entrada hub no se importa a sí misma.')
      for (const [name, entry] of entries) if (!entry || (!entry.command && !entry.url && !entry.httpUrl)) throw new Error(`${name}: falta command o url.`)
    } catch (e) { setError(e instanceof Error ? e.message : 'JSON inválido'); return }
    setBusy(true)
    const pending: Record<string, unknown> = {}
    let count = 0
    for (const [name, entry] of entries) {
      try {
        const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48)
        const transport = entry.url || entry.httpUrl ? 'http' : 'stdio'
        const server = await api.post<McpServer>('/catalog/servers', { slug, display_name: name, transport,
          command: entry.command ?? '', args: entry.args ?? [], env: entry.env ?? {}, cwd: entry.cwd ?? '',
          url: entry.url ?? entry.httpUrl ?? '', headers: entry.headers ?? entry.http_headers ?? {}, requires_host_access: true,
          auth: entry.auth === 'oauth' || entry.oauth === true ? 'oauth' : 'none' })
        count++
        if (entry.disabled === true || entry.enabled === false) await api.put('/policy/rules', { scope: 'user', resource_type: 'mcp_server', resource_id: server.id, state: 'off' })
        await api.post(`/catalog/servers/${server.id}/probe`).catch(() => undefined)
      } catch (e) { pending[name] = entry; setError(`${name}: ${e instanceof Error ? e.message : 'No se pudo importar'}`) }
    }
    await saved()
    setBusy(false)
    if (count) toast.success(`${count} MCP importados`)
    if (!Object.keys(pending).length) { setText(''); close() }
    else setText(JSON.stringify({ mcpServers: pending }, null, 2))
  }
  return <Modal open={open} onClose={close} title="Importar MCP servers" busy={busy} footer={<><button className="btn" disabled={busy} onClick={close}>Cancelar</button><button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void importServers()}>{busy ? 'Importando…' : 'Importar y conectar'}</button></>}>
    <p className="muted">Pegá la configuración de tu cliente. El hub conservará los comandos, argumentos y conexiones. No se modifica el archivo original.</p>
    <label className="field"><span className="field-label">Configuración JSON</span><textarea className="mono" rows={12} value={text} onChange={e => setText(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "mi-server": { "url": "http://localhost:3580/mcp" }\n  }\n}'} /></label>
    {error && <p role="alert" className="destructive">{error}</p>}
  </Modal>
}

export function HubSkills() {
  const skills = useSkills()
  const overview = useOverview()
  const cache = useQueryClient()
  const toast = useToast()
  const rule = useLocalRule()
  const [form, setForm] = useState<Skill | 'new' | null>(null)
  const [removing, setRemoving] = useState<Skill | null>(null)
  const [search, setSearch] = useState('')
  const invalidate = async () => { await Promise.all([cache.invalidateQueries({ queryKey: queryKeys.skills }), cache.invalidateQueries({ queryKey: LOCAL_KEY })]) }
  const save = useMutation({ mutationFn: (payload: SkillFormPayload) => form && form !== 'new' ? api.patch(`/catalog/skills/${form.id}`, payload) : api.post('/catalog/skills', payload), onSuccess: async () => { setForm(null); await invalidate(); toast.success('Skill guardada', 'Se está sincronizando con tus clientes.') }, onError: e => toast.error('No se pudo guardar', e.message) })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/catalog/skills/${id}`), onSuccess: async () => { setRemoving(null); await invalidate() }, onError: e => toast.error('No se pudo eliminar', e.message) })
  const all = skills.data ?? []
  const visible = all.filter(skill => `${skill.display_name} ${skill.slug} ${skill.description}`.toLowerCase().includes(search.toLowerCase()))
  return <><Heading eyebrow="CONOCIMIENTO COMPARTIDO" title="Skills" description="Tus instrucciones reutilizables, sincronizadas en tus clientes."><button className="btn btn-primary" onClick={() => setForm('new')}><Icon name="plus" />Agregar skill</button></Heading>
    <LoadError error={skills.error ?? overview.error} retry={() => { void skills.refetch(); void overview.refetch() }} />
    {skills.isLoading ? <Loading /> : all.length === 0 ? <Empty kind="skills" title="Enseñales una vez."><p>Guardá tus flujos de trabajo en una skill.<br />El hub mantiene una copia y la distribuye a los clientes que elijas.</p><button className="btn btn-primary btn-lg" onClick={() => setForm('new')}><Icon name="plus" />Crear mi primera skill</button></Empty> : <>
      <div className="hub-notice"><Icon name="info" /><span>Los archivos se actualizan automáticamente. Si una sesión ya cargó una skill, iniciá una nueva sesión para usar la versión actual.</span></div>
      <SearchBar value={search} set={setSearch} count={visible.length} noun="skills" />
      <div className="hub-resource-list">{visible.map(skill => {
        const row = overview.data?.rows.find(r => r.resource_type === 'skill' && r.resource_id === skill.id)
        const enabled = resourceEnabled(row)
        return <article key={skill.id} className={`hub-resource ${enabled ? '' : 'disabled'}`}><div className="hub-resource-main"><div className="hub-resource-icon violet"><Icon name="skills" /></div><div className="hub-resource-title"><div><h2>{skill.display_name}</h2><span className="hub-tag">v{skill.version}</span></div><p>{skill.description || skill.slug}</p></div><span className={`hub-state ${enabled ? 'on' : ''}`}>{enabled ? 'Habilitada' : 'Apagada'}</span><Switch checked={enabled} label={`${enabled ? 'Apagar' : 'Habilitar'} skill ${skill.display_name}`} disabled={rule.isPending} onChange={value => rule.mutate({ type: 'skill', id: skill.id, enabled: value })} /></div><div className="hub-resource-footer"><ClientAccess row={row} clients={overview.data?.clients ?? []} type="skill" id={skill.id} /><div className="hub-actions"><button className="btn btn-ghost btn-sm" onClick={() => setForm(skill)}>Editar</button><button className="btn btn-ghost btn-sm destructive" aria-label={`Eliminar ${skill.display_name}`} onClick={() => setRemoving(skill)}><Icon name="x" /></button></div></div><details className="hub-tools"><summary><code>{skill.slug}/SKILL.md</code><Icon name="chevron" /></summary><pre className="hub-skill-preview">{skill.body}</pre></details></article>
      })}</div>{!visible.length && <p className="hub-no-results">No hay skills que coincidan con la búsqueda.</p>}
    </>}
    <SkillForm open={form !== null} skill={form === 'new' ? null : form} busy={save.isPending} onSubmit={p => save.mutate(p)} onClose={() => setForm(null)} />
    <ConfirmDialog open={removing !== null} title="Eliminar skill" onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} busy={remove.isPending} confirmLabel="Eliminar" destructive message={<p>Se eliminará <strong>{removing?.display_name}</strong> del hub y se retirarán sus archivos administrados.</p>} />
  </>
}

export function HubClients() {
  const overview = useOverview()
  const cache = useQueryClient()
  const toast = useToast()
  const change = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/machines/agents/${id}`, { enabled }), onSuccess: () => cache.invalidateQueries({ queryKey: LOCAL_KEY }), onError: e => toast.error('No se pudo cambiar el cliente', e.message) })
  const sync = useMutation({ mutationFn: async () => { if (window.agentHub) await window.agentHub.syncNow(); await overview.refetch() }, onError: e => toast.error('No se pudo sincronizar', e.message) })
  const clients = overview.data?.clients ?? []
  const missing = Object.entries(CLI_LABELS).filter(([kind]) => !clients.some(c => c.cli_kind === kind))
  return <><Heading eyebrow="ESTA COMPUTADORA" title="Clientes" description="Los harness y terminales que usan tu catálogo local."><button className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}><Icon name="refresh" />{sync.isPending ? 'Buscando…' : 'Revisar clientes'}</button></Heading>
    <LoadError error={overview.error} retry={overview.refetch} />
    {overview.isLoading ? <Loading /> : <><div className="hub-notice"><Icon name="info" /><span>El hub detecta tus clientes y configura su conexión automáticamente. Después de conectar uno por primera vez, abrí una sesión nueva en ese cliente.</span></div>
      <div className="hub-client-grid">{clients.map(client => <article className="hub-client-card" key={client.id}><div className="hub-client-card-top"><span className={`hub-client-logo ${client.cli_kind}`}>{client.cli_kind === 'claude_code' || client.cli_kind === 'claude_desktop' ? '✳' : client.cli_kind === 'codex_cli' ? 'C' : client.cli_kind === 'gemini_cli' ? '✦' : client.cli_kind === 'opencode' ? 'O' : 'K'}</span><Switch checked={client.enabled} disabled={change.isPending} label={`${client.enabled ? 'Pausar' : 'Activar'} ${CLI_LABELS[client.cli_kind]}`} onChange={enabled => change.mutate({ id: client.id, enabled })} /></div><h2>{CLI_LABELS[client.cli_kind]}</h2><span className={`hub-state ${client.synchronized ? 'on' : 'pending'}`}><span className="dot" />{client.drift_detected ? 'Requiere atención' : !client.enabled ? 'Pausado' : client.synchronized ? 'Configuración sincronizada' : 'Sincronizando…'}</span><div className="hub-client-counts"><span><strong>{client.server_count}</strong> MCP servers</span>{CLI_FILE_SKILLS[client.cli_kind] ? <span><strong>{client.skill_count}</strong> skills</span> : <span title="Este cliente no carga skills desde el disco: se suben desde la propia app.">Skills desde la app</span>}</div><div className="hub-client-meta"><span>Archivo administrado</span><code>{client.config_path}</code><span>Última conexión al hub</span><strong>{client.last_connected_at ? new Date(client.last_connected_at).toLocaleString() : 'Todavía no inició una sesión'}</strong></div>{client.drift_detected && <div className="hub-notice error"><span>{client.drift_detail}</span></div>}</article>)}</div>
      {missing.length > 0 && <section className="hub-supported"><h3>{clients.length ? 'También podés conectar' : 'Clientes compatibles'}</h3><p>Instalá o abrí el cliente en esta computadora. El hub lo detectará sin volver a configurar tu catálogo.</p><div>{missing.map(([kind, label]) => <span key={kind}><Icon name="plus" />{label}<small>No detectado</small></span>)}</div></section>}
    </>}
  </>
}

export function HubActivity() {
  const calls = useToolCalls({ limit: 100 })
  const overview = useOverview()
  const [filter, setFilter] = useState('all')
  const visible = (calls.data ?? []).filter(call => filter === 'all' || (filter === 'error' ? Boolean(call.error) || call.decision === 'deny' : call.decision === 'allow' && !call.error))
  return <><Heading eyebrow="OBSERVABILIDAD LOCAL" title="Actividad" description="Las últimas llamadas que pasaron por el hub."><button className="btn" onClick={() => void calls.refetch()}><Icon name="refresh" />Actualizar</button></Heading><LoadError error={calls.error} retry={calls.refetch} /><div className="hub-tabs activity-tabs">{[['all', 'Todas'], ['ok', 'Ejecutadas'], ['error', 'Errores y bloqueos']].map(([id, text]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>)}</div>
    {calls.isLoading ? <Loading /> : !visible.length ? <div className="hub-activity-empty"><Icon name="audit" /><h2>{filter === 'all' ? 'Todavía no hay llamadas' : 'No hay llamadas en esta categoría'}</h2><p>Cuando un cliente use una herramienta del hub, vas a ver su resultado acá.</p></div> : <div className="hub-activity-table"><table><thead><tr><th>Herramienta</th><th>Cliente</th><th>Resultado</th><th>Duración</th><th>Hora</th></tr></thead><tbody>{visible.map(call => {
      const client = overview.data?.clients.find(c => c.id === call.agent_instance_id)
      const status = call.decision === 'deny' ? 'Bloqueada' : call.error ? 'Error' : 'Ejecutada'
      return <tr key={call.id}><td><code>{call.tool_name || call.exposed_name}</code><small>{call.server_slug}</small>{(call.error || call.denial_reason) && <details><summary>Ver detalle</summary><p>{call.error || call.denial_reason}</p></details>}</td><td>{client ? CLI_LABELS[client.cli_kind] : 'Cliente local'}</td><td><span className={`hub-state ${status === 'Ejecutada' ? 'on' : 'pending'}`}><span className="dot" />{status}</span></td><td className="mono">{call.duration_ms} ms</td><td>{new Date(call.created_at).toLocaleTimeString()}</td></tr>
    })}</tbody></table></div>}
  </>
}

export function HubSettings() {
  const toast = useToast()
  const cache = useQueryClient()
  const start = useQuery({ queryKey: ['desktop-autostart'], queryFn: () => window.agentHub?.getAutostart() ?? Promise.resolve(false) })
  const save = useMutation({ mutationFn: (enabled: boolean) => window.agentHub!.setAutostart(enabled), onSuccess: () => cache.invalidateQueries({ queryKey: ['desktop-autostart'] }), onError: e => toast.error('No se pudo guardar', e.message) })
  const restart = useMutation({ mutationFn: () => window.agentHub!.restartCore(), onError: e => toast.error('No se pudo reiniciar', e.message) })
  return <><Heading eyebrow="A TU MANERA" title="Ajustes" description="Un hub que vive en esta computadora." /><div className="hub-settings"><section><div><h2>Iniciar al encender la computadora</h2><p>Mantené tus clientes sincronizados desde que iniciás sesión.</p></div><Switch label="Iniciar Agent Hub al ingresar" checked={start.data ?? false} disabled={!window.agentHub || save.isPending || start.isLoading} onChange={value => save.mutate(value)} /></section><section><div><h2>Siempre disponible</h2><p>Cerrar la ventana deja el hub en segundo plano. Para detenerlo, elegí Salir en el menú de la bandeja.</p></div><Icon name="hub" /></section><section><div><h2>Servicio local</h2><p>Si el servicio dejó de responder, podés reiniciarlo conservando tu catálogo y configuración.</p></div><button className="btn" disabled={!window.agentHub || restart.isPending} onClick={() => restart.mutate()}>{restart.isPending ? 'Reiniciando…' : 'Reiniciar servicio'}</button></section><section><div><h2>Alcance de la sincronización</h2><p>El hub administra sus conexiones y skills en los clientes compatibles. Las configuraciones propias de un proyecto y los MCP conectados directamente en otra aplicación se administran desde esa aplicación.</p></div></section></div></>
}
