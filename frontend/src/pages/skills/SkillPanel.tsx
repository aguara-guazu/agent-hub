import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { shortHash } from "../../components/DataTable"
import { Button, Chip, Dl, Field, Input, MoreMenu, Panel, PanelBody, PanelFooter, PanelHeader, Switch, Tag, Textarea, useToast } from "../../components/ui"
import type { MenuItem } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import type { LocalClient } from "../../lib/local"
import { SKILL_SLUG_RE, extractBodyFrontmatter, renderFrontmatter } from "../../lib/skills"
import type { SkillDraft } from "../../lib/skills"
import { CLI_FILE_SKILLS } from "../../lib/types"
import type { ClaudeAiSkillStatus, MatrixRow, Skill } from "../../lib/types"
import { invalidateSkills } from "./rules"

const CLAUDE_AI_TONE: Record<ClaudeAiSkillStatus["status"], "ok" | "warn"> = { synced: "ok", stale: "warn", missing: "warn" }

export interface SkillPanelActions {
  onExport: (skill: Skill) => void
  onDuplicate: (skill: Skill) => void
  onDelete: (skill: Skill) => void
  onToggleClient: (skill: Skill, client: LocalClient, enabled: boolean) => void
}

interface EditProps extends SkillPanelActions {
  mode: "edit"
  skill: Skill
  row?: MatrixRow
  clients: LocalClient[]
  ruleBusy: boolean
}

interface CreateProps {
  mode: "create"
  draft: SkillDraft
  takenSlugs: ReadonlySet<string>
  onCreated: (skill: Skill) => void
}

type SkillPanelProps = (EditProps | CreateProps) & { onClose: () => void; onDirtyChange: (dirty: boolean) => void }

function toDraft(skill: Skill): SkillDraft {
  return { slug: skill.slug, displayName: skill.display_name, description: skill.description, body: skill.body }
}

/** Panel ancho de la skill. Los campos usan guardado explícito; los interruptores por cliente aplican al instante. */
export function SkillPanel(props: SkillPanelProps) {
  const { t } = useT("skills")
  const common = useT("common").t
  const toast = useToast()
  const cache = useQueryClient()
  const creating = props.mode === "create"
  const skill = props.mode === "edit" ? props.skill : null
  const external = skill?.source === "external"
  // El padre monta un panel por skill (key): el estado inicial no sigue a los refetch mientras se edita.
  const [initial, setInitial] = useState<SkillDraft>(() => (props.mode === "edit" ? toDraft(props.skill) : props.draft))
  const [draft, setDraft] = useState<SkillDraft>(initial)
  const [touched, setTouched] = useState<{ slug?: boolean; name?: boolean }>({})
  const [blocked, setBlocked] = useState(false)

  const dirty = creating
    ? Boolean(draft.slug || draft.displayName || draft.description || draft.body)
    : draft.displayName !== initial.displayName || draft.description !== initial.description || draft.body !== initial.body
  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setBlocked(false)
  }

  const slug = draft.slug.trim()
  const slugError = !creating ? undefined
    : !SKILL_SLUG_RE.test(slug) ? t("panel.slugInvalid")
      : props.mode === "create" && props.takenSlugs.has(slug) ? t("panel.slugTaken") : undefined
  const nameError = draft.displayName.trim() === "" ? t("panel.nameRequired") : undefined
  const bodyHeader = useMemo(() => extractBodyFrontmatter(draft.body), [draft.body])
  const effectiveSlug = creating ? slug : skill?.slug ?? ""
  const mismatch = bodyHeader !== null && bodyHeader.name !== "" && bodyHeader.name !== effectiveSlug
  const valid = !slugError && !nameError && !mismatch

  const notifyDirty = props.onDirtyChange
  useEffect(() => { notifyDirty(dirty) }, [dirty, notifyDirty])
  const save = useMutation({
    mutationFn: () => {
      const payload = { display_name: draft.displayName.trim(), description: draft.description.trim(), body: draft.body }
      return skill ? api.patch<Skill>(`/catalog/skills/${skill.id}`, payload) : api.post<Skill>("/catalog/skills", { ...payload, slug })
    },
    onSuccess: async saved => {
      await invalidateSkills(cache)
      if (props.mode === "create") {
        toast.success(t("toast.created", { name: saved.display_name }))
        props.onCreated(saved)
      } else {
        setInitial(toDraft(saved))
        toast.success(common("states.saved"))
      }
    },
    onError: error => toast.error(t("toast.saveFailed"), error.message),
  })

  function submit() {
    setTouched({ slug: true, name: true })
    if (valid && !save.isPending) save.mutate()
  }
  function discard() {
    setDraft(initial)
    setTouched({})
    setBlocked(false)
  }
  function edit<K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) {
    set(key, value)
  }

  const frontmatter = renderFrontmatter(effectiveSlug || "skill", draft.description, draft.displayName)
  const menu: MenuItem[] = props.mode === "edit" ? [
    { label: t("actions.export"), onSelect: () => props.onExport(props.skill) },
    { label: t("actions.duplicate"), onSelect: () => props.onDuplicate(props.skill) },
    ...(external ? [] : [{ label: t("actions.delete"), danger: true, onSelect: () => props.onDelete(props.skill) }]),
  ] : []

  return (
    <Panel label={skill?.display_name ?? t("panel.newTitle")} onClose={props.onClose} wide dirty={dirty} onBlockedClose={() => setBlocked(true)}>
      <PanelHeader
        title={skill?.display_name || draft.displayName || t("panel.newTitle")}
        status={<span className="mono xs t3 trunc" title={skill ? (external ? skill.source_path : `${skill.slug}/SKILL.md`) : undefined}>{skill ? (external ? skill.source_path : `${skill.slug}/SKILL.md`) : slug ? `${slug}/SKILL.md` : "—"}</span>}
        actions={skill ? <MoreMenu items={menu} small ghost /> : undefined}
      />
      <PanelBody>
        {creating && (
          <Field label={t("panel.slug")} hint={t("panel.slugHint")} error={touched.slug ? slugError : undefined}>
            <Input mono autoFocus value={draft.slug} autoComplete="off" spellCheck={false}
              onChange={event => edit("slug", event.target.value)} onBlur={event => { if (event.target.value) setTouched(value => ({ ...value, slug: true })) }} />
          </Field>
        )}
        <Field label={t("panel.name")} error={touched.name ? nameError : undefined}>
          <Input value={draft.displayName} readOnly={external}
            onChange={event => edit("displayName", event.target.value)} onBlur={() => { if (!creating || draft.slug) setTouched(value => ({ ...value, name: true })) }} />
        </Field>
        <Field label={t("panel.description")} hint={t("panel.descriptionHint")}>
          <Textarea rows={2} value={draft.description} readOnly={external} onChange={event => edit("description", event.target.value)} />
        </Field>
        <Field label={t("panel.body")}
          hint={external ? t("panel.bodyExternal") : undefined}
          error={bodyHeader ? (mismatch ? t("panel.frontmatterMismatch", { name: bodyHeader.name, slug: effectiveSlug || "—" }) : t("panel.frontmatterDuplicate")) : undefined}>
          <Textarea mono rows={14} value={draft.body} readOnly={external} spellCheck={false} onChange={event => edit("body", event.target.value)} />
        </Field>
        {bodyHeader && !external && (
          <Button small style={{ alignSelf: "flex-start" }} onClick={() => edit("body", bodyHeader.rest)}>{t("actions.removeFrontmatter")}</Button>
        )}
        <details>
          <summary className="t2" style={{ cursor: "pointer", fontWeight: 500 }}>{t("panel.preview")}</summary>
          <pre className="mono xs t2" style={{ whiteSpace: "pre-wrap", margin: "var(--sp-3) 0 0" }}>{frontmatter}</pre>
        </details>
        {props.mode === "edit" && skill && (
          <>
            <Dl items={[
              { label: t("panel.source"), value: external ? t("panel.sourceLibrary") : t("panel.sourceHub") },
              ...(external && skill.source_ref ? [{ label: t("panel.reference"), value: <span className="mono">{skill.source_ref}</span> }] : []),
              { label: t("panel.version"), value: <Tag>{t("row.version", { version: skill.version })}</Tag> },
              { label: t("panel.hash"), value: <span className="mono" title={skill.content_hash}>{shortHash(skill.content_hash, 16)}</span> },
            ]} />
            <hr className="divider" />
            <ClientAccess {...props} skill={skill} />
          </>
        )}
      </PanelBody>
      {creating ? (
        <div className="panel-f">
          {blocked && <span className="xs" role="status" style={{ marginRight: "auto", color: "var(--warn)" }}>{common("states.unsaved")}</span>}
          <Button variant="ghost" onClick={props.onClose}>{common("actions.cancel")}</Button>
          <Button variant="primary" disabled={!valid || save.isPending} onClick={submit}>{t("actions.createSkill")}</Button>
        </div>
      ) : external ? null : (
        <PanelFooter dirty={dirty} saving={save.isPending} warning={blocked} onDiscard={discard} onSave={submit} />
      )}
    </Panel>
  )
}

