import type { UsageQuotaAvailability, UsageQuotaSnapshot, UsageQuotaState, UsageQuotaWindow } from "@agenthub/shared"
import { Avatar, Button, Chip, Empty, ErrorState, List, Row, SkeletonRows } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { useOverview } from "../../lib/local"
import { useMemory } from "../../lib/memory"
import { CLI_LABELS } from "../../lib/types"

type QuotaReport = { generated_at: string; clis: ({ cli: string } & UsageQuotaAvailability)[] }

const TONES: Record<UsageQuotaState, ChipTone> = { available: "ok", low: "warn", exhausted: "danger", cooldown: "info", unknown: "off" }
const PRIORITY = ["claude_code", "codex_cli", "kiro"]
const REASONS = [
  "quota_login_required", "quota_provider_not_connected", "quota_project_required", "quota_provider_unavailable", "additional_capacity_unverified",
  "no_observation", "ambiguous_account", "expired_observation", "reset_requires_observation", "configuration_required", "unknown_model_scope",
  "subscription_limits_unavailable", "native_windows_incomplete", "native_usage_not_advertised", "native_usage_schema_unsupported", "unsupported",
  "missing_fields", "unknown_account",
] as const
type Reason = (typeof REASONS)[number]

/**
 * Cuotas de uso por cliente, de solo lectura. Nunca se le atribuye a un cliente el saldo de otra instalación:
 * solo cuentan los pools cuyo `binding_ids` incluye el id del cliente (o uno de sus perfiles).
 */
export function QuotasBlock() {
  const { t } = useT("settings")
  const format = useFormat()
  const overview = useOverview()
  const quota = useMemory<QuotaReport>("usage_status")
  const clients = [...(overview.data?.clients ?? [])].sort((a, b) => Number(!PRIORITY.includes(a.cli_kind)) - Number(!PRIORITY.includes(b.cli_kind)))

  const reason = (value: string | undefined) => value ? t(`ai.quotas.reasons.${(REASONS as readonly string[]).includes(value) ? value as Reason : "default"}`) : undefined
  const windowName = (window: UsageQuotaWindow) => {
    if (window.duration_minutes === 300 || window.id === "five_hour") return t("ai.quotas.window.fiveHour")
    if (window.duration_minutes === 10080 || window.id === "seven_day") return t("ai.quotas.window.sevenDay")
    if (window.id === "monthly-credits" || window.id === "monthly") return t("ai.quotas.window.month")
    if (window.id === "quota") return t("ai.quotas.window.quota")
    if (window.id === "spend_limit") return t("ai.quotas.window.spendLimit")
    return window.duration_minutes ? t("ai.quotas.window.minutes", { count: window.duration_minutes }) : window.id
  }
  const amount = (window: UsageQuotaWindow) => {
    const number = (value: number) => format.number(value, { maximumFractionDigits: 1 })
    if (window.unit === "percent" && window.used !== undefined) return t("ai.quotas.amount.percent", { value: number(window.used) })
    if (window.unit === "credits" && window.used !== undefined && window.limit !== undefined) return t("ai.quotas.amount.credits", { used: number(window.used), limit: number(window.limit) })
    const unit = t(`ai.quotas.unit.${window.unit}`)
    if (window.remaining !== undefined) return t("ai.quotas.amount.remaining", { value: number(window.remaining), unit })
    if (window.used !== undefined) return t("ai.quotas.amount.used", { value: number(window.used), unit })
    return t("ai.quotas.amount.unknown")
  }
  const poolName = (pool: UsageQuotaSnapshot) => {
    if (pool.pool_id === "subscription" || pool.pool_id === "codex") return t("ai.quotas.pool.general")
    if (pool.pool_id === "gemini-weekly") return t("ai.quotas.pool.geminiWeekly")
    if (pool.pool_id === "3p-weekly") return t("ai.quotas.pool.otherWeekly")
    if (pool.pool_id.startsWith("model-")) return t("ai.quotas.pool.model", { model: pool.pool_id.slice(6) })
    return pool.pool_id
  }
  const poolText = (pool: UsageQuotaSnapshot) => {
    const windows = pool.observation.windows.map(window => {
      const base = `${windowName(window)}: ${amount(window)}`
      return window.resets_at ? `${base} (${t("ai.quotas.resets", { when: format.relative(window.resets_at) })})` : base
    })
    return `${poolName(pool)} · ${windows.length ? windows.join(", ") : t("ai.quotas.amount.unknown")}`
  }
  const poolTooltip = (pool: UsageQuotaSnapshot) => [
    poolText(pool),
    t(pool.scope === "account" ? "ai.quotas.scope.account" : "ai.quotas.scope.binding"),
    reason(pool.reason),
    t("ai.quotas.source", { source: pool.observation.source.adapter, observed: format.date(pool.observation.observed_at), until: format.date(pool.observation.expires_at) }),
    pool.stale ? t("ai.quotas.stale") : undefined,
    ...(pool.retained_windows ?? []).map(entry => t("ai.quotas.retained", { window: windowName(entry.window), amount: amount(entry.window), until: format.date(entry.expires_at) })),
    pool.retained_status ? t("ai.quotas.retainedStatus", { status: t(`ai.quotas.status.${pool.retained_status.status}`), until: format.date(pool.retained_status.expires_at) }) : undefined,
  ].filter(Boolean).join("\n")

  return (
    <section className="section">
      <div className="section-h">
        <h3 className="h3">{t("ai.quotas.title")}</h3>
        <Button small disabled={quota.isFetching} onClick={() => void quota.refetch()}>{t("ai.quotas.refresh")}</Button>
      </div>
      {quota.isPending || overview.isPending ? <SkeletonRows count={2} />
        : quota.error || overview.error ? <List><ErrorState error={quota.error ?? overview.error} onRetry={() => { void quota.refetch(); void overview.refetch() }} /></List>
          : clients.length === 0 ? <List><Empty icon="clients" title={t("ai.quotas.empty.title")} detail={t("ai.quotas.empty.detail")} /></List>
            : (
              <List>
                {clients.map(client => {
                  const name = CLI_LABELS[client.cli_kind] ?? client.cli_kind
                  const entry = quota.data?.clis.find(item => item.cli === client.cli_kind)
                  const pools = [...(entry?.pools.filter(pool => pool.binding_ids.some(id => id === client.id || id.startsWith(`${client.id}:profile:`))) ?? [])]
                    .sort((a, b) => Number(a.model_scope !== "all") - Number(b.model_scope !== "all"))
                  const state: UsageQuotaState = pools.length ? entry!.status : "unknown"
                  const hasValues = pools.some(pool => pool.observation.windows.length > 0)
                  const unsupported = client.cli_kind === "claude_desktop"
                  const chip = unsupported ? t("ai.quotas.status.unsupported") : state === "unknown" && hasValues ? t("ai.quotas.status.partial") : t(`ai.quotas.status.${state}`)
                  const sub = pools.length
                    ? pools.map(poolText).join(" · ")
                    : unsupported ? t("ai.quotas.claudeDesktop") : client.cli_kind === "antigravity" ? t("ai.quotas.antigravity") : t("ai.quotas.waiting")
                  const tooltip = pools.length ? [reason(entry?.reason), ...pools.map(poolTooltip)].filter(Boolean).join("\n\n") : sub
                  return (
                    <Row
                      key={client.id}
                      lead={<Avatar name={name} small />}
                      title={name}
                      sub={<span title={tooltip}>{sub}</span>}
                      meta={<Chip tone={unsupported ? "off" : TONES[state]}>{chip}</Chip>}
                    />
                  )
                })}
              </List>
            )}
    </section>
  )
}
