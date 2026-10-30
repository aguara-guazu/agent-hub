import { Suspense, lazy, useEffect, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  Avatar, Button, Chip, ConfirmDialog, Dl, ErrorState, Input, Menu, MoreMenu, SkeletonRows, TabPanel, Tabs, useToast,
  type MenuItem, type TabItem,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { entityPath, useMemory, type MemoryEntity, type Page } from "../../lib/memory"
import { useProjectAutomation } from "../../lib/project-automation"
import { STAGE_CHOICES, isRelation, listDate, projectActivity, projectStage, useProjectContentCount, type Stage } from "../../lib/projects"
import { AttachDialog, NoteDialog } from "./dialogs"
import { AutomationPanel, CollectionPanel, DetailsPanel, HistoryPanel, LinkPanel, type EntityLink, type ProjectDetail } from "./panels"
import { StageChip, useErrorText, useMemoryAction, useNarrow } from "./shared"
import { SharePanel } from "./collaboration/SharePanel"
import { PanelSlotContext } from "./work"

const Resumen = lazy(() => import("./tabs/Resumen"))
const Contenido = lazy(() => import("./tabs/Contenido"))
const Tareas = lazy(() => import("./tabs/Tareas"))
const Decisiones = lazy(() => import("./tabs/Decisiones"))
const Colaboracion = lazy(() => import("./tabs/Colaboracion"))
const Notas = lazy(() => import("./tabs/Notas"))

// Seis pestañas: excepción acordada con la persona al máximo de cinco (Notas va aparte de Colaboración).
type Tab = "resumen" | "contenido" | "tareas" | "decisiones" | "colaboracion" | "notas"
const TABS: readonly Tab[] = ["resumen", "contenido", "tareas", "decisiones", "colaboracion", "notas"]
type PanelKind = "details" | "link" | "history" | "automation" | "collection" | "share"
const PANELS: readonly PanelKind[] = ["details", "link", "history", "automation", "collection", "share"]
type AddKind = "note" | "files"

const BARE: CSSProperties = { border: 0, background: "transparent", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }

/** Ficha de proyecto · plantilla B. `/projects/:id` con `?tab=`, `?panel=` y `?add=`; otra entidad redirige a `/memory/entities/:id`. */
export default function ProjectPage() {
  const { id } = useParams()
  if (!id) return <Navigate to="/projects" replace />
  return <ProjectLoader key={id} id={id} />
}

function ProjectLoader({ id }: { id: string }) {
  const { t } = useT("project")
  const common = useT("common").t
  const detail = useMemory<ProjectDetail>("get_entity", { id })
  if (detail.isPending) return <div className="page"><Crumbs /><SkeletonRows count={4} /></div>
  if (detail.error || !detail.data?.entity) {
    return (
      <div className="page">
        <Crumbs />
        <div className="list">
          <ErrorState error={detail.error} title={t("header.errorTitle")} action={<div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <Button small onClick={() => void detail.refetch()}>{common("actions.retry")}</Button>
            <Link className="btn btn-sm btn-ghost" to="/projects">{t("header.backToProjects")}</Link>
          </div>} />
        </div>
      </div>
    )
  }
  if (detail.data.entity.kind !== "project") return <Navigate to={`/memory/entities/${id}`} replace />
  return <ProjectView detail={detail.data} />
}

function Crumbs() {
  const { t } = useT("project")
  return <nav className="crumbs" aria-label={t("header.crumbs")}><Link to="/projects">{t("header.crumbs")}</Link><span aria-hidden="true">/</span></nav>
}

function ProjectView({ detail }: { detail: ProjectDetail }) {
  const project = detail.entity
  const { t } = useT("project")
  const common = useT("common").t
  const format = useFormat()
  const navigate = useNavigate()
  const toast = useToast()
  const narrow = useNarrow()
  const [params, setParams] = useSearchParams()
  const tab = TABS.find(value => value === params.get("tab")) ?? "resumen"
  const panel = PANELS.find(value => value === params.get("panel")) ?? null
  const [adding, setAdding] = useState<AddKind | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null)
  const remove = useMemoryAction("delete_entity")

  const setParam = (key: string, value: string | null) => setParams(current => {
    const next = new URLSearchParams(current)
    if (value === null) next.delete(key)
    else next.set(key, value)
    if (key === "tab") { next.delete("kind"); next.delete("view") }
    return next
  }, { replace: true })
  const openPanel = (kind: PanelKind | null) => setParam("panel", kind)

  useEffect(() => {
    const add = params.get("add")
    if (add !== "note" && add !== "files") return
    setAdding(add)
    setParam("add", null)
  // setParam se recrea en cada render; el efecto solo reacciona a `?add=`.
  }, [params])

  const contentCount = useProjectContentCount(project.id).data
  const decisionCount = useProjectContentCount(project.id, "fact").data
  const tasks = useMemory<Page<unknown>>("list_tasks", { project_id: project.id, status: "open", limit: 1, offset: 0 })
  const tabs: TabItem<Tab>[] = [
    { value: "resumen", label: t("header.tabs.resumen") },
    { value: "contenido", label: t("header.tabs.contenido"), count: contentCount || undefined },
    { value: "tareas", label: t("header.tabs.tareas"), count: tasks.data?.total || undefined },
    { value: "decisiones", label: t("header.tabs.decisiones"), count: decisionCount || undefined },
    { value: "colaboracion", label: t("header.tabs.colaboracion") },
    { value: "notas", label: t("header.tabs.notas") },
  ]

  const addItems: MenuItem[] = [
    { label: t("header.addNote"), icon: "note", onSelect: () => setAdding("note") },
    { label: t("header.addFiles"), icon: "document", onSelect: () => setAdding("files") },
    { label: t("header.addTask"), icon: "done", onSelect: () => setParam("tab", "tareas") },
    { label: t("header.addCollection"), icon: "add", onSelect: () => openPanel("collection") },
  ]
  const moreItems: MenuItem[] = [
    { label: t("header.editDetails"), icon: "settings", onSelect: () => openPanel("details") },
    { label: t("header.link"), icon: "collaboration", onSelect: () => openPanel("link") },
    { label: t("header.viewHistory"), icon: "activity", onSelect: () => openPanel("history") },
    { label: t("header.delete"), danger: true, onSelect: () => setDeleting(true) },
  ]

  function confirmDelete() {
    remove.mutate({ id: project.id }, {
      onSuccess: () => { setDeleting(false); toast.success(common("toast.deleted", { name: project.title })); navigate("/projects") },
    })
  }

  const companyId = typeof project.data.company_id === "string" ? project.data.company_id : ""
  const company = detail.links.find(link => link.entity.id === companyId)?.entity
  const updated = projectActivity(project)

  return (
    <div className="split">
      <div className="page" style={{ gap: "var(--sp-4)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <Crumbs />
          <div className="ph" style={{ alignItems: "flex-start" }}>
            <div className="ph-text" style={{ flexDirection: "row", gap: "var(--sp-3)", alignItems: "center" }}>
              <Avatar name={project.title} />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0, flex: 1 }}>
                <InlineTitle project={project} />
                <div className="xs t3" style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
                  <StageMenu project={project} />
                  {company && <Link to={entityPath(company)}>{company.title}</Link>}
                  <span title={format.date(updated, "datetime")}>{t("header.updated", { when: listDate(updated, format.language, format.relative) })}</span>
                </div>
              </div>
            </div>
            <div className="ph-actions">
              <Button icon="collaboration" onClick={() => openPanel("share")}>{t("header.share")}</Button>
              <Menu
                items={addItems}
                label={t("header.addMenu")}
                trigger={props => <Button {...props} variant="primary" icon="add">{t("header.add")}</Button>}
              />
              <MoreMenu items={moreItems} />
            </div>
          </div>
        </div>

        <Tabs<Tab> tabs={tabs} value={tab} onChange={value => setParam("tab", value === "resumen" ? null : value)} label={t("header.tabs.label")} idPrefix="project-tab" max={TABS.length} />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)", alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 520px", minWidth: 0 }}>
            <TabPanel idPrefix="project-tab" value={tab}>
              <PanelSlotContext.Provider value={panel ? null : panelSlot}>
              <Suspense fallback={<SkeletonRows count={3} avatar={false} />}>
                {tab === "resumen" && <Resumen project={project} />}
                {tab === "contenido" && <Contenido project={project} />}
                {tab === "tareas" && <Tareas project={project} />}
                {tab === "decisiones" && <Decisiones project={project} />}
                {tab === "colaboracion" && <Colaboracion project={project} />}
                {tab === "notas" && <Notas project={project} />}
              </Suspense>
              </PanelSlotContext.Provider>
            </TabPanel>
          </div>
          {/* Colaboración ocupa todo el ancho: tres columnas canales › hilos › debate. */}
          {tab !== "colaboracion" && <ProjectAside detail={detail} company={company} narrow={narrow} onPanel={openPanel} />}
        </div>
      </div>

      {/* Zona de paneles de las pestañas (Tareas, Decisiones, Colaboración); oculta mientras haya un `?panel=` de la ficha. */}
      <div ref={setPanelSlot} style={{ display: "contents" }} />
      {panel === "details" && <DetailsPanel project={project} onClose={() => openPanel(null)} />}
      {panel === "link" && <LinkPanel project={project} links={detail.links} onClose={() => openPanel(null)} />}
      {panel === "history" && <HistoryPanel detail={detail} onClose={() => openPanel(null)} />}
      {panel === "automation" && <AutomationPanel project={project} onClose={() => openPanel(null)} />}
      {panel === "collection" && <CollectionPanel projectId={project.id} onClose={() => openPanel(null)} />}
      {panel === "share" && <SharePanel project={project} onClose={() => openPanel(null)} />}

      <NoteDialog open={adding === "note"} projectId={project.id} onClose={() => setAdding(null)} />
      <AttachDialog open={adding === "files"} projectId={project.id} onClose={() => setAdding(null)} />
      <ConfirmDialog
        open={deleting}
        title={t("header.deleteTitle", { name: project.title })}
        message={t("header.deleteMessage")}
        confirmLabel={t("header.delete")}
        busy={remove.isPending}
        onClose={() => setDeleting(false)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/** Título editable en línea: Enter o perder el foco guardan, Escape cancela. */
function InlineTitle({ project }: { project: MemoryEntity }) {
  const { t } = useT("project")
  const toast = useToast()
  const errorText = useErrorText()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(project.title)
  const field = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const update = useMemoryAction<MemoryEntity>("update_entity", { quiet: true })
  useEffect(() => { if (!editing) setValue(project.title) }, [project.title, editing])
  useEffect(() => { if (editing) { done.current = false; field.current?.select() } }, [editing])
  function commit() {
    if (done.current) return
    done.current = true
    setEditing(false)
    const title = value.trim()
    if (!title || title === project.title) { setValue(project.title); return }
    update.mutate({ id: project.id, title }, {
      onSuccess: () => toast.success(t("header.toast.renamed")),
      onError: failure => { setValue(project.title); toast.error(errorText(failure)) },
    })
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); commit() }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done.current = true; setValue(project.title); setEditing(false) }
  }
  if (editing) {
    return <Input ref={field} aria-label={t("header.titleLabel")} value={value} maxLength={500} className="h1" style={{ height: "auto" }} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
  }
  return (
    <h1 className="h1 trunc" title={project.title}>
      <button type="button" style={{ ...BARE, maxWidth: "100%" }} className="trunc" aria-label={`${t("header.editTitle")}: ${project.title}`} onClick={() => setEditing(true)}>
        {update.isPending ? value : project.title}
      </button>
    </h1>
  )
}

