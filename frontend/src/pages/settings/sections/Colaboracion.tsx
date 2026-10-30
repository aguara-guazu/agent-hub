import { useEffect, useState } from "react"
import type { KeyboardEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Avatar, Button, Chip, Empty, ErrorState, Field, Input, List, MoreMenu, Row, Select, SkeletonRows, Switch, useToast } from "../../../components/ui"
import type { ChipTone, MenuItem } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemoryStatus } from "../../../lib/memory"
import { useMemoryBanner } from "../MemoryBanner"
import { AdvancedOptions, SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"
import {
  downloadJson, isIpv4, parseBootstrap, projectFilename, sharingCall, shortId, useSharedMembers, useSharingAction, useSharingStatus,
  type NetworkSettings, type SharedProject, type SharingRole,
} from "../sharing"

type Backend = "hub" | "native"
const BACKENDS: readonly Backend[] = ["hub", "native"]
const TEAM_KEY = ["memory", "team-preference"] as const

/**
 * Colaboración y red: colaboración entre agentes de esta computadora, cómo se forman los equipos y la red P2P de
 * proyectos compartidos. Guardado automático: interruptores y selectores al cambiar; campos de texto al salir.
 * Unirse con una invitación y restaurar un proyecto compartido viven en Proyectos («Nuevo proyecto ▾»).
 */
export default function Colaboracion() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const collaboration = useQuery({ queryKey: ["collaboration"], queryFn: () => api.get<{ enabled: boolean }>("/collaboration") })
  const saveCollaboration = useMutation({
    mutationFn: (enabled: boolean) => api.put<{ enabled: boolean }>("/collaboration", { enabled }),
    // El interruptor cambia qué herramientas y vistas de colaboración responden: se refresca todo.
    onSuccess: async () => { await cache.invalidateQueries() },
    onError: error => toast.error(t("collaboration.agents.saveFailed"), detail(error)),
  })
  const team = useQuery({ queryKey: TEAM_KEY, queryFn: () => api.get<{ preferred_backend: Backend }>("/memory/teams/preferences") })
  const saveTeam = useMutation({
    mutationFn: (preferred_backend: Backend) => api.put("/memory/teams/preferences", { preferred_backend }),
    onSuccess: (_, preferred_backend) => { cache.setQueryData(TEAM_KEY, { preferred_backend }) },
    onError: error => toast.error(t("collaboration.teams.saveFailed"), detail(error)),
  })
  const banner = useMemoryBanner()
  const enabled = saveCollaboration.isPending ? Boolean(saveCollaboration.variables) : collaboration.data?.enabled ?? true
  const backend = saveTeam.isPending ? saveTeam.variables! : team.data?.preferred_backend ?? "hub"
  return <>
    <SettingsSection title={t("sections.colaboracion")}>
      {banner}
      {collaboration.error ? (
        <ErrorState error={collaboration.error} title={t("collaboration.agents.loadFailed")} onRetry={() => void collaboration.refetch()} />
      ) : collaboration.isPending ? <SkeletonRows count={2} avatar={false} /> : (
        <List>
          <SettingRow label={t("collaboration.agents.label")} hint={t("collaboration.agents.hint")}>
            <Switch label={t("collaboration.agents.label")} checked={enabled} disabled={saveCollaboration.isPending} onChange={value => saveCollaboration.mutate(value)} />
          </SettingRow>
          <SettingRow label={t("collaboration.teams.label")} hint={team.error ? t("collaboration.teams.unavailable") : t("collaboration.teams.hint")}>
            <Select
              bare
              label={t("collaboration.teams.label")}
              value={backend}
              disabled={!team.data || saveTeam.isPending || !enabled}
              onChange={value => saveTeam.mutate(value)}
              options={BACKENDS.map(value => ({ value, label: t(`collaboration.teams.options.${value}`) }))}
            />
          </SettingRow>
        </List>
      )}
    </SettingsSection>
    <NetworkSection />
  </>
}

