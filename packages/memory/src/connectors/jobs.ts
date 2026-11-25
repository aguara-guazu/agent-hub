import type { MemoryStore } from '../store.js'
import type { Vault } from '../config.js'
import type { GoogleAuth } from './google-auth.js'
import { MemoryError } from '../contracts.js'
import { ProviderHttp } from './http.js'
import type { Connector, ConnectorContext } from './types.js'
import { syncGoogle, syncGoogleRange, importGoogleDocument, repairGoogle } from './google.js'
import { syncGmail } from './gmail.js'
import { GMAIL_SCOPE } from './google-auth.js'
import { syncNotion } from './notion.js'
import { syncSlack } from './slack.js'
import { syncJira } from './jira.js'

/** Gmail is polled apart from the full Google sync, which re-reads calendar windows and Meet records on every run. */
const GMAIL_POLL_SECONDS = 120
const GMAIL_RETRY_SECONDS = 1800

export async function scheduleImports(store: MemoryStore, google: GoogleAuth) {
  const due = await store.db.query<Connector>(`SELECT c.* FROM connectors c WHERE c.enabled=1
    AND (c.last_success_at IS NULL OR c.last_success_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||c.interval_minutes||' minutes'))
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='sync' AND j.payload->>'connector_id'=c.id AND j.payload->>'since' IS NULL
      AND (j.state IN ('queued','running','waiting') OR j.updated_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||c.interval_minutes||' minutes')))`)
  for (const connector of due) await store.enqueue('sync', { connector_id: connector.id }, `sync:${connector.id}`)
  const mailboxes = await store.db.query<Connector>(`SELECT c.* FROM connectors c WHERE c.enabled=1 AND c.provider='google' AND COALESCE(c.config->>'gmail_enabled',1) NOT IN (0,'false')
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='gmail' AND j.payload->>'connector_id'=c.id AND (j.state IN ('queued','running','waiting')
      OR j.updated_at>strftime('%Y-%m-%dT%H:%M:%fZ','now',CASE WHEN j.state='completed' THEN $1 ELSE $2 END)))`,
    [`-${GMAIL_POLL_SECONDS} seconds`, `-${GMAIL_RETRY_SECONDS} seconds`])
  for (const connector of mailboxes) if (google.granted(connector.id, GMAIL_SCOPE)) await store.enqueue('gmail', { connector_id: connector.id }, `gmail:${connector.id}`)
  await store.db.query(`DELETE FROM jobs WHERE kind='gmail' AND state='completed' AND COALESCE(progress->>'imported',0)=0
    AND updated_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`)
}

export async function runConnectorJob(
  { store, vault, google, fetcher }: { store: MemoryStore; vault: Vault; google: GoogleAuth; fetcher: typeof fetch },
  job: Record<string, any>, signal: AbortSignal, progress: ConnectorContext['progress'],
) {
  const connector = (await store.db.query<Connector>('SELECT * FROM connectors WHERE id=$1', [job.payload.connector_id]))[0]
  if (!connector) throw new MemoryError(404, 'El conector ya no existe')
  if (!connector.enabled) throw new MemoryError(409, 'El conector está pausado')
  const ctx: ConnectorContext = { store, vault, google,
    http: new ProviderHttp(fetcher, signal), signal, progress,
    checkpoint: async cursor => { await store.db.query('UPDATE connectors SET cursor=$2 WHERE id=$1', [connector.id, JSON.stringify(cursor)]) } }
  if (job.kind === 'google_repair') await repairGoogle(connector, ctx)
  else if (job.kind === 'gmail') {
    await syncGmail(connector, ctx)
    await store.db.query("UPDATE connectors SET last_error=NULL WHERE id=$1 AND last_error LIKE 'Gmail:%'", [connector.id])
  }
  else if (job.kind === 'google_document') await importGoogleDocument(connector, ctx, job.payload.document_id, job.payload.meeting_entity_id ?? job.payload.event_entity_id)
  else if (job.payload.since) await syncGoogleRange(connector, ctx, job.payload.since, job.payload.until)
  else {
    await ({ google: syncGoogle, notion: syncNotion, slack: syncSlack, jira: syncJira })[connector.provider](connector, ctx)
    await store.db.query('UPDATE connectors SET last_success_at=now(),last_error=NULL WHERE id=$1', [connector.id])
  }
}