/** Etapa en el encabezado: el chip abre un menú; el cambio se aplica al instante con Deshacer. */
function StageMenu({ project }: { project: MemoryEntity }) {
  const { t } = useT("project")
  const status = useT("status").t
  const toast = useToast()
  const update = useMemoryAction("update_entity")
  const current = projectStage(project)
  const apply = (stage: Stage, previous: Stage | null) => update.mutate({ id: project.id, data: { status: stage } }, {
    onSuccess: () => {
      if (previous) toast.show({ kind: "success", message: t("header.toast.stage", { stage: status(`stage.${stage}`) }), undo: () => apply(previous, null) })
    },
  })
  const items: MenuItem[] = STAGE_CHOICES.filter(stage => stage !== current).map(stage => ({ label: status(`stage.${stage}`), onSelect: () => apply(stage, current) }))
  return (
    <Menu
      items={items}
      align="start"
      label={t("header.stageMenu")}
      trigger={props => (
        <button {...props} type="button" style={BARE} aria-label={`${t("header.stageMenu")}: ${status(`stage.${current}`)}`} disabled={update.isPending}>
          <StageChip stage={current} />
        </button>
      )}
    />
  )
}

const CONNECTIONS_SHOWN = 6

function ProjectAside({ detail, company, narrow, onPanel }: { detail: ProjectDetail; company?: MemoryEntity; narrow: boolean; onPanel: (kind: PanelKind) => void }) {
  const project = detail.entity
  const { t, plural } = useT("project")
  const status = useT("status").t
  const [all, setAll] = useState(false)
  const folders: string[] = Array.isArray(project.data.folders) ? project.data.folders : []
  const connections = detail.links.filter((link: EntityLink) => link.type !== "project" || link.from_id === project.id)
  const shown = all ? connections : connections.slice(0, CONNECTIONS_SHOWN)
  return (
    <aside style={{ flex: "1 1 280px", maxWidth: narrow ? "none" : 340, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      <section className="section">
        <h2 className="h3">{t("header.aside.details")}</h2>
        <Dl items={[
          { label: t("header.aside.company"), value: company ? <Link to={entityPath(company)}>{company.title}</Link> : null },
          { label: t("header.aside.stage"), value: status(`stage.${projectStage(project)}`) },
          { label: t("header.aside.folders"), value: folders.length ? <span style={{ display: "flex", flexDirection: "column" }}>{folders.map(folder => <span key={folder} className="mono trunc" title={folder}>{folder}</span>)}</span> : null },
          { label: t("header.aside.remote"), value: project.data.remote_processing === false ? t("header.aside.remoteBlocked") : t("header.aside.remoteAllowed") },
        ]} />
        <Button small variant="ghost" style={{ alignSelf: "flex-start", marginLeft: "calc(var(--sp-2) * -1)" }} onClick={() => onPanel("details")}>{t("header.editDetails")}</Button>
      </section>
      <hr className="divider" />
      <AutomationBlock projectId={project.id} onConfigure={() => onPanel("automation")} />
      <hr className="divider" />
      <section className="section">
        <div className="section-h" style={{ minHeight: 0 }}>
          <h2 className="h3">{t("header.aside.connections")}</h2>
          <Button small variant="ghost" onClick={() => onPanel("link")}>{t("header.link")}</Button>
        </div>
        {connections.length === 0 ? <span className="t3">{t("header.aside.noConnections")}</span> : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            {shown.map(link => (
              <Link key={link.id} to={entityPath(link.entity)} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", color: "var(--text)", minWidth: 0 }}>
                <Avatar name={link.entity.title} small round={link.entity.kind === "person"} />
                <span className="trunc" style={{ flex: 1 }} title={link.entity.title}>{link.entity.title}</span>
                <span className="xs t3">{isRelation(link.type) ? status(`relation.${link.type}`) : link.type}</span>
              </Link>
            ))}
            {!all && connections.length > CONNECTIONS_SHOWN && (
              <Button small variant="ghost" style={{ alignSelf: "flex-start", marginLeft: "calc(var(--sp-2) * -1)" }} onClick={() => setAll(true)}>
                {plural("header.aside.moreConnections", connections.length - CONNECTIONS_SHOWN)}
              </Button>
            )}
          </div>
        )}
      </section>
    </aside>
  )
}

/** Estado de Brief y cierre. Activar exige la delegación completa (roster, canal, repositorios): no cabe en un interruptor, se configura en el panel. */
function AutomationBlock({ projectId, onConfigure }: { projectId: string; onConfigure: () => void }) {
  const { t } = useT("project")
  const status = useT("status").t
  const automation = useProjectAutomation(projectId)
  const view = automation.data
  const active = Boolean(view?.enabled && view.delegation)
  const review = active && view?.delegation?.approval_source === "coordinator_declaration"
  return (
    <section className="section">
      <h2 className="h3">{t("header.aside.automations")}</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <div className="row-main">
          <span style={{ fontWeight: 500 }}>{t("header.aside.briefClose")}</span>
          <span className="xs t3 trunc" title={t("header.aside.briefCloseDetail")}>{t("header.aside.briefCloseDetail")}</span>
        </div>
        {automation.isPending ? null
          : automation.error ? <Chip tone="danger">{status("chip.error")}</Chip>
          : review ? <Chip tone="warn">{t("header.aside.automationReview")}</Chip>
          : <Chip tone={active ? "ok" : "off"}>{t(active ? "header.aside.automationOn" : "header.aside.automationOff")}</Chip>}
      </div>
      <Button small variant="ghost" style={{ alignSelf: "flex-start", marginLeft: "calc(var(--sp-2) * -1)" }} onClick={onConfigure}>{t("header.aside.configure")}</Button>
    </section>
  )
}