function ClientAccess({ skill, row, clients, ruleBusy, onToggleClient }: EditProps) {
  const { t } = useT("skills")
  const status = useT("status").t
  if (clients.length === 0) {
    return (
      <div className="field">
        <span className="label">{t("panel.clients")}</span>
        <span className="t3">{t("panel.noClients")}</span>
        <Link className="xs" style={{ color: "var(--accent-text)" }} to="/clients">{t("actions.viewClients")}</Link>
      </div>
    )
  }
  return (
    <div className="field">
      <span className="label">{t("panel.clients")}</span>
      <div className="list">
        {clients.map(client => {
          const name = status(`client.${client.cli_kind}`)
          const exposed = Boolean(row?.cells[client.id]?.exposed)
          const viaTool = !CLI_FILE_SKILLS[client.cli_kind]
          const claudeAi = viaTool ? skill.claude_ai.find(item => item.agent_id === client.id) ?? skill.claude_ai[0] : undefined
          return (
            <div className="row" key={client.id} style={{ minHeight: 46 }}>
              <div className="row-main">
                <span className="row-title" title={name}>{name}</span>
                {(viaTool || !client.enabled) && (
                  <span className="row-sub" title={viaTool ? t("panel.desktopHint") : t("panel.pausedHint")}>
                    {!client.enabled ? t("panel.clientPaused") : t("panel.viaTool")}
                  </span>
                )}
              </div>
              {claudeAi && <div className="row-meta"><Chip tone={CLAUDE_AI_TONE[claudeAi.status]}>{t(`claudeAi.${claudeAi.status}`)}</Chip></div>}
              <Switch checked={exposed} disabled={ruleBusy || !client.enabled} label={t("panel.clientToggle", { skill: skill.display_name, client: name })}
                onChange={value => onToggleClient(skill, client, value)} />
            </div>
          )
        })}
      </div>
      {clients.some(client => !CLI_FILE_SKILLS[client.cli_kind]) && <span className="hint">{t("panel.desktopHint")}</span>}
    </div>
  )
}
