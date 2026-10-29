import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Button, Empty, EmptyFiltered, ErrorState, Icon, List, MoreMenu, Row, SearchInput, Seg, SkeletonRows, Switch, Tag, hueFor, useToast } from "../../components/ui"
import { errorKey, useFormat, useT } from "../../i18n"
import { ApiError, api } from "../../lib/api"
import { resourceEnabled, useOverview } from "../../lib/local"
import type { LocalClient } from "../../lib/local"
import { useSkills } from "../../lib/queries"
import { draftFromSkillFile, importSkillZip, restoreSkill, saveBlob, slugify } from "../../lib/skills"
import type { SkillDraft } from "../../lib/skills"
import type { Skill } from "../../lib/types"
import { invalidateSkills, snapshotClientRule, snapshotRules, useSkillRule } from "./rules"
import { SkillPanel } from "./SkillPanel"

type Filter = "all" | "on" | "off"
type Selection = { kind: "edit"; id: string } | { kind: "create"; draft: SkillDraft; nonce: number } | null

const EMPTY_DRAFT: SkillDraft = { slug: "", displayName: "", description: "", body: "" }

/** Skills · plantilla A con panel ancho. `?new=skill` abre el panel de creación. */
export default function SkillsPage() {
  const { t, plural } = useT("skills")
  const errors = useT("errors").t
  const { list } = useFormat()
  const nav = useT("nav").t
  const common = useT("common").t
  const status = useT("status").t
  const skills = useSkills()
  const overview = useOverview()
  const rule = useSkillRule()
  const toast = useToast()
  const cache = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [selection, setSelection] = useState<Selection>(null)
  const [dirty, setDirty] = useState(false)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)
  const nonce = useRef(0)

  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  /** Con cambios sin guardar en el panel abierto no se reemplaza: el panel ya avisa al intentar cerrarlo. */
  const openCreate = useCallback((draft: SkillDraft = EMPTY_DRAFT) => {
    if (dirtyRef.current) return
    nonce.current += 1
    setSelection({ kind: "create", draft, nonce: nonce.current })
  }, [])

  useEffect(() => {
    if (params.get("new") !== "skill") return
    openCreate()
    const next = new URLSearchParams(params)
    next.delete("new")
    setParams(next, { replace: true })
  }, [params, setParams, openCreate])

  const rows = overview.data?.rows ?? []
  const clients = overview.data?.clients ?? []
  const rowOf = (id: string) => rows.find(row => row.resource_type === "skill" && row.resource_id === id)
  const all = useMemo(() => (skills.data ?? []).filter(skill => !hidden.has(skill.id)), [skills.data, hidden])
  const enabledCount = all.filter(skill => resourceEnabled(rowOf(skill.id))).length
  const needle = query.trim().toLowerCase()
  const visible = all.filter(skill => {
    if (needle && !`${skill.display_name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) return false
    if (filter === "all") return true
    return resourceEnabled(rowOf(skill.id)) === (filter === "on")
  })
  const selected = selection?.kind === "edit" ? all.find(skill => skill.id === selection.id) : undefined
  const takenSlugs = useMemo(() => new Set((skills.data ?? []).map(skill => skill.slug)), [skills.data])

  function select(next: Selection) {
    if (dirty) return
    setSelection(next)
  }

  function toggleAll(skill: Skill, enabled: boolean) {
    const before = snapshotRules(rowOf(skill.id), skill.id)
    rule.mutate([{ id: skill.id, state: enabled ? "on" : "off" }], {
      onSuccess: () => toast.show({
        message: t(enabled ? "toast.onAll" : "toast.offAll", { name: skill.display_name }),
        undo: () => rule.mutate(before),
      }),
    })
  }

  function toggleClient(skill: Skill, client: LocalClient, enabled: boolean) {
    const name = status(`client.${client.cli_kind}`)
    const before = snapshotClientRule(rowOf(skill.id), skill.id, client.id)
    rule.mutate([{ id: skill.id, state: enabled ? "on" : "off", client: client.id }], {
      onSuccess: () => toast.show({
        message: t(enabled ? "toast.onClient" : "toast.offClient", { name: skill.display_name, client: name }),
        undo: () => rule.mutate([before]),
      }),
    })
  }

  const unhide = useCallback((id: string) => setHidden(current => { const next = new Set(current); next.delete(id); return next }), [])

  /** Borrado suave en el acto; «Deshacer» la restaura mientras el servidor la conserva (30 min). */
  function deleteSkill(skill: Skill) {
    setHidden(current => new Set(current).add(skill.id))
    setDirty(false)
    setSelection(null)
    api.delete<void>(`/catalog/skills/${skill.id}`)
      .then(() => {
        void invalidateSkills(cache).then(() => unhide(skill.id))
        toast.show({
          message: common("toast.deleted", { name: skill.display_name }),
          undo: () => {
            restoreSkill(skill.id)
              .then(() => invalidateSkills(cache))
              .catch(error => toast.error(t("toast.restoreFailed", { name: skill.display_name }), restoreDetail(error)))
          },
        })
      })
      .catch(error => {
        unhide(skill.id)
        toast.error(t("toast.deleteFailed", { name: skill.display_name }), errors(errorKey(error)))
      })
  }

  function restoreDetail(error: unknown): string {
    if (error instanceof ApiError && error.status === 404) return t("toast.restoreExpired")
    if (error instanceof ApiError && error.status === 409) return t("toast.restoreConflict")
    return errors(errorKey(error))
  }

  function importDetail(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 409) return t("panel.slugTaken")
      if (error.status === 413) return errors("tooLarge")
      if (error.status === 415) return t("toast.importType")
      // 422 trae la causa concreta del ZIP (sin SKILL.md, ruta insegura, frontmatter incompleto).
      if (error.status === 422 && error.message) return t("toast.importInvalid", { detail: error.message })
    }
    return errors(errorKey(error))
  }

  async function exportSkill(skill: Skill) {
    try {
      saveBlob(await api.download(`/catalog/skills/${skill.id}/zip`), `${skill.slug}.zip`)
      toast.success(t("toast.exported", { name: skill.display_name }), t("toast.exportedDetail"))
    } catch (error) {
      toast.error(t("toast.exportFailed", { name: skill.display_name }), error instanceof Error ? error.message : undefined)
    }
  }

  function duplicate(skill: Skill) {
    let slug = slugify(`${skill.slug}-2`)
    for (let index = 3; takenSlugs.has(slug); index += 1) slug = slugify(`${skill.slug}-${index}`)
    openCreate({ slug, displayName: skill.display_name, description: skill.description, body: skill.body })
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (/\.zip$/i.test(file.name)) {
      try {
        const skill = await importSkillZip(file)
        await invalidateSkills(cache)
        setFilter("all")
        setQuery("")
        setSelection({ kind: "edit", id: skill.id })
        const ignored = skill.ignored_files
        toast.show({
          kind: ignored.length ? "info" : "success",
          message: t("toast.importedZip", { name: skill.display_name }),
          detail: ignored.length ? plural("toast.ignoredFiles", ignored.length, { files: list(ignored) }) : undefined,
          duration: ignored.length ? 10000 : undefined,
        })
      } catch (error) {
        toast.error(t("toast.importFailed"), importDetail(error))
      }
      return
    }
    try {
      const folder = file.name.replace(/\.md$/i, "")
      const draft = draftFromSkillFile(await file.text(), folder.toLowerCase() === "skill" ? "" : folder)
      openCreate(draft)
      toast.info(t("toast.imported"))
    } catch (error) {
      toast.error(t("toast.importFailed"), error instanceof Error ? error.message : undefined)
    }
  }

  const loading = skills.isPending || (overview.isPending && !overview.error)
  const loadError = skills.error ?? overview.error
  const clearFilters = () => { setQuery(""); setFilter("all") }

  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{nav("skills")}</h1></div>
          <div className="ph-actions">
            <Button variant="primary" icon="add" onClick={() => openCreate()}>{t("actions.newSkill")}</Button>
            <MoreMenu items={[{ label: t("actions.importFile"), onSelect: () => fileInput.current?.click() }]} />
            <input ref={fileInput} type="file" accept=".zip,.md,application/zip,text/markdown" hidden onChange={event => void importFile(event)} />
          </div>
        </div>

        {all.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
            <Seg<Filter>
              label={t("filter.label")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("filter.all"), count: all.length },
                { value: "on", label: t("filter.on"), count: enabledCount },
                { value: "off", label: t("filter.off"), count: all.length - enabledCount },
              ]}
            />
            <SearchInput label={t("search")} value={query} onChange={event => setQuery(event.target.value)} />
          </div>
        )}

        {loading ? <SkeletonRows label={common("states.loading")} />
          : loadError ? <List><ErrorState error={loadError} title={t("error.title")} onRetry={() => { void skills.refetch(); void overview.refetch() }} /></List>
            : all.length === 0 ? (
              <List>
                <Empty icon="book" title={t("empty.title")} detail={t("empty.detail")}
                  action={<Button small onClick={() => openCreate()}>{t("actions.newSkill")}</Button>} />
              </List>
            ) : visible.length === 0 ? (
              <List><EmptyFiltered text={needle ? t("empty.filtered", { query: query.trim() }) : t("empty.filteredState")} onClear={clearFilters} /></List>
            ) : (
              <List>
                {visible.map(skill => {
                  const enabled = resourceEnabled(rowOf(skill.id))
                  return (
                    <Row
                      key={skill.id}
                      selected={selection?.kind === "edit" && selection.id === skill.id}
                      onOpen={() => select({ kind: "edit", id: skill.id })}
                      lead={<span className={`av hue${hueFor(skill.slug)}`} aria-hidden="true"><Icon name="book" /></span>}
                      title={skill.display_name}
                      sub={skill.description || skill.slug}
                      meta={<>
                        <span className="mono trunc" style={{ maxWidth: "calc(var(--sp-7) * 4)" }} title={skill.slug}>{skill.slug}</span>
                        {skill.source === "external" ? <Tag title={skill.source_path}>{t("row.library")}</Tag> : <Tag>{t("row.version", { version: skill.version })}</Tag>}
                      </>}
                      action={<Switch checked={enabled} disabled={rule.isPending} label={t("row.toggle", { name: skill.display_name })} onChange={value => toggleAll(skill, value)} />}
                    />
                  )
                })}
              </List>
            )}
      </div>

      {selection?.kind === "create" && (
        <SkillPanel
          key={`create-${selection.nonce}`}
          mode="create"
          draft={selection.draft}
          takenSlugs={takenSlugs}
          onDirtyChange={setDirty}
          onClose={() => { setDirty(false); setSelection(null) }}
          onCreated={skill => { setDirty(false); setSelection({ kind: "edit", id: skill.id }) }}
        />
      )}
      {selected && (
        <SkillPanel
          key={`edit-${selected.id}`}
          mode="edit"
          skill={selected}
          row={rowOf(selected.id)}
          clients={clients}
          ruleBusy={rule.isPending}
          onDirtyChange={setDirty}
          onClose={() => { setDirty(false); setSelection(null) }}
          onExport={skill => void exportSkill(skill)}
          onDuplicate={duplicate}
          onDelete={deleteSkill}
          onToggleClient={toggleClient}
        />
      )}
    </div>
  )
}
