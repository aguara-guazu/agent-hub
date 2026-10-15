import { MediaSettings } from './MediaSettings'
import { NATIVE_EMBEDDING_MODEL } from './NativeEmbeddings'
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../components/Modal'
import { api } from '../lib/api'
import { useToast } from '../components/Toast'
import { Field, ProjectSelect, ErrorBox, MemoryFrame, MemoryMigration, PageHeading, formatTime, useMemory, useMemoryMutation, useMemoryStatus } from '../lib/memory'
import { CliExtraction, EXTRACTION_CLI_LABELS } from './CliExtraction'
import { JiraSettings } from './JiraSettings'

export function MemorySettings() { return <MemoryFrame setup><Settings /></MemoryFrame> }
const EMBEDDING_SETUP: Record<string, string> = {
  pending: 'Preparando EmbeddingGemma 2…',
  downloading: 'Descargando EmbeddingGemma 2. El índice actual sigue disponible; al terminar se activa y se regeneran los embeddings.',
  paused: 'La descarga de EmbeddingGemma 2 está pausada.',
  error: 'No se pudo descargar EmbeddingGemma 2. Se conserva el motor actual.',
}
function sameAI(a: any, b: any): boolean {
  return Boolean(a && b && Object.keys({ ...a, ...b }).every(key => a[key] === b[key]))
}
function Settings() {
  const status = useMemoryStatus(), cache = useQueryClient(), toast = useToast()
  const connectors = useMemory<any[]>('list_connectors', {}, status.data?.ready === true)
  const [connectorForm, setConnectorForm] = useState<any>(null), [credentials, setCredentials] = useState<any>(null)
  const sync = useMemoryMutation('sync_connector'), updateConnector = useMemoryMutation('save_connector')
  const repair = useMemoryMutation('repair_google', () => toast.success('Reparación encolada'))
  const [ai, setAI] = useState<any>(null), [savedAI, setSavedAI] = useState<any>(null)
  useEffect(() => {
    if (!status.data?.ready || !status.data.ai || sameAI(status.data.ai, savedAI)) return
    if (!ai || sameAI(ai, savedAI)) setAI(status.data.ai)
    setSavedAI(status.data.ai)
  }, [status.data, ai, savedAI])
  const saveAI = useMutation({ mutationFn: (selection: any) => api.put<any>('/memory/ai', selection), onSuccess: (saved, submitted) => {
    cache.setQueryData(['memory-status'], (current: any) => ({ ...current, ai: saved }))
    setSavedAI(saved)
    // Preserve edits made while the model check/save was in flight.
    setAI((current: any) => sameAI(current, submitted) ? saved : current)
    void status.refetch(); toast.success('Procesamiento configurado')
  }, onError: e => toast.error('No se guardó', e.message) })
  const canSaveAI = Boolean(status.data?.ready && ai && savedAI && !sameAI(ai, savedAI) && !saveAI.isPending)
  const tidyMemory = useMemoryMutation<any>('tidy_memory', () => toast.success('Revisión de memoria encolada'))
  const resumeEmbeddings = useMutation({ mutationFn: () => api.post('/memory/embeddings/native/install'), onSuccess: () => void status.refetch(), onError: e => toast.error('No se pudo reanudar la descarga', e.message) })
  const embeddingSetup = ['pending', 'downloading', 'paused', 'error'].includes(status.data?.defaults?.embedding_state) ? status.data!.defaults.embedding_state as string : null
  const reprocess = useMemoryMutation('reprocess', () => toast.success('Procesamiento encolado')), dedupe = useMemoryMutation('dedupe_people', () => toast.success('Búsqueda de duplicados encolada'))
  const oauth = useMutation({ mutationFn: (id: string) => api.post<{ authorization_url: string }>(`/memory/connectors/${id}/google/start`), onSuccess: result => window.open(result.authorization_url, '_blank', 'noopener,noreferrer'), onError: e => toast.error('No se pudo iniciar Google', e.message) })
  const backup = useMemoryMutation<any>('export_backup', async result => {
    let file: Blob
    try { file = await api.download(result.download_url.replace(/^\/api/, '')) } catch { toast.error('El respaldo se creó, pero no pudo descargarse'); return }
    const url = URL.createObjectURL(file), link = document.createElement('a')
    link.href = url; link.download = `agenthub-memory-${result.id}.json`; link.click(); URL.revokeObjectURL(url)
  })
  const restore = useMutation({ mutationFn: (body: unknown) => api.post('/memory/restore', body), onSuccess: () => { void cache.invalidateQueries(); toast.success('Memoria restaurada') }, onError: e => toast.error('No se restauró', e.message) })
  const workerActive = status.data?.worker?.heartbeat && Date.now() - Date.parse(status.data.worker.heartbeat) < 60_000
  return <><PageHeading title="Fuentes y ajustes" description="Elegí qué incorporar, controlá el procesamiento y revisá la cobertura." />
    {(status.data?.state === 'migrating' || status.data?.state === 'migration_pending') && <MemoryMigration status={status.data} />}
    {status.data?.state === 'unavailable' && <div className="hub-notice error" role="alert"><div><p>La base local no responde. Los datos siguen guardados en esta computadora.</p><p>{status.data.detail}</p></div></div>}
    {status.data?.ready && !workerActive && <div className="hub-notice" role="status"><p>El procesamiento en segundo plano no está activo: las fuentes nuevas esperan hasta que el servicio vuelva.</p></div>}
    <section className="memory-section"><div className="spread"><h2>Fuentes conectadas</h2><button className="btn btn-primary" disabled={!status.data?.ready} onClick={() => setConnectorForm({ provider: 'google', name: '', config: {}, project_ids: [], enabled: false, interval_minutes: 30 })}>Agregar fuente</button></div><ErrorBox error={connectors.error} />
      <div className="memory-connector-grid">{connectors.data?.map(connector => <div key={connector.id} className="card memory-panel"><div className="spread"><span className={`memory-provider provider-${connector.provider}`}>{connector.provider === 'google' ? 'G' : connector.provider[0].toUpperCase()}</span><span className={`badge ${connector.enabled ? 'badge-on' : ''}`}>{connector.enabled ? 'Activa' : 'Pausada'}</span></div>
        <h3>{connector.name}</h3><p className="muted">{connector.provider === 'google' ? connector.config.gmail_enabled !== false ? 'Calendar, Meet, documentos de Drive y Gmail' : 'Calendar, Meet y documentos de Drive' : connector.provider}</p>{connector.gmail_authorized === false && <p className="memory-inline-error">Falta autorizar la lectura de correos: «Conectar Google» y aceptar el permiso de Gmail.</p>}<p className="field-hint">Última sincronización: {connector.last_success_at ? formatTime(connector.last_success_at) : 'Todavía no se sincronizó'}</p>{connector.last_error && <p className="memory-inline-error">{connector.last_error}</p>}
        <div className="memory-button-wrap"><button className="btn btn-sm" onClick={() => setConnectorForm(connector)}>Configurar</button><button className="btn btn-sm" onClick={() => connector.provider === 'google' ? oauth.mutate(connector.id) : setCredentials(connector)}>{connector.provider === 'google' ? 'Conectar Google' : 'Credenciales'}</button>
          <button className="btn btn-sm" onClick={() => updateConnector.mutate({ id: connector.id, provider: connector.provider, name: connector.name, config: connector.config, project_ids: connector.project_ids, interval_minutes: connector.interval_minutes, enabled: !connector.enabled })}>{connector.enabled ? 'Pausar' : 'Activar'}</button>
          <button className="btn btn-primary btn-sm" disabled={!connector.enabled || sync.isPending} onClick={() => sync.mutate({ id: connector.id })}>Sincronizar</button>{connector.provider === 'google' && <button className="btn btn-sm" disabled={!connector.enabled || repair.isPending} onClick={() => repair.mutate({ id: connector.id })}>Actualizar hablantes y emails</button>}</div></div>)}</div>
      {!connectors.data?.length && <p className="memory-empty">Agregá Google para descubrir reuniones, o comenzá con una importación de archivo desde Explorar.</p>}
    </section>
    <section className="card memory-panel"><div className="spread"><h2>Acceso a Google</h2><span className="badge">{status.data?.google_client_configured ? 'Cliente configurado' : 'Pendiente'}</span></div>
      <p>Con el JSON del cliente OAuth de escritorio de Google alcanza: al guardarlo se crea la fuente Google y se abre la autorización en el navegador. Al aceptarla, la fuente queda activa y empieza a sincronizar.</p><p className="field-hint">APIs: Calendar, Meet, Drive, Docs, People y Gmail. Para resolver emails, reconectá Google y autorizá la lectura de contactos y directorio. Las identidades sin email disponible quedan pendientes de revisión.</p>
      <code className="memory-code">{status.data?.google_redirect_url}</code><button className="btn" onClick={() => setCredentials({ id: 'google-client', provider: 'google-client', name: 'Cliente OAuth de Google' })}>Configurar cliente OAuth</button>
    </section>
    {status.data?.ready && <JiraSettings />}
    {ai && <section className="card memory-panel"><h2>Procesamiento y búsqueda</h2><p>Los embeddings permiten buscar por significado. La extracción genera propuestas con evidencia para revisar.</p>
      <form className="memory-form" onSubmit={e => { e.preventDefault(); if (canSaveAI) saveAI.mutate({ ...ai, embeddings_enabled: true }) }}><div className="memory-form-grid"><Field label="Modelo de extracción"><select value={ai.extraction} onChange={e => setAI({ ...ai, extraction: e.target.value, extraction_reasoning_effort: '', extraction_model: e.target.value === 'deepseek' ? 'deepseek-flash' : ['ollama', ...Object.keys(EXTRACTION_CLI_LABELS)].includes(e.target.value) ? '' : ai.extraction_model })}><option value="disabled">Sin extracción automática</option>{['claude_code','codex_cli','opencode','kiro'].map(value => <option key={value} value={value}>{EXTRACTION_CLI_LABELS[value]} en segundo plano</option>)}<option value="ollama">Modelo local en Ollama</option><option value="deepseek">DeepSeek por API</option></select></Field>{!EXTRACTION_CLI_LABELS[ai.extraction] && <Field label="Nombre del modelo"><input required value={ai.extraction_model} onChange={e => setAI({ ...ai, extraction_model: e.target.value })} /></Field>}</div>
        {status.data?.defaults?.provider_state === 'needs_model' && <p className="field-hint" role="status">Elegí un modelo disponible para completar la configuración del proveedor.</p>}
        {!!EXTRACTION_CLI_LABELS[ai.extraction] && <><CliExtraction canSave={canSaveAI} saving={saveAI.isPending} onSave={() => { if (canSaveAI) saveAI.mutate(ai) }} key={ai.extraction} provider={ai.extraction} model={ai.extraction_model} onModel={extraction_model => setAI({ ...ai, extraction_model, extraction_reasoning_effort: '' })} effort={ai.extraction_reasoning_effort ?? ''} onEffort={extraction_reasoning_effort => setAI({ ...ai, extraction_reasoning_effort })} /><label className="check"><input type="checkbox" checked={ai.remote_processing_enabled} onChange={e => setAI({ ...ai, remote_processing_enabled: e.target.checked })} />Permitir enviar fragmentos al proveedor configurado en {EXTRACTION_CLI_LABELS[ai.extraction]}</label><p className="field-hint">Se respetan las fuentes y proyectos que excluyen el procesamiento remoto.</p></>}
        {ai.extraction === 'deepseek' && <div className="memory-callout"><p>DeepSeek recibirá los fragmentos que se procesen. Los datos guardados siguen en tu computadora.</p><label className="check"><input type="checkbox" checked={ai.remote_processing_enabled} onChange={e => setAI({ ...ai, remote_processing_enabled: e.target.checked })} />Permitir procesamiento con DeepSeek</label><button className="btn" type="button" onClick={() => setCredentials({ id: 'deepseek', provider: 'deepseek', name: 'DeepSeek' })}>{status.data?.deepseek_configured ? 'Cambiar clave' : 'Configurar clave'}</button></div>}
        <label className="check"><input type="checkbox" checked={ai.identity_auto_merge !== false} onChange={e => setAI({ ...ai, identity_auto_merge: e.target.checked })} />Unificar automáticamente hablantes y perfiles duplicados cuando la IA declara confianza alta</label>
        <label className="check"><input type="checkbox" checked={ai.project_auto_assign !== false} onChange={e => setAI({ ...ai, project_auto_assign: e.target.checked })} />Asociar automáticamente reuniones y documentos al proyecto cuando la IA lo identifica con confianza alta</label>
        <p className="field-hint">Lo que no alcanza confianza alta, o no coincide con ningún proyecto, aparece en Proyectos para que decidas: asociarlo, crear un proyecto o dejarlo sin proyecto.</p>
        <p className="field-hint">Los perfiles con el mismo email verificado se unifican siempre. En confianza media sólo se unifica un nombre completo idéntico frente a una etiqueta de documento sin email; el resto, y todo lo que tenga señales en contra, queda como propuesta en Por revisar. Cada unificación se registra en el historial de la persona.</p>
        <Field label="Motor de embeddings"><select value={ai.embedding_model === NATIVE_EMBEDDING_MODEL ? 'native' : 'ollama'} onChange={e => setAI({ ...ai, embeddings_enabled: true, embedding_model: e.target.value === 'native' ? NATIVE_EMBEDDING_MODEL : 'nomic-embed-text' })}><option value="native">EmbeddingGemma 2 integrado (recomendado)</option><option value="ollama">Ollama (legacy)</option></select></Field>
        {ai.embedding_model !== NATIVE_EMBEDDING_MODEL && <Field label="Modelo de embeddings en Ollama"><input required value={ai.embedding_model} onChange={e => setAI({ ...ai, embedding_model: e.target.value })} /></Field>}
        {(ai.embedding_model !== NATIVE_EMBEDDING_MODEL || ai.extraction === 'ollama') && <Field label="Dirección local de Ollama"><input required value={ai.ollama_url} onChange={e => setAI({ ...ai, ollama_url: e.target.value })} /></Field>}
        {embeddingSetup && <div className="memory-button-wrap" role="status"><p className="field-hint">{EMBEDDING_SETUP[embeddingSetup]}</p>{['paused','error'].includes(embeddingSetup) && <button type="button" className="btn btn-sm" disabled={resumeEmbeddings.isPending} onClick={() => resumeEmbeddings.mutate()}>Reintentar descarga</button>}</div>}
        <button className="btn" type="button" disabled={tidyMemory.isPending} onClick={() => tidyMemory.mutate({ force: true })}>Organizar la memoria</button><p className="field-hint">Revisa vigencias, archiva duplicados exactos de recuerdos y busca relaciones por significado. Conserva los originales y deja el resultado en Procesamiento.</p><ErrorBox error={tidyMemory.error} />
        <ErrorBox error={saveAI.error} /><div className="memory-button-wrap"><button className="btn btn-primary" disabled={!canSaveAI}>{saveAI.isPending ? !!EXTRACTION_CLI_LABELS[ai.extraction] && ai.remote_processing_enabled ? 'Probando y guardando…' : 'Guardando…' : 'Guardar configuración'}</button><button className="btn" type="button" disabled={!status.data?.ready || reprocess.isPending} onClick={() => reprocess.mutate({ force: true })}>Reprocesar fuentes importadas</button><button className="btn" type="button" disabled={!status.data?.ready || dedupe.isPending} onClick={() => dedupe.mutate({})}>Buscar personas duplicadas</button></div>
      </form>
    </section>}
    {status.data?.ready && <MediaSettings />}
    <section className="card memory-panel"><h2>Respaldos y restauración</h2><p>El respaldo incluye los originales y las relaciones. Las credenciales se configuran por separado. Para restaurar, la memoria de destino debe estar vacía.</p><button className="btn" disabled={!status.data?.ready || backup.isPending} onClick={() => backup.mutate({})}>Crear y descargar respaldo</button>
      <Field label="Restaurar respaldo en una memoria vacía"><input type="file" accept=".json" disabled={!status.data?.ready || restore.isPending} onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(content => { try { restore.mutate(JSON.parse(content)) } catch { toast.error('El respaldo no es JSON válido') } }).catch(() => toast.error('No se pudo leer el respaldo')) }} /></Field><ErrorBox error={restore.error} /></section>
    {connectorForm && <ConnectorForm connector={connectorForm} onClose={() => setConnectorForm(null)} />}{credentials && <CredentialsForm target={credentials} onClose={() => setCredentials(null)} />}
  </>
}
function ConnectorForm({ connector, onClose }: { connector: any; onClose: () => void }) {
  const [provider, setProvider] = useState(connector.provider), [name, setName] = useState(connector.name), [config, setConfig] = useState<any>(connector.config)
  const [projects, setProjects] = useState<string[]>(connector.project_ids), [interval, setInterval] = useState(connector.interval_minutes)
  const save = useMemoryMutation('save_connector', onClose)
  const listField = (key: string, label: string, placeholder: string) => <Field label={label}><textarea rows={2} value={(config[key] ?? []).join('\n')} placeholder={placeholder} onChange={e => setConfig({ ...config, [key]: e.target.value.split(/[\n,]+/).map((v: string) => v.trim()).filter(Boolean) })} /></Field>
  return <Modal open title={connector.id ? 'Configurar fuente' : 'Nueva fuente'} onClose={onClose} width={720} busy={save.isPending}><form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate({ ...(connector.id ? { id: connector.id } : {}), provider, name, config, project_ids: projects, interval_minutes: interval, enabled: connector.enabled }) }}>
    <div className="memory-form-grid"><Field label="Proveedor"><select value={provider} disabled={!!connector.id} onChange={e => { setProvider(e.target.value); setConfig({}) }}>{['google','notion','slack','jira'].map(p => <option key={p}>{p}</option>)}</select></Field><Field label="Nombre de la fuente"><input required value={name} onChange={e => setName(e.target.value)} placeholder="Google del trabajo" /></Field></div>
    {provider === 'google' && <>{listField('calendars', 'Calendarios (un ID por línea)', 'primary')}{listField('folder_ids','Carpetas de Drive (IDs)', 'Opcional: carpeta con documentos históricos')}{listField('document_ids','Documentos de Google (IDs)', 'Opcional: IDs de documentos concretos')}
      <label className="check"><input type="checkbox" checked={config.calendar_enabled !== false} onChange={e => setConfig({ ...config, calendar_enabled: e.target.checked })} />Importar eventos de Calendar</label><label className="check"><input type="checkbox" checked={config.meet_enabled !== false} onChange={e => setConfig({ ...config, meet_enabled: e.target.checked })} />Importar transcripciones de Meet disponibles</label>
      <label className="check"><input type="checkbox" checked={config.gmail_enabled !== false} onChange={e => setConfig({ ...config, gmail_enabled: e.target.checked })} />Importar correos de Gmail (recibidos y enviados)</label>
      {config.gmail_enabled !== false && <p className="field-hint">El buzón se revisa cada 2 minutos. Quedan afuera Promociones, Social, Spam, Papelera y borradores. Se importan los adjuntos PDF y de texto. Los secretos detectados (claves, tokens, contraseñas) se reemplazan antes de guardar.</p>}
      <p className="field-hint">Se sincronizan los últimos 90 días y, desde ahí, todo lo nuevo. Para traer correos o eventos más antiguos hay que pedírselo al agente, que lanza la sincronización de ese período.</p></>}
    {provider === 'notion' && <>{listField('page_ids','Páginas de Notion (IDs)', 'Vacío: páginas accesibles a la integración')}<p className="field-hint">La integración debe tener acceso a las páginas. Se recorren bloques anidados y páginas hijas.</p></>}
    {provider === 'slack' && <>{listField('channel_ids','Canales de Slack (IDs)', 'C0123456789')}<p className="field-hint">El token necesita acceso al historial, respuestas de hilos e información de usuarios de esos canales.</p></>}
    {provider === 'jira' && <><Field label="Sitio de Jira Cloud"><input type="url" required value={config.site_url ?? ''} placeholder="https://empresa.atlassian.net" onChange={e => setConfig({ ...config, site_url: e.target.value })} /></Field><Field label="Filtro de tareas (JQL)"><textarea required rows={3} value={config.jql ?? ''} placeholder="project = POC ORDER BY updated DESC" onChange={e => setConfig({ ...config, jql: e.target.value })} /></Field></>}
    {provider === 'slack' && <Field label="Importar desde"><input type="date" value={config.since?.slice(0,10) ?? ''} onChange={e => { const next = { ...config }; if (e.target.value) next.since = `${e.target.value}T00:00:00Z`; else delete next.since; setConfig(next) }} /></Field>}
    <ProjectSelect value={projects} onChange={setProjects} /><Field label="Revisar cambios cada (minutos)"><input type="number" min={5} max={1440} value={interval} onChange={e => setInterval(Number(e.target.value))} /></Field><p className="field-hint">Una fuente nueva queda pausada hasta que configures sus credenciales y la actives.</p><ErrorBox error={save.error} /><button className="btn btn-primary" disabled={save.isPending}>Guardar fuente</button>
  </form></Modal>
}
function CredentialsForm({ target, onClose }: { target: any; onClose: () => void }) {
  const [token, setToken] = useState(''), [clientId, setClientId] = useState(''), [email, setEmail] = useState(''), cache = useQueryClient()
  const save = useMutation({ mutationFn: () => api.put<{ authorization_url?: string }>(`/memory/credentials/${target.id}`, target.provider === 'google-client' ? { client_id: clientId, ...(token ? { client_secret: token } : {}) } : target.provider === 'deepseek' ? { api_key: token } : { token, ...(email ? { email } : {}) }), onSuccess: result => {
    setToken('')
    void cache.invalidateQueries()
    if (result?.authorization_url) window.open(result.authorization_url, '_blank', 'noopener,noreferrer')
    onClose()
  } })
  async function loadGoogle(file?: File) {
    if (!file) return
    try { const data = JSON.parse(await file.text()); const client = data.installed ?? data.web; if (client?.client_id) { setClientId(client.client_id); setToken(client.client_secret ?? '') } } catch { /* the editable inputs remain available */ }
  }
  return <Modal open title={`Conectar ${target.name}`} onClose={onClose} busy={save.isPending}><form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate() }}>
    {target.provider === 'google-client' && <><Field label="Archivo de cliente OAuth de Google"><input type="file" accept=".json" onChange={e => void loadGoogle(e.target.files?.[0])} /></Field><Field label="Client ID"><input required value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" /></Field></>}
    {target.provider === 'jira' && <Field label="Email de Jira"><input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>}
    <Field label={target.provider === 'google-client' ? 'Client secret (si corresponde)' : 'API key o token'}><input type="password" required={target.provider !== 'google-client'} autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></Field><p className="field-hint">Se guarda en un archivo privado de esta computadora. No se incluye en respaldos ni se devuelve al leer la configuración.</p><ErrorBox error={save.error} /><button className="btn btn-primary" disabled={save.isPending}>Guardar credencial</button></form></Modal>
}
