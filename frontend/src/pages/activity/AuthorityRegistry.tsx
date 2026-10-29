import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  Chip, ConfirmDialog, Dl, Empty, EmptyFiltered, ErrorState, List, MoreMenu, Panel, PanelBody, PanelHeader, Row, RowHead, Seg, Select,
  SkeletonRows, TabPanel, useToast, type ChipTone,
} from "../../components/ui"
import { errorKey, useFormat, useT } from "../../i18n"
import { redact } from "../../lib/activity"
import { useAllProjects } from "../../lib/projects"
import {
  AUTHORITY_KINDS, isAuthorityKind, useAuthorityEvents, useReadGrants, useRevokeReadGrant,
  type AuthorityEventRow, type AuthorityKind, type ReadGrantRow,
} from "../../lib/read-grants"
import { Bar, CodeBox, Col, useListTime } from "./shared"

type View = "events" | "grants"
type GrantState = "active" | "expired" | "revoked"

const ALL = "all"
const ROW_MIN = 640
const GRANT_TONE: Record<GrantState, ChipTone> = { active: "ok", expired: "off", revoked: "off" }
/** Motivos cerrados que escriben el barrido de permisos y la cancelación de pedidos (memory/chat-read-access.ts). */
const REASONS = ["session_removed", "session_closed", "max_ttl", "work_completed", "liveness_lost", "session_ended", "pending_ttl"] as const
type Reason = typeof REASONS[number]
const isReason = (value: string): value is Reason => (REASONS as readonly string[]).includes(value)

function grantState(grant: ReadGrantRow, now = Date.now()): GrantState {
  if (grant.revoked_at) return "revoked"
  return Date.parse(grant.expires_at) <= now ? "expired" : "active"
}