/** Identidad, estado de la red P2P y proyectos compartidos. Depende de la memoria: sin ella no hay red. */
function NetworkSection() {
  const { t, plural } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const memory = useMemoryStatus()
  const ready = memory.data?.ready === true
  const sharing = useSharingStatus(ready)
  const identity = sharing.data?.identity
  const network = sharing.data?.network
  const [name, setName] = useState<string | null>(null)
  const rename = useSharingAction(error => { setName(null); toast.error(t("collaboration.network.renameFailed"), detail(error)) }, () => setName(null))
  function commitName() {
    const next = name?.trim()
    if (!identity || name === null) return
    if (!next || next === identity.name) { setName(null); return }
    rename.mutate({ operation: "rename", name: next })
  }
  async function copyIdentity() {
    if (!identity) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(identity))
      toast.success(t("collaboration.network.identityCopied"))
    } catch {
      toast.error(t("collaboration.network.copyFailed"))
    }
  }
  if (!ready) return null
  return <>
    <section className="section">
      <div className="section-h"><h3 className="h3">{t("collaboration.network.title")}</h3></div>
      {sharing.error ? (
        <ErrorState error={sharing.error} title={t("collaboration.network.loadFailed")} onRetry={() => void sharing.refetch()} />
      ) : !sharing.data ? <SkeletonRows count={3} avatar={false} /> : <>
        <List>
          <SettingRow label={t("collaboration.network.name")} htmlFor="settings-network-name" hint={t("collaboration.network.nameHint")}>
            <Input
              id="settings-network-name"
              value={name ?? identity?.name ?? ""}
              maxLength={120}
              style={{ width: 240 }}
              disabled={rename.isPending}
              onChange={event => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={event => {
                if (event.key === "Enter") event.currentTarget.blur()
                if (event.key === "Escape") { setName(null); event.currentTarget.blur() }
              }}
            />
          </SettingRow>
          <SettingRow label={t("collaboration.network.identity")} hint={identity ? shortId(identity.id) : undefined} monoHint>
            <Button small disabled={!identity} onClick={() => void copyIdentity()}>{t("collaboration.network.copyIdentity")}</Button>
          </SettingRow>
          <SettingRow
            label={t("collaboration.network.status")}
            hint={network?.error ? t("collaboration.network.errorHint") : plural("collaboration.network.peers", network?.connected_peers ?? 0)}
          >
            {network?.error
              ? <Chip tone="danger" title={network.error}>{t("collaboration.network.chip.error")}</Chip>
              : <Chip tone="ok">{t("collaboration.network.chip.active")}</Chip>}
          </SettingRow>
        </List>
        {network && <NetworkAdvanced settings={network.settings} />}
      </>}
    </section>
    {sharing.data && <SharedProjects projects={sharing.data.projects} identityId={identity?.id} />}
  </>
}

