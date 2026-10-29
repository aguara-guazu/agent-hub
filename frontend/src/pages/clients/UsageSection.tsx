import type { UsageQuotaAvailability, UsageQuotaSnapshot, UsageQuotaWindow } from "@agenthub/shared"
import { Button, Chip, Dl } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import type { LocalClient } from "../../lib/local"
import { useMemory } from "../../lib/memory"

export interface UsageStatus { generated_at: string; clis: ({ cli: string } & UsageQuotaAvailability)[] }

const TONE: Record<UsageQuotaAvailability["status"], ChipTone> = { available: "ok", low: "warn", exhausted: "danger", cooldown: "info", unknown: "off" }
const WEEK_MINUTES = 10080

/** Lectura de uso del cliente: nunca se toma el saldo de otra instalación. */
export function usageOf(data: UsageStatus | undefined, client: LocalClient): { status: UsageQuotaAvailability["status"]; reason?: string; pools: UsageQuotaSnapshot[] } {
  const entry = data?.clis.find(item => item.cli === client.cli_kind)
  const pools = entry?.pools.filter(pool => pool.binding_ids.some(id => id === client.id || id.startsWith(`${client.id}:profile:`))) ?? []
  return { status: pools.length && entry ? entry.status : "unknown", reason: entry?.reason, pools }
}

function percentOf(window: UsageQuotaWindow): number | null {
  if (window.unit === "percent" && window.used !== undefined) return window.used
  if (window.used !== undefined && window.limit) return (window.used / window.limit) * 100
  if (window.remaining !== undefined && window.limit) return ((window.limit - window.remaining) / window.limit) * 100
  return null
}

function isWeekly(window: UsageQuotaWindow): boolean {
  return window.duration_minutes === WEEK_MINUTES || window.id === "seven_day"
}

