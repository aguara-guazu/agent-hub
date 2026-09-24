import { randomUUID } from 'node:crypto'
import type { MemoryStore } from './store.js'
import type { MemoryAI } from './ai.js'
import type { AIConfig, Vault } from './config.js'
import type { GoogleAuth } from './google-auth.js'
import { MemoryError } from './contracts.js'
import { scheduleEntityIndex, indexEntities } from './entity-index.js'
import { processVersion } from './processing.js'
import { dedupePeople } from './people-dedupe.js'
import { sweepNotes } from './agents.js'
import { ProviderError, ProviderHttp } from './connectors/http.js'
import type { Connector, ConnectorContext } from './connectors/types.js'
import { syncGoogle, importGoogleDocument, repairGoogle } from './connectors/google.js'
import { syncNotion } from './connectors/notion.js'
import { syncSlack } from './connectors/slack.js'
import { syncJira } from './connectors/jira.js'

export class JobRunner {
  readonly workerId = randomUUID()
  constructor(private store: MemoryStore, private ai: MemoryAI, private vault: Vault, private google: GoogleAuth,
    private settings: () => Promise<AIConfig>, private fetcher: typeof fetch = fetch) {}

  async schedule(): Promise<void> {
    await this.store.db.query(`UPDATE jobs SET state='queued',lease_until=NULL,lease_owner=NULL,available_at=now(),updated_at=now()
      WHERE state='running' AND lease_until<now()`)
    const due = await this.store.db.query<Connector>(`SELECT c.* FROM connectors c WHERE c.enabled=true
      AND (c.last_success_at IS NULL OR c.last_success_at<now()-make_interval(mins=>c.interval_minutes))
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='sync' AND j.payload->>'connector_id'=c.id::text
        AND (j.state IN ('queued','running','waiting') OR j.updated_at>now()-make_interval(mins=>c.interval_minutes)))`)
    for (const connector of due) await this.store.enqueue('sync', { connector_id: connector.id }, `sync:${connector.id}`)
    await scheduleEntityIndex(this.store, await this.settings())
    await sweepNotes(this.store.db)
    await this.store.db.query(`INSERT INTO settings(key,value) VALUES('worker',jsonb_build_object('heartbeat',now(),'id',$1::text)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [this.workerId])
  }

  async once(signal: AbortSignal): Promise<boolean> {
    const job = (await this.store.db.query(`UPDATE jobs SET state='running',lease_owner=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT id FROM jobs WHERE state IN ('queued','waiting') AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [this.workerId]))[0]
    if (!job) return false
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const heartbeat = setInterval(() => {
      void this.store.db.query("UPDATE settings SET value=jsonb_build_object('heartbeat',now(),'id',$1::text) WHERE key='worker'", [this.workerId]).catch(() => undefined)
      void this.store.db.query("UPDATE jobs SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id", [job.id, this.workerId])
        .then(rows => { if (!rows.length) controller.abort() }).catch(() => controller.abort())
    }, 30_000)
    const progress = async (value: Record<string, unknown>) => {
      const rows = await this.store.db.query("UPDATE jobs SET progress=progress || $3::jsonb,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id", [job.id, this.workerId, JSON.stringify(value)])
      if (!rows.length) { controller.abort(); controller.signal.throwIfAborted() }
    }
    try {
      await progress({ started_at: new Date().toISOString(), finished_at: null, stage: 'preparing' })
      if (job.kind === 'process') {
        const settings = await this.settings()
        if (job.payload.index_only) { settings.extraction = 'disabled'; await progress({ index_only: true }) }
        if (job.payload.identity_only) await progress({ identity_only: true })
        if (job.payload.projects_only) await progress({ projects_only: true })
        const result = await processVersion(this.store, this.ai.forJob(settings, controller.signal, progress), job.payload.version_id, settings, progress, controller.signal,
          Boolean(job.payload.force), Boolean(job.payload.identity_only), { runKey: job.id, projectsOnly: Boolean(job.payload.projects_only) })
        await progress(result)
      } else if (job.kind === 'index_entities') {
        const settings = await this.settings()
        await progress(await indexEntities(this.store, this.ai.forJob(settings, controller.signal, progress), settings, controller.signal, progress))
      } else if (job.kind === 'dedupe_people') {
        const settings = await this.settings()
        await progress(await dedupePeople(this.store, this.ai.forJob(settings, controller.signal, progress), settings, progress, controller.signal))
      } else if (job.kind === 'sync' || job.kind === 'google_document' || job.kind === 'google_repair') {
        const connector = (await this.store.db.query<Connector>('SELECT * FROM connectors WHERE id=$1', [job.payload.connector_id]))[0]
        if (!connector) throw new MemoryError(404, 'El conector ya no existe')
        if (!connector.enabled) throw new MemoryError(409, 'El conector está pausado')
        const ctx: ConnectorContext = { store: this.store, vault: this.vault, google: this.google,
          http: new ProviderHttp(this.fetcher, controller.signal), signal: controller.signal, progress,
          checkpoint: async cursor => { await this.store.db.query('UPDATE connectors SET cursor=$2 WHERE id=$1', [connector.id, JSON.stringify(cursor)]) } }
        if (job.kind === 'google_repair') await repairGoogle(connector, ctx)
        else if (job.kind === 'google_document') await importGoogleDocument(connector, ctx, job.payload.document_id, job.payload.meeting_entity_id ?? job.payload.event_entity_id)
        else {
          await ({ google: syncGoogle, notion: syncNotion, slack: syncSlack, jira: syncJira })[connector.provider](connector, ctx)
          await this.store.db.query('UPDATE connectors SET last_success_at=now(),last_error=NULL WHERE id=$1', [connector.id])
        }
      } else throw new MemoryError(422, 'Tipo de trabajo desconocido')
      await progress({ finished_at: new Date().toISOString() })
      await this.store.db.query("UPDATE jobs SET state='completed',lease_until=NULL,lease_owner=NULL,error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2", [job.id, this.workerId])
    } catch (error) {
      const message = error instanceof MemoryError ? error.message : controller.signal.aborted ? 'Trabajo interrumpido; se puede reanudar' : 'No se pudo completar el trabajo; revisá disponibilidad y configuración de la fuente'
      const retry = (controller.signal.aborted || !(error instanceof MemoryError && [404,409,422].includes(error.statusCode))) && job.attempts < job.max_attempts
      // An overloaded model provider needs minutes, not seconds: 1, 2, 4 and 8 minutes after the in-request retries.
      const seconds = error instanceof ProviderError && error.retryAfter > 0 ? error.retryAfter
        : error instanceof MemoryError && error.transient ? Math.min(1800, 60 * 2 ** Math.max(0, job.attempts - 1)) : Math.min(300, 2 ** job.attempts * 5)
      await this.store.db.query(`UPDATE jobs SET state=$3,error=$4,lease_until=NULL,lease_owner=NULL,available_at=now()+make_interval(secs=>$5),updated_at=now()
        WHERE id=$1 AND lease_owner=$2`, [job.id, this.workerId, retry ? 'waiting' : 'failed', message, seconds]).catch(() => undefined)
      if (job.kind === 'sync') await this.store.db.query('UPDATE connectors SET last_error=$2 WHERE id=$1', [job.payload.connector_id, message]).catch(() => undefined)
    } finally { clearInterval(heartbeat); signal.removeEventListener('abort', abort) }
    return true
  }
}