/** Nodos de descubrimiento y dirección de escucha. Cada campo guarda al salir si cambió y es válido. */
function NetworkAdvanced({ settings }: { settings: NetworkSettings }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const savedBootstrap = settings.bootstrap.join(", ")
  const savedHost = settings.bind_host ?? "0.0.0.0"
  const [bootstrap, setBootstrap] = useState(savedBootstrap)
  const [host, setHost] = useState(savedHost)
  useEffect(() => setBootstrap(savedBootstrap), [savedBootstrap])
  useEffect(() => setHost(savedHost), [savedHost])
  const save = useSharingAction(error => {
    setBootstrap(savedBootstrap)
    setHost(savedHost)
    toast.error(t("collaboration.network.advanced.saveFailed"), detail(error))
  })
  const hostInvalid = !isIpv4(host)
  function commit() {
    const nextBootstrap = parseBootstrap(bootstrap)
    const nextHost = host.trim()
    if (hostInvalid || (nextBootstrap.join(", ") === savedBootstrap && nextHost === savedHost)) return
    save.mutate({ operation: "network", settings: { bootstrap: nextBootstrap, bind_host: nextHost } })
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") event.currentTarget.blur() }
  return (
    <AdvancedOptions label={t("collaboration.network.advanced.title")}>
      <List>
        <SettingRow label={t("collaboration.network.advanced.bootstrap")} htmlFor="settings-network-bootstrap" hint={t("collaboration.network.advanced.bootstrapHint")}>
          <Input
            id="settings-network-bootstrap"
            mono
            value={bootstrap}
            placeholder={t("collaboration.network.advanced.bootstrapPlaceholder")}
            style={{ width: 260 }}
            disabled={save.isPending}
            onChange={event => setBootstrap(event.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
          />
        </SettingRow>
        <SettingRow
          label={t("collaboration.network.advanced.bindHost")}
          htmlFor="settings-network-host"
          hint={hostInvalid ? t("collaboration.network.advanced.bindHostInvalid") : t("collaboration.network.advanced.bindHostHint")}
        >
          <Input
            id="settings-network-host"
            mono
            value={host}
            aria-invalid={hostInvalid || undefined}
            style={{ width: 160 }}
            disabled={save.isPending}
            onChange={event => setHost(event.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
          />
        </SettingRow>
      </List>
    </AdvancedOptions>
  )
}

function SharedProjects({ projects, identityId }: { projects: SharedProject[]; identityId?: string }) {
  const { t } = useT("settings")
  const [recovering, setRecovering] = useState<string | null>(null)
  return (
    <section className="section">
      <div className="section-h"><h3 className="h3">{t("collaboration.projects.title")}</h3></div>
      {projects.length === 0 ? (
        <Empty
          icon="projects"
          title={t("collaboration.projects.empty.title")}
          detail={t("collaboration.projects.empty.detail")}
          action={<Link className="btn btn-sm" to="/projects">{t("collaboration.projects.empty.action")}</Link>}
        />
      ) : (
        <List>
          {projects.map(project => (
            <SharedProjectRow
              key={project.id}
              project={project}
              identityId={identityId}
              recovering={recovering === project.id}
              onRecover={() => setRecovering(recovering === project.id ? null : project.id)}
              onRecovered={() => setRecovering(null)}
            />
          ))}
        </List>
      )}
    </section>
  )
}

function SharedProjectRow({ project, identityId, recovering, onRecover, onRecovered }: { project: SharedProject; identityId?: string; recovering: boolean; onRecover: () => void; onRecovered: () => void }) {
  const { t, plural } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const members = useSharedMembers(project.id)
  const me = members.data?.members.find(member => member.identity.id === identityId)
  const active = (members.data?.members ?? []).filter(member => !member.revoked).length
  const owner = me?.role === "owner" && !me.revoked
  const resume = useSharingAction(
    error => toast.error(t("collaboration.projects.resumeFailed"), detail(error)),
    () => toast.success(t("collaboration.projects.resumed", { name: project.title })),
  )
  const exportFile = useMutation({
    mutationFn: () => sharingCall({ operation: "export", project_id: project.id }),
    onSuccess: data => { downloadJson(data, projectFilename(project.title)); toast.success(t("collaboration.projects.exported")) },
    onError: error => toast.error(t("collaboration.projects.exportFailed"), detail(error)),
  })
  // La frase va directo al portapapeles: nunca se muestra ni entra a la caché de consultas.
  const copyPhrase = useMutation({
    mutationFn: async () => {
      const value = await sharingCall<{ recovery_phrase: string }>({ operation: "recovery_phrase", project_id: project.id })
      await navigator.clipboard.writeText(value.recovery_phrase)
    },
    onSuccess: () => toast.success(t("collaboration.projects.phraseCopied")),
    onError: error => toast.error(t("collaboration.projects.phraseFailed"), detail(error)),
  })
  const [tone, chip]: [ChipTone, string] = project.conflict
    ? ["warn", t("collaboration.projects.chip.conflict")]
    : project.enabled ? ["ok", t("collaboration.projects.chip.active")] : ["off", t("collaboration.projects.chip.paused")]
  const role: SharingRole | null = me && !me.revoked ? me.role : null
  const sub = project.conflict
    ?? [role ? t(`collaboration.projects.role.${role}`) : null, members.data ? plural("collaboration.projects.members", active) : null].filter(Boolean).join(" · ")
  const items: MenuItem[] = [
    { label: t("collaboration.projects.export"), onSelect: () => exportFile.mutate(), disabled: exportFile.isPending },
    ...(!project.enabled ? [{ label: t("collaboration.projects.resume"), onSelect: () => resume.mutate({ operation: "pause", project_id: project.id, paused: false }), disabled: resume.isPending }] : []),
    ...(owner ? [{ label: t("collaboration.projects.copyPhrase"), onSelect: () => copyPhrase.mutate(), disabled: copyPhrase.isPending }] : []),
    { label: t("collaboration.projects.recover"), onSelect: onRecover },
  ]
  return <>
    <Row
      lead={<Avatar name={project.title} />}
      title={<Link to={`/projects/${project.id}`} style={{ color: "inherit" }}>{project.title}</Link>}
      titleText={project.title}
      sub={sub || undefined}
      meta={<Chip tone={tone} title={project.conflict ?? undefined}>{chip}</Chip>}
      action={<MoreMenu small ghost items={items} />}
    />
    {recovering && <RecoverForm project={project} onDone={onRecovered} />}
  </>
}

/** Recuperar autoridad de owner con la frase de 24 palabras. El campo se vacía al terminar o cancelar. */
function RecoverForm({ project, onDone }: { project: SharedProject; onDone: () => void }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const [phrase, setPhrase] = useState("")
  const recover = useSharingAction(
    error => toast.error(t("collaboration.projects.recoverFailed"), detail(error)),
    () => { setPhrase(""); toast.success(t("collaboration.projects.recovered", { name: project.title })); onDone() },
  )
  const id = `settings-recover-${project.id}`
  return (
    <form
      style={{ padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)", borderTop: "1px solid var(--border)" }}
      onSubmit={event => { event.preventDefault(); if (phrase.trim() && !recover.isPending) recover.mutate({ operation: "recover", project_id: project.id, phrase: phrase.trim() }) }}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPhrase(""); onDone() } }}
    >
      <Field id={id} label={t("collaboration.projects.phrase")} hint={t("collaboration.projects.phraseHint")}>
        <Input type="password" autoComplete="off" spellCheck={false} autoFocus value={phrase} onChange={event => setPhrase(event.target.value)} />
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
        <Button variant="ghost" disabled={recover.isPending} onClick={() => { setPhrase(""); onDone() }}>{t("collaboration.projects.cancel")}</Button>
        <Button type="submit" disabled={!phrase.trim() || recover.isPending}>{t("collaboration.projects.recoverSubmit")}</Button>
      </div>
    </form>
  )
}
