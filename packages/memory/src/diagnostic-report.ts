import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir, release } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { check } from "./contracts.js"
import { findExtractionCli, type ExtractionCli } from "./cli-extraction.js"
import type { Sql } from "./database.js"
import { buildReport, tailLog } from "./report.js"

const exec = promisify(execFile)
const WINDOW_MAX_MS = 24 * 60 * 60_000
const LOG_LINES = 200
const LOGS = ["hub", "core", "daemon", "worker"] as const
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
async function cliVersion(cli: ExtractionCli): Promise<string> {
  const binary = findExtractionCli(cli)
  if (!binary) return "no instalada"
  const js = binary.endsWith(".js")
  try {
    const { stdout } = await exec(js ? process.execPath : binary, [...(js ? [binary] : []), "--version"],
      { timeout: 5_000, maxBuffer: 65_536, windowsHide: true, env: { ...process.env, ...(js ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } })
    return stdout.trim().split("\n")[0]?.slice(0, 120) || "instalada"
  } catch { return "instalada (sin versión)" }
}
/** Log lines whose own timestamp (text prefix or JSON ts) falls inside the window; lines without one are skipped. */
function windowLines(path: string, from: string, to: string): string[] {
  return tailLog(path, 20_000).filter(line => {
    const stamp = line.startsWith("{") ? /"ts":"([^"]+)"/.exec(line)?.[1] : line.split(" ", 1)[0]
    return Boolean(stamp && stamp >= from && stamp <= to)
  }).slice(-LOG_LINES)
}

/**
 * Read-only draft of an Agent Hub issue: environment, CLI versions, the window's log lines, process incidents and notice causes.
 * Never includes message text, keys or invitations; everything passes through redactReport. Publishing is the agent's job, after approval.
 */
export async function diagnosticReport(sql: Sql, memoryDirectory: string, raw: z.infer<typeof diagnosticReportInput>) {
  const from = new Date(raw.from).toISOString(), to = new Date(raw.to).toISOString()
  check(from < to && Date.parse(to) - Date.parse(from) <= WINDOW_MAX_MS, "La ventana debe ir de from a to y durar como máximo 24 h.", 400)
  const logDir = process.env.AGENTHUB_LOG_DIR || join(memoryDirectory, "logs")
  const clis: Record<string, string> = {}
  for (const [cli, label] of CLIS) clis[label] = await cliVersion(cli)
  const incidents = await sql.query(`SELECT observed_at,subject_kind,cause,action,member_id,generation FROM process_incidents
    WHERE observed_at>=$1 AND observed_at<=$2 ORDER BY observed_at LIMIT ${LOG_LINES}`, [from, to])
  const notices = await sql.query(`SELECT created_at,cause,session_id,recipient_id,cancelled_at IS NOT NULL AS cancelled FROM chat_status_notices
    WHERE created_at>=$1 AND created_at<=$2 ORDER BY created_at LIMIT ${LOG_LINES}`, [from, to])
  const platform = ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string>)[process.platform] ?? process.platform
  const report = buildReport({
    title: raw.title ?? `Agent Hub ${hubVersion()} en ${platform}: ${raw.summary.split("\n")[0]!.slice(0, 120)}`,
    summary: raw.summary,
    error: raw.observed,
    environment: { Versión: hubVersion(), Sistema: `${process.platform} ${release()} (${process.arch})`, Node: process.version, ...clis, Ventana: `${from} a ${to} (UTC)` },
    details: { ...(raw.steps ? { Pasos: raw.steps } : {}), ...(raw.expected ? { Esperado: raw.expected } : {}) },
    logs: [
      ...LOGS.map(name => ({ name, lines: windowLines(join(logDir, `${name}.log`), from, to) })),
      { name: "process_incidents", lines: incidents.map(row => `${row.observed_at} ${row.subject_kind} ${row.cause} ${row.action} member=${row.member_id ?? "-"} generation=${row.generation ?? "-"}`) },
      { name: "status_notices", lines: notices.map(row => `${row.created_at} ${row.cause} session=${row.session_id} recipient=${row.recipient_id}${row.cancelled ? " cancelled" : ""}`) },
    ],
    home: homedir(),
  })
  return { ...report, repository: "aguara-guazu/agent-hub", published: false,
    guidance: "Show the person the exact title and body (times in their local zone) and publish only after their explicit approval; never add content after it." }
}
