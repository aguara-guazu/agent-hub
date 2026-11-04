import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, release } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { check } from "./contracts.js"
import { findExtractionCli, type ExtractionCli } from "./cli-extraction.js"
import type { Sql } from "./database.js"
import { buildReport, redactReport, tailLog } from "./report.js"

const WINDOW_MAX_MS = 24 * 60 * 60_000
const LOG_LINES = 200
/** Unpublished drafts are removed by the next report after this age, so an abandoned publication leaves nothing behind for long. */
const DRAFT_TTL_MS = 60 * 60_000
/** A path the agent can paste inside single quotes in POSIX shells and PowerShell alike. */
const QUOTABLE_PATH = /^[^'\0\r\n`$"]+$/
/** Only these hub.log fields reach a public issue; free-form logs (core, daemon, worker) stay local. */
const PUBLIC_FIELDS = ["ts", "component", "event", "step", "duration_ms", "cause", "action", "state", "from", "error_code", "cli", "count", "uncertain",
  "session_id", "recipient_id", "member_id", "generation", "notice_id", "stop_id", "boot_id", "plan_id", "reason", "transaction_id", "attempt", "outcome",
  "drain_boot_id", "previous_boot_id", "startup_transaction", "backup_id"] as const
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
const DRAFT_NAME = /^[0-9a-f-]{36}\.md$/
/**
 * The drafts folder inside the real memory root, never through a symlink. POSIX modes are applied; on Windows privacy comes
 * from the per-user app data folder the memory lives in, whose ACL the folder inherits.
 */
function draftsFolder(memoryDirectory: string, create: boolean): { path: string; dev: number; ino: number } | undefined {
  const root = realpathSync(memoryDirectory)
  const folder = join(root, "issue-drafts")
  if (create) mkdirSync(folder, { mode: 0o700 }) // Throws EEXIST when present; the lstat below decides whether it is usable.
  const stat = lstatSync(folder)
  if (!stat.isDirectory() || realpathSync(folder) !== folder || !QUOTABLE_PATH.test(folder)) return undefined
  return { path: folder, dev: stat.dev, ino: stat.ino }
}
function sameFolder(folder: { path: string; dev: number; ino: number }): boolean {
  try { const stat = lstatSync(folder.path); return stat.isDirectory() && stat.dev === folder.dev && stat.ino === folder.ino } catch { return false }
}
/** Removes regular draft files older than DRAFT_TTL_MS (all of them with maxAgeMs=0); never follows links. */
export function sweepIssueDrafts(memoryDirectory: string, maxAgeMs = DRAFT_TTL_MS): number {
  let removed = 0
  try {
    const folder = draftsFolder(memoryDirectory, false)
    if (!folder) return 0
    const cutoff = Date.now() - maxAgeMs
    for (const name of readdirSync(folder.path)) {
      if (!DRAFT_NAME.test(name)) continue
      const file = join(folder.path, name)
      try {
        const entry = lstatSync(file)
        if (entry.isFile() && entry.mtimeMs <= cutoff && sameFolder(folder)) { unlinkSync(file); removed++ }
      } catch { /* Removed meanwhile. */ }
    }
  } catch { /* No drafts folder yet. */ }
  return removed
}
/**
 * Writes the body to a private, Hub-owned draft file and deletes it after DRAFT_TTL_MS while this process lives; the service
 * sweeps leftovers at startup, so a draft of a stopped Hub goes on its next start.
 * Returns undefined when the folder is unsafe (symlink, outside the memory root) or its path cannot be quoted; the caller then offers the url.
 */
function writeDraft(memoryDirectory: string, body: string): string | undefined {
  try {
    let folder: ReturnType<typeof draftsFolder>
    try { folder = draftsFolder(memoryDirectory, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined
      folder = draftsFolder(memoryDirectory, false)
    }
    if (!folder) return undefined
    chmodSync(folder.path, 0o700)
    sweepIssueDrafts(memoryDirectory)
    if (!sameFolder(folder)) return undefined
    const name = `${randomUUID()}.md`, file = join(folder.path, name)
    writeFileSync(file, body, { mode: 0o600, flag: "wx" })
    const identity = lstatSync(file)
    setTimeout(() => {
      try { const entry = lstatSync(file); if (entry.isFile() && entry.dev === identity.dev && entry.ino === identity.ino && sameFolder(folder)) unlinkSync(file) } catch { /* Already published or removed. */ }
    }, DRAFT_TTL_MS).unref()
    return file
  } catch { return undefined }
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
  const bodyFile = writeDraft(memoryDirectory, report.text)
  return { ...report, repository: "aguara-guazu/agent-hub", published: false, ...(bodyFile ? { body_file: bodyFile } : {}),
    local_logs: "core.log, daemon.log and worker.log stay in the Hub logs folder; attach them only if the person reviews and chooses to.",
    guidance: "Show the person the exact title and body (text) with times in their local zone. If they edit anything, call this tool again with the edited fields and show the new result. Publish only the last returned title and body_file, after their explicit approval; never add content after it. body_file is private and the Hub deletes it within an hour if it is not published (on its next start if it was closed)." }
}