export function UsageSection({ client }: { client: LocalClient }) {
  const { t } = useT("clients")
  const format = useFormat()
  const quota = useMemory<UsageStatus>("usage_status")
  const usage = usageOf(quota.data, client)
  const pools = [...usage.pools].sort((a, b) => Number(a.model_scope !== "all") - Number(b.model_scope !== "all"))
  const windows = pools.flatMap(pool => pool.observation.windows.map(window => ({ pool, window })))
  const weekly = windows.find(item => isWeekly(item.window) && percentOf(item.window) !== null)
  const others = windows.filter(item => item !== weekly)
  const percent = weekly ? Math.max(0, Math.min(100, percentOf(weekly.window) ?? 0)) : null
  const unsupported = client.cli_kind === "claude_desktop"
  const reasonKey = (reason: string) => (`usage.reasons.${reason}` as const)
  const reasonText = (reason?: string) => {
    if (!reason) return undefined
    const text = t(reasonKey(reason) as "usage.reasons.fallback", { defaultValue: "" })
    return text || t("usage.reasons.fallback")
  }

  function windowName(window: UsageQuotaWindow): string {
    const minutes = window.duration_minutes
    if (minutes === 300 || window.id === "five_hour") return t("usage.windows.fiveHours")
    if (minutes === WEEK_MINUTES || window.id === "seven_day") return t("usage.windows.sevenDays")
    if (window.id === "monthly-credits" || window.id === "monthly") return t("usage.windows.month")
    if (window.id === "quota") return t("usage.windows.consumption")
    if (window.id === "spend_limit") return t("usage.windows.spendLimit")
    return minutes ? t("usage.windows.minutes", { count: minutes }) : window.id
  }
  function amount(window: UsageQuotaWindow): string {
    const number = (value: number) => format.number(value, { maximumFractionDigits: 1 })
    const unit = t(`usage.units.${window.unit}`)
    if (window.unit === "percent" && window.used !== undefined) return t("usage.percentUsed", { value: number(window.used) })
    if (window.unit === "credits" && window.used !== undefined && window.limit !== undefined) return t("usage.creditsUsed", { used: number(window.used), limit: number(window.limit) })
    if (window.remaining !== undefined) return t("usage.remaining", { value: number(window.remaining), unit })
    if (window.used !== undefined) return t("usage.used", { value: number(window.used), unit })
    return t("usage.notReported")
  }
  function poolName(pool: UsageQuotaSnapshot): string {
    const id = pool.pool_id
    if (id === "subscription" || id === "codex") return t("usage.pools.general")
    if (id === "gemini-weekly") return t("usage.pools.geminiWeekly")
    if (id === "3p-weekly") return t("usage.pools.otherWeekly")
    if (id.startsWith("model-")) return t("usage.pools.model", { model: id.slice(6) })
    return id
  }

  const empty = unsupported ? t("usage.unsupported") : client.cli_kind === "antigravity" ? t("usage.antigravity") : t("usage.waiting")
  const hint = weekly
    ? [weekly.window.resets_at ? t("usage.renews", { when: format.date(weekly.window.resets_at, "date") }) : null, t("usage.read", { when: format.relative(weekly.pool.observation.observed_at) })].filter(Boolean).join(" · ")
    : undefined

  return (
    <div className="field">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
        <span className="label">{t("usage.title")}</span>
        {percent !== null
          ? <span className="xs t3 num">{format.number(percent, { maximumFractionDigits: 0 })} %</span>
          : !unsupported && <Chip tone={TONE[usage.status]}>{t(`usage.status.${usage.status}`)}</Chip>}
      </div>
      {percent !== null && (
        <div role="meter" aria-label={t("usage.title")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
          style={{ height: "var(--sp-1)", borderRadius: "var(--r-full)", background: "var(--surface-3)", overflow: "hidden" }}>
          <div style={{ width: `${percent}%`, height: "100%", background: usage.status === "exhausted" ? "var(--danger)" : usage.status === "low" ? "var(--warn)" : "var(--accent)", borderRadius: "var(--r-full)" }} />
        </div>
      )}
      {hint && <span className="hint">{hint}</span>}
      {!pools.length && <span className="hint">{quota.isPending ? null : empty}</span>}
      {pools.length > 0 && usage.reason && <span className="hint">{reasonText(usage.reason)}</span>}
      {others.length > 0 && (
        <Dl items={others.map(({ pool, window }) => ({ label: pools.length > 1 ? `${poolName(pool)} · ${windowName(window)}` : windowName(window), value: amount(window) }))} />
      )}
      {pools.length > 0 && (
        <details>
          <summary className="xs t2" style={{ cursor: "pointer" }}>{t("usage.source")}</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", paddingTop: "var(--sp-2)" }}>
            {pools.map(pool => (
              <div key={pool.id} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                <span className="xs" style={{ fontWeight: 500 }}>{poolName(pool)}</span>
                <span className="xs t3">{pool.scope === "account" ? t("usage.shared") : t("usage.profile")}{pool.stale ? ` · ${t("usage.stale")}` : ""}</span>
                {pool.reason && <span className="xs t3">{reasonText(pool.reason)}</span>}
                <span className="xs t3">{t("usage.sourceLabel")}: <span className="mono">{pool.observation.source.adapter}</span></span>
                <span className="xs t3">{t("usage.observed")}: {format.date(pool.observation.observed_at)} · {t("usage.validUntil")}: {format.date(pool.observation.expires_at)}</span>
                {pool.retained_windows?.map(item => (
                  <span key={item.window.id} className="xs t3">{t("usage.retained", { window: windowName(item.window), amount: amount(item.window), until: format.date(item.expires_at) })}</span>
                ))}
                {pool.retained_status && <span className="xs t3">{t("usage.retainedStatus", { status: t(`usage.status.${pool.retained_status.status}`), until: format.date(pool.retained_status.expires_at) })}</span>}
              </div>
            ))}
            <span className="xs t3">{t("usage.caveat")}</span>
          </div>
        </details>
      )}
      {!unsupported && <Button small variant="ghost" style={{ alignSelf: "flex-start" }} disabled={quota.isFetching} onClick={() => void quota.refetch()}>{t("actions.refreshUsage")}</Button>}
    </div>
  )
}
