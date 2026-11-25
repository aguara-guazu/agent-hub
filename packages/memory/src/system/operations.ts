import { diagnosticReport, diagnosticReportInput } from "../diagnostic-report.js"
import { z } from 'zod'
import { check, id } from '../contracts.js'
import { MemoryStore } from "../store.js"
import type { AgentContext } from '../agents.js'

import type { HubStopCoordinator } from "../hub-stop.js"
const page = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }
export const systemReadOperations = ['diagnostic_report', 'list_jobs', 'processing_status'] as const satisfies readonly (keyof typeof systemDefinitions)[]

export const systemDefinitions = {
  hub_stop_confirm: ["Confirm a requested coordinated stop only after telling every member to reach a safe point, report and stop. Current notified coordinator only; idempotent; does not stop processes.",
    z.object({ session_key: z.string().min(32).max(200), stop_id: id }).strict()],
  diagnostic_report: ["Only when the person reports a problem with Agent Hub itself (skill report-hub-issue): redacted issue draft (title, body, prefilled URL and a private body_file deleted within an hour) with versions, OS, CLIs, the window's log lines, process incidents and notice causes. Publishes nothing.", diagnosticReportInput],
  list_jobs: ['Sync/processing jobs: source, model, progress, retries, errors. kind takes comma-separated types.', z.object({ ...page, kind: z.string().max(100).optional(), state: z.enum(['active','queued','running','waiting','completed','failed','cancelled']).optional() }).strict()],
  processing_status: ['Memory activity, reported tokens, extraction coverage.', z.object({}).strict()],
  retry_job: ['Retry a failed or paused job.', z.object({ id }).strict()],
  cancel_job: ['Cancel a job; imported data is kept.', z.object({ id }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export async function callSystemOperation(store: MemoryStore, stop: HubStopCoordinator | undefined, operation: string, input: any, agent?: AgentContext) {
  const db = store.db
  switch (operation) {
    case "hub_stop_confirm": {
      check(agent && stop, "La parada coordinada requiere una sesión de agente registrada en el core.", 403)
      return stop.confirm(agent, input.session_key, input.stop_id)
    }

    case 'diagnostic_report': return diagnosticReport(store.db, store.directory, input)
    case 'list_jobs': {
      const where = `($1 IS NULL OR j.kind IN (SELECT value FROM json_each($1))) AND ($2 IS NULL OR j.state=$2 OR ($2='active' AND j.state IN ('queued','running','waiting')))`
      const kinds = input.kind ? input.kind.split(',') : null
      return { items: await db.query(`SELECT j.*,COALESCE(e.id,j.progress->>'entity_id') AS entity_id,
        COALESCE(e.title,j.progress->>'source_title',c.name) AS source_title,c.name AS connector_name,s.entity_id IS NOT NULL AND s.current_version_id=v.id AS "current_version:bool"
        FROM jobs j LEFT JOIN versions v ON v.id=j.payload->>'version_id' LEFT JOIN sources s ON s.id=v.source_id
        LEFT JOIN entities e ON e.id=s.entity_id LEFT JOIN connectors c ON c.id=j.payload->>'connector_id'
        WHERE ${where} ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,j.created_at DESC LIMIT $3 OFFSET $4`, [kinds,input.state ?? null,input.limit,input.offset]),
      total: (await db.query(`SELECT count(*) AS total FROM jobs j WHERE ${where}`, [kinds,input.state ?? null]))[0]!.total }
    }
    case 'processing_status': {
      const states = await db.query("SELECT state,count(*) AS count FROM jobs WHERE kind IN ('process','describe_source','index_entities','dedupe_people','tidy_memory','media','recording') GROUP BY state")
      const [usage] = await db.query("SELECT CAST(COALESCE(sum(CAST(progress->>'input_tokens' AS INTEGER)),0) AS REAL) AS input_tokens,CAST(COALESCE(sum(CAST(progress->>'output_tokens' AS INTEGER)),0) AS REAL) AS output_tokens FROM jobs WHERE kind IN ('process','describe_source')")
      const [coverage] = await db.query(`SELECT count(*) AS sources,count(*) FILTER(WHERE json_type(v.metadata,'$.extraction_key') IS NOT NULL) AS extracted
        FROM sources s JOIN versions v ON v.id=s.current_version_id WHERE s.status='active'`)
      return { states: Object.fromEntries(states.map(r => [r.state,r.count])), usage, coverage }
    }
    case 'retry_job': {
      const rows = await db.query("UPDATE jobs SET state='queued',attempts=0,error=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND state IN ('failed','cancelled','waiting') RETURNING *", [input.id])
      check(rows[0], 'El trabajo no está disponible para reintentar', 409); return rows[0]
    }
    case 'cancel_job': return db.query("UPDATE jobs SET state='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state IN ('queued','running','waiting') RETURNING id,state", [input.id])
  }
}
