import { runProjectJob } from './projects/jobs.js'
import { runConnectorJob, scheduleImports } from './connectors/jobs.js'
import { runTranscriptionJob, scheduleTranscriptions } from './transcriptions/jobs.js'
import { appModules, jobModules, jobOwner, type ModuleEnabled } from '@agenthub/shared/modules'
import type { MediaRuntime } from './transcriptions/media-runtime.js'
import { NATIVE_EMBEDDING_ENGINES } from './native-embeddings.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseError, type Sql } from './database.js'
import type { MemoryStore } from './store.js'
import type { MemoryAI } from './ai.js'
import type { AIConfig, Vault } from './config.js'
import type { GoogleAuth } from './connectors/google-auth.js'
import { MemoryError } from './contracts.js'
import { scheduleEntityIndex } from './projects/entity-index.js'
import { sweepNotes } from './agents.js'
import { ProviderError } from './connectors/http.js'
import { ADMISSION_SETTING } from "./admission-gate.js"

/** Whole-memory passes that rewrite people, identities or vectors: they start alone and nothing starts next to them.
 *  Once one is the oldest pending job, newer jobs wait so it is not postponed indefinitely. */
const EXCLUSIVE_KINDS = ['dedupe_people', 'google_repair', 'tidy_memory']
/** Exclusive passes that leave connector cursors alone: syncs and Gmail polls still start next to them (and they start
 *  next to those imports), so mail keeps arriving during a long dedupe. Writes stay serialized by the single writer
 *  connection; a person merged mid-import is followed through `merged_into` and the repointed identities.
 *  google_repair rewrites the Google source itself and keeps running alone. */
const IMPORT_KINDS = ['sync', 'gmail']
const IMPORTS_ALONGSIDE = ['dedupe_people', 'tidy_memory']
/** One running job per kind: a global pass, or local OCR/transcription engines shared by every job. */
const SINGLE_KINDS = ['index_entities', 'media', 'recording']
/** Embedding-only jobs beyond one per local engine would only wait in the engines and hold slots extraction can use. */
const MAX_EMBEDDING_ONLY_JOBS = NATIVE_EMBEDDING_ENGINES
export class JobRunner {
  private readonly runningJobs = new Map<AbortController, string>()
  refreshModules() {
    for (const [controller, kind] of this.runningJobs) {
      if (!jobModules(kind).every(this.moduleEnabled)) controller.abort(new Error('module_disabled'))
    }
  }
  readonly workerId = randomUUID()
  constructor(private store: MemoryStore, private ai: MemoryAI, private vault: Vault, private google: GoogleAuth,
    private settings: () => Promise<AIConfig>, private fetcher: typeof fetch = fetch, private media?: MediaRuntime, private moduleEnabled: ModuleEnabled = () => true) {}