function evidenceOf(event: AuthorityEventRow): Record<string, unknown> {
  if (!event.evidence) return {}
  if (typeof event.evidence !== "string") return event.evidence
  try {
    const parsed: unknown = JSON.parse(event.evidence)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function useReasonText() {
  const { t } = useT("activity")
  return (value: string | null | undefined): string | null => {
    if (!value) return null
    return isReason(value) ? t(`authority.reason.${value}`) : value
  }
}

/** Autoridad · registro de solo lectura: cambios de liderazgo y de acceso de lectura, más los permisos otorgados.
 *  La única acción es revocar un permiso vigente, desde el «…» de su panel y con confirmación. */
export default function AuthorityRegistry({ header, registrySelect }: { header: ReactNode; registrySelect: ReactNode }) {
  const { t } = useT("activity")
  const [view, setView] = useState<View>("events")
  const [kind, setKind] = useState<AuthorityKind | typeof ALL>(ALL)
  const [project, setProject] = useState<string>(ALL)
  const [selected, setSelected] = useState<string | null>(null)
  const projects = useAllProjects()
  const filter = { kind: kind === ALL ? undefined : kind, project_id: project === ALL ? undefined : project }
  const events = useAuthorityEvents(filter, view === "events")
  const grants = useReadGrants(view === "grants")

  const projectOptions = useMemo(() => [
    { value: ALL, label: t("authority.filter.allProjects") },
    ...(projects.data?.items ?? []).map(item => ({ value: item.id, label: item.title, avatar: item.title })).sort((a, b) => a.label.localeCompare(b.label)),
  ], [projects.data, t])
  const kindOptions: { value: AuthorityKind | typeof ALL; label: string }[] = [
    { value: ALL, label: t("authority.filter.allKinds") },
    ...AUTHORITY_KINDS.map(value => ({ value, label: t(`authority.kind.${value}`) })),
  ]

  const changeView = (next: View) => { setView(next); setSelected(null); if (next === "grants") setKind(ALL) }
  const clearFilters = () => { setKind(ALL); setProject(ALL) }
  const allGrants = grants.data?.items ?? []
  const visibleGrants = project === ALL ? allGrants : allGrants.filter(grant => grant.project_id === project)
  const currentEvent = view === "events" ? (events.data?.items ?? []).find(event => event.id === selected) ?? null : null
  const currentGrant = view === "grants" ? allGrants.find(grant => grant.id === selected) ?? null : null

  return (
    <div className="split">
      <div className="page">
        {header}
        <TabPanel idPrefix="activity" value="llamadas">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <Bar>
              {registrySelect}
              <Seg<View>
                label={t("authority.view.label")}
                value={view}
                onChange={changeView}
                options={[
                  { value: "events", label: t("authority.view.events") },
                  { value: "grants", label: t("authority.view.grants"), count: grants.data ? allGrants.filter(grant => grantState(grant) === "active").length : undefined },
                ]}
              />
              {view === "events" && <Select<AuthorityKind | typeof ALL> label={t("authority.filter.kind")} value={kind} options={kindOptions} onChange={setKind} />}
              <Select label={t("authority.filter.project")} value={project} options={projectOptions} onChange={setProject} />
            </Bar>
            {view === "events"
              ? <EventList query={events} filtered={kind !== ALL || project !== ALL} selected={selected} onSelect={setSelected} onClear={clearFilters} />
              : <GrantList query={grants} items={visibleGrants} filtered={project !== ALL} selected={selected} onSelect={setSelected} onClear={clearFilters} />}
          </div>
        </TabPanel>
      </div>
      {currentEvent && <EventPanel key={currentEvent.id} event={currentEvent} onClose={() => setSelected(null)} />}
      {currentGrant && <GrantPanel key={currentGrant.id} grant={currentGrant} onClose={() => setSelected(null)} />}
    </div>
  )
}

interface ListProps { filtered: boolean; selected: string | null; onSelect: (id: string | null) => void; onClear: () => void }

function EventList({ query, filtered, selected, onSelect, onClear }: ListProps & { query: ReturnType<typeof useAuthorityEvents> }) {
  const { t } = useT("activity")
  const listTime = useListTime()
  if (query.isPending) return <SkeletonRows avatar={false} label={t("authority.loading")} />
  if (query.error) return <List><ErrorState error={query.error} title={t("authority.empty.errorTitle")} onRetry={() => void query.refetch()} /></List>
  const items = query.data.items
  if (items.length === 0) {
    return filtered
      ? <List><EmptyFiltered text={t("authority.empty.filtered")} onClear={onClear} /></List>
      : <List><Empty icon="activity" title={t("authority.empty.title")} detail={t("authority.empty.detail")} /></List>
  }
  return (
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("authority.columns.event")}</span>
        <Col width={180}>{t("authority.columns.actor")}</Col>
        <Col width={80} right>{t("authority.columns.time")}</Col>
      </RowHead>
      {items.map(event => {
        const time = listTime(event.created_at)
        const actor = actorLabel(event, t)
        const label = isAuthorityKind(event.kind) ? t(`authority.kind.${event.kind}`) : event.kind
        return (
          <Row
            key={event.id}
            style={{ minWidth: ROW_MIN }}
            selected={event.id === selected}
            onOpen={() => onSelect(event.id === selected ? null : event.id)}
            title={isAuthorityKind(event.kind) ? label : <span className="mono">{label}</span>}
            titleText={label}
            sub={[event.target_label, event.project_title ?? event.channel_name].filter(Boolean).join(" · ") || undefined}
            meta={<>
              <Col width={180} className="xs t2 trunc" title={actor}>{actor}</Col>
              <Col width={80} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
  )
}

function actorLabel(event: AuthorityEventRow, t: ReturnType<typeof useT<"activity">>["t"]): string {
  if (event.actor_label) return event.actor_label
  return event.actor_user_id ? t("authority.person") : t("authority.system")
}

function EventPanel({ event, onClose }: { event: AuthorityEventRow; onClose: () => void }) {
  const { t } = useT("activity")
  const format = useFormat()
  const reason = useReasonText()
  const evidence = evidenceOf(event)
  const label = isAuthorityKind(event.kind) ? t(`authority.kind.${event.kind}`) : event.kind
  return (
    <Panel label={t("authority.panel.eventLabel")} onClose={onClose}>
      <PanelHeader title={label} />
      <PanelBody>
        <Dl items={[
          { label: t("authority.panel.kind"), value: <span className="mono xs">{event.kind}</span> },
          { label: t("authority.panel.actor"), value: actorLabel(event, t) },
          { label: t("authority.panel.target"), value: event.target_label },
          { label: t("authority.panel.project"), value: event.project_title },
          { label: t("authority.panel.channel"), value: event.channel_name },
          { label: t("authority.panel.when"), value: format.date(event.created_at, "datetime") },
          { label: t("authority.panel.reason"), value: reason(event.reason) ? <span style={{ overflowWrap: "anywhere" }}>{reason(event.reason)}</span> : null },
        ]} />
        <div className="field">
          <span className="label">{t("authority.panel.evidence")}</span>
          {Object.keys(evidence).length > 0 ? <CodeBox>{JSON.stringify(redact(evidence), null, 2)}</CodeBox> : <span className="xs t3">{t("authority.panel.noEvidence")}</span>}
        </div>
      </PanelBody>
    </Panel>
  )
}

function GrantList({ query, items, filtered, selected, onSelect, onClear }: ListProps & { query: ReturnType<typeof useReadGrants>; items: ReadGrantRow[] }) {
  const { t } = useT("activity")
  const listTime = useListTime()
  if (query.isPending) return <SkeletonRows avatar={false} label={t("authority.loading")} />
  if (query.error) return <List><ErrorState error={query.error} title={t("authority.empty.grantsErrorTitle")} onRetry={() => void query.refetch()} /></List>
  if (items.length === 0) {
    return filtered
      ? <List><EmptyFiltered text={t("authority.empty.grantsFiltered")} onClear={onClear} /></List>
      : <List><Empty icon="activity" title={t("authority.empty.grantsTitle")} detail={t("authority.empty.grantsDetail")} /></List>
  }
  return (
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("authority.columns.grant")}</span>
        <Col width={120}>{t("authority.columns.state")}</Col>
        <Col width={80} right>{t("authority.columns.granted")}</Col>
      </RowHead>
      {items.map(grant => {
        const state = grantState(grant)
        const time = listTime(grant.granted_at)
        return (
          <Row
            key={grant.id}
            style={{ minWidth: ROW_MIN }}
            selected={grant.id === selected}
            onOpen={() => onSelect(grant.id === selected ? null : grant.id)}
            title={t("authority.grantTitle", { agent: grant.session_label, project: grant.project_title })}
            sub={grant.reason || undefined}
            meta={<>
              <Col width={120}><Chip tone={GRANT_TONE[state]}>{t(`authority.grantState.${state}`)}</Chip></Col>
              <Col width={80} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
  )
}

function GrantPanel({ grant, onClose }: { grant: ReadGrantRow; onClose: () => void }) {
  const { t } = useT("activity")
  const errors = useT("errors").t
  const format = useFormat()
  const toast = useToast()
  const reason = useReasonText()
  const revoke = useRevokeReadGrant()
  const [confirming, setConfirming] = useState(false)
  const state = grantState(grant)
  const name = t("authority.grantTitle", { agent: grant.session_label, project: grant.project_title })

  function submit() {
    revoke.mutate({ id: grant.id }, {
      onSuccess: () => { setConfirming(false); toast.success(t("authority.toast.revoked", { agent: grant.session_label })) },
      onError: error => { setConfirming(false); toast.error(t("authority.toast.revokeFailed"), errors(errorKey(error))) },
    })
  }

  return (
    <Panel label={t("authority.panel.grantLabel")} onClose={onClose}>
      <PanelHeader
        title={name}
        status={<Chip tone={GRANT_TONE[state]}>{t(`authority.grantState.${state}`)}</Chip>}
        actions={state === "active" ? <MoreMenu small ghost items={[{ label: t("authority.actions.revoke"), danger: true, onSelect: () => setConfirming(true) }]} /> : undefined}
      />
      <PanelBody>
        <Dl items={[
          { label: t("authority.panel.agent"), value: grant.session_label },
          { label: t("authority.panel.project"), value: grant.project_title },
          { label: t("authority.panel.reason"), value: grant.reason ? <span style={{ overflowWrap: "anywhere" }}>{grant.reason}</span> : null },
          { label: t("authority.panel.granted"), value: format.date(grant.granted_at, "datetime") },
          { label: t("authority.panel.expires"), value: format.date(grant.expires_at, "datetime") },
          { label: t("authority.panel.revoked"), value: grant.revoked_at ? format.date(grant.revoked_at, "datetime") : null },
          { label: t("authority.panel.revokeReason"), value: reason(grant.revoke_reason) },
        ]} />
        {grant.confirmation_phrase && (
          <div className="field">
            <span className="label">{t("authority.panel.phrase")}</span>
            <CodeBox>{grant.confirmation_phrase}</CodeBox>
          </div>
        )}
      </PanelBody>
      <ConfirmDialog
        open={confirming}
        title={t("authority.confirm.title", { agent: grant.session_label, project: grant.project_title })}
        message={t("authority.confirm.message")}
        confirmLabel={t("authority.actions.revoke")}
        busy={revoke.isPending}
        onConfirm={submit}
        onClose={() => setConfirming(false)}
      />
    </Panel>
  )
}
