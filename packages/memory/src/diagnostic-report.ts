import { readFileSync } from "node:fs"
import { homedir, release } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { check } from "./contracts.js"
import { findExtractionCli, type ExtractionCli } from "./cli-extraction.js"
import type { Sql } from "./database.js"
import { buildReport, redactReport, tailLog } from "./report.js"

const WINDOW_MAX_MS = 24 * 60 * 60_000
const LOG_LINES = 200
/** Only these hub.log fields reach a public issue; free-form logs (core, daemon, worker) stay local. */
const PUBLIC_FIELDS = ["ts", "component", "event", "step", "duration_ms", "cause", "action", "state", "from", "error_code", "cli", "count", "uncertain",
  "session_id", "recipient_id", "member_id", "generation", "notice_id"] as const
/** Ids, codes and timestamps only: anything else (prose, paths, quotes) is dropped rather than redacted. */
const PUBLIC_VALUE = /^[A-Za-z0-9_:.+-]{1,100}$/
const CLIS: Array<[ExtractionCli, string]> = [["claude_code", "Claude Code"], ["codex_cli", "Codex CLI"], ["kiro", "Kiro CLI"]]

export const diagnosticReportInput = z.object({
  summary: z.string().trim().min(1).max(2000),
  steps: z.string().trim().max(4000).optional(),
  expected: z.string().trim().max(2000).optional(),
  observed: z.string().trim().min(1).max(4000),
  from: z.string().datetime(),
  to: z.string().datetime(),
  title: z.string().trim().min(1).max(160).optional(),
}).strict()

function hubVersion(): string {
  try { return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version) } catch { return "-" }
}
/** Installed or not, from the CLI's path only: no CLI is executed (some touch the person's keychain). */
function cliInstalled(cli: ExtractionCli): string {
  return findExtractionCli(cli) ? "instalada" : "no instalada"
}
/** hub.log events inside the window, re-serialized with allowlisted fields and values only. */
function hubEvents(path: string, from: string, to: string): string[] {
  const events: string[] = []
  for (const line of tailLog(path, 20_000)) {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const ts = typeof parsed.ts === "string" ? parsed.ts : ""
    if (!(ts >= from && ts <= to)) continue
    const kept: Record<string, string | number | boolean> = {}
    for (const key of PUBLIC_FIELDS) {
      const value = parsed[key]
      if (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && PUBLIC_VALUE.test(value))) kept[key] = value
    }
    events.push(JSON.stringify(kept))
  }
  return events.slice(-LOG_LINES)
}
/**
 * A title the agent can pass inside single quotes: redacted first, then reduced to letters, digits, spaces and `.,:;()#/_+-`.
 * Empty when nothing survives (emoji or control characters only); the caller falls back to the version, OS and summary.
 */
function safeTitle(title: string, home: string): string {
  return redactReport(title, home).replace(/[^\p{L}\p{N} .,:;()#/_+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160)
}

/**
 * Read-only draft of an Agent Hub issue: environment, installed CLIs, the window's structured hub.log events, process incidents and
 * notice causes. Free-form logs never enter the public body; everything still passes through redactReport. Publishing needs approval.
 */
export async function diagnosticReport(sql: Sql, memoryDirectory: string, raw: z.infer<typeof diagnosticReportInput>) {
  const from = new Date(raw.from).toISOString(), to = new Date(raw.to).toISOString()
  check(from < to && Date.parse(to) - Date.parse(from) <= WINDOW_MAX_MS, "La ventana debe ir de from a to y durar como máximo 24 h.", 400)
  const logDir = process.env.AGENTHUB_LOG_DIR || join(memoryDirectory, "logs")
  const clis: Record<string, string> = {}
  for (const [cli, label] of CLIS) clis[label] = cliInstalled(cli)
  const incidents = await sql.query(`SELECT observed_at,subject_kind,cause,action,member_id,generation FROM process_incidents
    WHERE observed_at>=$1 AND observed_at<=$2 ORDER BY observed_at LIMIT ${LOG_LINES}`, [from, to])
  const notices = await sql.query(`SELECT created_at,cause,session_id,recipient_id,cancelled_at IS NOT NULL AS cancelled FROM chat_status_notices
    WHERE created_at>=$1 AND created_at<=$2 ORDER BY created_at LIMIT ${LOG_LINES}`, [from, to])
  const platform = ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string>)[process.platform] ?? process.platform
  const home = homedir()
  const fallback = `Agent Hub ${hubVersion()} en ${platform}: ${safeTitle(raw.summary.split("\n")[0]!.slice(0, 120), home) || "problema reportado"}`
  const title = (raw.title ? safeTitle(raw.title, home) : "") || safeTitle(fallback, home)
  const report = buildReport({
    title,
    summary: raw.summary,
    error: raw.observed,
    environment: { Versión: hubVersion(), Sistema: `${process.platform} ${release()} (${process.arch})`, Node: process.version, ...clis, Ventana: `${from} a ${to} (UTC)` },
    details: { ...(raw.steps ? { Pasos: raw.steps } : {}), ...(raw.expected ? { Esperado: raw.expected } : {}) },
    logs: [
      { name: "hub", lines: hubEvents(join(logDir, "hub.log"), from, to) },
      { name: "process_incidents", lines: incidents.map(row => `${row.observed_at} ${row.subject_kind} ${row.cause} ${row.action} member=${row.member_id ?? "-"} generation=${row.generation ?? "-"}`) },
      { name: "status_notices", lines: notices.map(row => `${row.created_at} ${row.cause} session=${row.session_id} recipient=${row.recipient_id}${row.cancelled ? " cancelled" : ""}`) },
    ],
    home,
  })
  return { ...report, repository: "aguara-guazu/agent-hub", published: false,
    local_logs: "core.log, daemon.log and worker.log stay in the Hub logs folder; attach them only if the person reviews and chooses to.",
    guidance: "Show the person the exact title and body (text) with times in their local zone. If they edit anything, call this tool again with the edited fields and show the new result. Publish only the last returned title and text, after their explicit approval; never add content after it." }
}