  async schedule(): Promise<void> {
    // An expired lease of another owner means that worker died mid-job (native crash, kill). Without the attempts cap a job
    // that aborts the process is claimed again on every restart and takes the other running jobs down with it.
    // Leases of this worker also expire across a macOS sleep; those jobs are still running here and renew on the next heartbeat.
    const orphaned = await this.store.db.query(`UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      error=CASE WHEN attempts>=max_attempts THEN 'El proceso de trabajos se cerró inesperadamente en cada intento de este trabajo' ELSE error END,
      lease_until=NULL,lease_owner=NULL,available_at=now(),updated_at=now()
      WHERE state='running' AND lease_until<now() AND lease_owner IS NOT $1 RETURNING id,kind,state,attempts,max_attempts`, [this.workerId])
    for (const job of orphaned) console.error(`[job ${job.id}] ${job.kind} intento ${job.attempts}/${job.max_attempts}: el worker anterior se cerró con el trabajo en curso; queda ${job.state === 'failed' ? 'fallido' : 'en cola'}`)
    if (this.moduleEnabled('memory')) {
      if (this.moduleEnabled('connections')) await scheduleImports(this.store, this.google)
      await scheduleEntityIndex(this.store, await this.settings())
      if (this.moduleEnabled('transcriptions')) await scheduleTranscriptions(this.store, this.media)
      await sweepNotes(this.store.db)
    }
    await this.store.db.query(`INSERT INTO settings(key,value) VALUES('worker',json_object('heartbeat',now(),'id',$1)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.workerId])
  }

  async once(signal: AbortSignal): Promise<boolean> {
    const job = await this.claim()
    return job ? this.run(job, signal) : false
  }

  /** Takes the oldest available job that can run next to the ones already running (see the kind lists above).
   *  Syncs and Gmail polls of one connector share its cursor and run one at a time; a period import (`since`) writes
   *  no cursor, so the mailbox keeps being polled while it runs. Source syncs go first: they are short network jobs, and
   *  behind an extraction backlog a new mail would otherwise wait for every older source to be processed. */
  async claim(): Promise<Record<string, any> | undefined> {
    if (!this.moduleEnabled('memory')) return undefined
    const blocked = appModules.filter(module => !this.moduleEnabled(module.id)).flatMap(module => [...module.jobs] as string[])
    // The worker is a separate process: core publishes the closed admission gate of a silent update in `settings`, and a claim
    // is refused in the same statement that would take the job. Queued jobs wait; running ones are counted by core as blockers.
    return (await this.store.db.query(`UPDATE jobs SET state='running',lease_owner=$1,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes'),attempts=attempts+1,updated_at=now()
      WHERE NOT EXISTS(SELECT 1 FROM settings g WHERE g.key='${ADMISSION_SETTING}' AND CAST(g.value->>'until' AS INTEGER)>CAST(strftime('%s','now') AS INTEGER)*1000)
        AND id=(SELECT j.id FROM jobs j WHERE j.state IN ('queued','waiting') AND j.available_at<=now()
        AND j.kind NOT IN (SELECT value FROM json_each($7))
        AND NOT EXISTS(SELECT 1 FROM jobs r WHERE r.state='running' AND (
          ((r.kind IN (SELECT value FROM json_each($2)) OR j.kind IN (SELECT value FROM json_each($2)))
            AND NOT ((j.kind IN (SELECT value FROM json_each($5)) AND r.kind IN (SELECT value FROM json_each($6)))
              OR (r.kind IN (SELECT value FROM json_each($5)) AND j.kind IN (SELECT value FROM json_each($6)))))
          OR (r.kind=j.kind AND j.kind IN (SELECT value FROM json_each($3)))
          OR (r.payload->>'version_id' IS NOT NULL AND r.payload->>'version_id'=j.payload->>'version_id')
          OR (j.kind IN ('sync','gmail') AND r.kind IN ('sync','gmail') AND r.payload->>'connector_id'=j.payload->>'connector_id'
            AND NOT ((j.kind='gmail' AND r.payload->>'since' IS NOT NULL) OR (r.kind='gmail' AND j.payload->>'since' IS NOT NULL)))))
        AND NOT (COALESCE(j.payload->>'index_only',0) IN (1,'true') AND (SELECT count(*) FROM jobs r WHERE r.state='running'
          AND COALESCE(r.payload->>'index_only',0) IN (1,'true'))>=$4)
        AND NOT EXISTS(SELECT 1 FROM jobs x WHERE x.kind IN (SELECT value FROM json_each($2)) AND x.state IN ('queued','waiting')
          AND x.kind NOT IN (SELECT value FROM json_each($7)) AND x.available_at<=now() AND x.created_at<j.created_at
          AND NOT (j.kind IN (SELECT value FROM json_each($5)) AND x.kind IN (SELECT value FROM json_each($6)))
          AND NOT EXISTS(SELECT 1 FROM jobs y WHERE y.state IN ('queued','waiting') AND y.kind NOT IN (SELECT value FROM json_each($7)) AND y.available_at<=now() AND y.created_at<x.created_at))
        ORDER BY CASE WHEN j.kind IN ('gmail','sync') THEN 0 ELSE 1 END,j.created_at LIMIT 1) RETURNING *`,
      [this.workerId, JSON.stringify(EXCLUSIVE_KINDS), JSON.stringify(SINGLE_KINDS), MAX_EMBEDDING_ONLY_JOBS, JSON.stringify(IMPORT_KINDS), JSON.stringify(IMPORTS_ALONGSIDE), JSON.stringify(blocked)]))[0]
  }

  async run(job: Record<string, any>, signal: AbortSignal): Promise<boolean> {
    const controller = new AbortController()
    this.runningJobs.set(controller, String(job.kind))
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // Recording inference is expensive. Retry only its idempotent job writes on temporary SQLite contention.
    // Three 30-second busy timeouts still fit inside the three-minute lease; other database errors remain failures.
    const jobQuery: Sql['query'] = async (sql, params) => {
      for (let attempt = 0;; attempt++) {
        try { return await this.store.db.query(sql, params) } catch (error) {
          const busy = error instanceof DatabaseError && [5, 6].includes((error.errcode ?? 0) & 255)
          if (job.kind !== 'recording' || !busy || attempt >= 2 || controller.signal.aborted) throw error
          await sleep(250 * 2 ** attempt, undefined, { signal: controller.signal })
        }
      }
    }
    let renewing = false
    const heartbeat = setInterval(() => {
      if (renewing) return
      renewing = true
      void this.store.db.query("UPDATE settings SET value=json_object('heartbeat',now(),'id',$1) WHERE key='worker'", [this.workerId]).catch(() => undefined)
      void jobQuery("UPDATE jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 minutes') WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id", [job.id, this.workerId])
        .then(rows => { if (!rows.length) controller.abort() }).catch(() => controller.abort())
        .finally(() => { renewing = false })
    }, 30_000)
    const progress = async (value: Record<string, unknown>) => {
      if (!jobModules(String(job.kind)).every(this.moduleEnabled)) controller.abort(new Error('module_disabled'))
      controller.signal.throwIfAborted()
      const rows = await jobQuery("UPDATE jobs SET progress=jsonb_merge(progress,$3),updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id", [job.id, this.workerId, JSON.stringify(value)])
      if (!rows.length) { controller.abort(); controller.signal.throwIfAborted() }
    }
    try {
      await progress({ started_at: new Date().toISOString(), finished_at: null, stage: 'preparing' })
      const owner = jobOwner(job.kind)
      if (owner === 'transcriptions') {
        await runTranscriptionJob(this.store, this.media, this.ai, this.settings, job, controller.signal, progress)
      } else if (owner === 'connections') {
        await runConnectorJob({ store: this.store, vault: this.vault, google: this.google, fetcher: this.fetcher }, job, controller.signal, progress)
      } else {
        const result = await runProjectJob({
          store: this.store, ai: this.ai, loadSettings: this.settings, workerId: this.workerId,
          sharingEnabled: () => this.moduleEnabled('sharing'),
        }, job, controller.signal, progress)
        if (result === 'waiting') return true
      }
      await progress({ finished_at: new Date().toISOString() })
      await jobQuery("UPDATE jobs SET state='completed',lease_until=NULL,lease_owner=NULL,error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2", [job.id, this.workerId])
    } catch (error) {
      if (controller.signal.reason?.message === 'module_disabled') {
        await jobQuery("UPDATE jobs SET state='queued',attempts=max(0,attempts-1),lease_until=NULL,lease_owner=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND lease_owner=$2", [job.id, this.workerId])
        return true
      }
      // The stored message is user-facing and generic; worker.log keeps the stack for the job's failure report.
      const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
      console.error(diagnostic.split(/\r?\n/).map(line => `[job ${job.id}] ${job.kind} intento ${job.attempts}/${job.max_attempts}: ${line}`).join('\n'))
      const message = error instanceof MemoryError ? error.message : controller.signal.aborted ? 'Trabajo interrumpido; se puede reanudar' : 'No se pudo completar el trabajo; revisá disponibilidad y configuración de la fuente'
      const retry = (controller.signal.aborted || !(error instanceof MemoryError && [404,409,422].includes(error.statusCode))) && job.attempts < job.max_attempts
      // An overloaded model provider needs minutes, not seconds: 1, 2, 4 and 8 minutes after the in-request retries.
      const seconds = error instanceof ProviderError && error.retryAfter > 0 ? error.retryAfter
        : error instanceof MemoryError && error.transient ? Math.min(1800, 60 * 2 ** Math.max(0, job.attempts - 1)) : Math.min(300, 2 ** job.attempts * 5)
      await jobQuery(`UPDATE jobs SET state=$3,error=$4,lease_until=NULL,lease_owner=NULL,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||$5||' seconds'),updated_at=now()
        WHERE id=$1 AND lease_owner=$2`, [job.id, this.workerId, retry ? 'waiting' : 'failed', message, seconds]).catch(() => undefined)
      if (job.kind === 'sync' || job.kind === 'gmail') await this.store.db.query('UPDATE connectors SET last_error=$2 WHERE id=$1', [job.payload.connector_id, job.kind === 'gmail' ? `Gmail: ${message}` : job.payload.since ? `Período histórico: ${message}` : message]).catch(() => undefined)
    } finally { this.runningJobs.delete(controller); clearInterval(heartbeat); signal.removeEventListener('abort', abort) }
    return true
  }
}
