import { randomUUID } from 'node:crypto'
import type { MemoryDatabase } from '../database.js'
import { check, MemoryError } from '../contracts.js'
import { assessment, assistantInstruction, citationIds, shareable, type AgentModel } from './context.js'
import type { CaseRow, Evidence, Profile, Signal, Watch } from './contracts.js'
import { abandonedAtStartup } from './contracts.js'
import { digest, type ChannelAccess, type SlackRead } from './slack.js'
import { presentCase, recentJira, type JiraCase, type LiveEvidence } from './jira.js'

export type Lookup = (project: string, text: string, exclude?: { channel?: string; root?: string; key?: string; jira?: boolean }) => Promise<Evidence[]>
export type Access = (project: string, w: Watch, signal: AbortSignal) => Promise<ChannelAccess>
export function watcher(p: Profile, row: CaseRow) {
  return p.slack.find(
    (w) =>
      w.connector_id === row.source.connector_id &&
      w.channel === row.source.channel &&
      w.team === row.source.team &&
      w.owner === row.source.owner,
  )
}
export const evidenceHash = (evidence: Evidence[]) => digest([...evidence].sort((a, b) => a.id.localeCompare(b.id)))
const contextHashOf = (evidence: Evidence[], jira?: LiveEvidence) => jira && jira.status !== 'not_applicable'
  ? digest([jira.status, jira.detail, jira.remote, evidenceHash(evidence)]) : evidenceHash(evidence)
const sameCase = 'El hilo o su contexto cambió. Volvé a abrir la sugerencia.'
/** A whole message that only asks to send the reviewed draft. */
export const acceptance = /^(?:aceptar|mandalo|envialo|enviálo|enviar|send it|approve)[.!]?$/iu
const simple = /^(?:<@[\w]+>[\s,:]*)?(?:hola|buen día|buenas|gracias|muchas gracias|thank you|thanks|recibido|perfecto)[\s!¡.,🙂👍]*$/iu

export class Attention {
  constructor(
    readonly db: MemoryDatabase,
    readonly model: AgentModel,
    readonly lookup: Lookup,
    readonly access: Access,
    readonly now: () => Date,
    readonly current: (project: string, version: number) => Promise<boolean>,
    readonly liveEvidence: (project: string, row: JiraCase, text: string, signal: AbortSignal) => Promise<LiveEvidence>,
    readonly jiraEnabled: () => boolean,
  ) {}

  async get(id: string) {
    const [row] = await this.db.query<CaseRow & {current_source: number}>(
      `SELECT c.*,($3=1 AND ${recentJira('$2')}) AS current_source FROM assistant_cases c WHERE c.id=$1`,
      [id, this.now().toISOString(), this.jiraEnabled()])
    check(row, 'El asunto no existe', 404)
    return presentCase(row)
  }
  /**
   * Owner dismissal. The case leaves the inbox and its pending work stops; `observe` reopens it
   * once the source produces a different fingerprint. The draft is kept for `restore`.
   */
  async dismiss(ids: string[]) {
    return this.db.transaction(async (sql) => {
      const rows = await sql.query<{ id: string }>(
        `UPDATE assistant_cases SET state='closed',revision=revision+1,source=json_set(source,'$.owner_dismissed',1),updated_at=now()
        WHERE id IN (SELECT value FROM json_each($1)) AND state='open' RETURNING id`,
        [ids],
      )
      const closed = rows.map((r) => r.id)
      await sql.query(
        `UPDATE assistant_work SET scope=json_set(scope,'$.dismissed',state),state='cancelled',lease_pid=NULL,updated_at=now()
        WHERE case_id IN (SELECT value FROM json_each($1)) AND state IN ('queued','blocked','paused')`,
        [closed],
      )
      return closed
    })
  }
  async restore(ids: string[]) {
    return this.db.transaction(async (sql) => {
      const rows = await sql.query<{ id: string }>(
        `UPDATE assistant_cases AS c SET state='open',revision=revision+1,source=json_remove(source,'$.owner_dismissed'),updated_at=now()
        WHERE id IN (SELECT value FROM json_each($1)) AND state='closed' AND source->>'owner_dismissed'=1
        AND (kind<>'jira' OR ($2=1 AND ${recentJira('$3')}))
        AND project_id NOT IN (SELECT project_id FROM archived_projects) RETURNING id`,
        [ids, this.jiraEnabled(), this.now().toISOString()],
      )
      const open = rows.map((r) => r.id)
      await sql.query(
        `UPDATE assistant_work SET state=scope->>'dismissed',updated_at=now(),
        scope=json_set(json_remove(scope,'$.dismissed'),'$.version',(SELECT version FROM assistant_profiles p WHERE p.project_id=assistant_work.project_id))
        WHERE case_id IN (SELECT value FROM json_each($1)) AND state='cancelled' AND scope->>'dismissed' IS NOT NULL`,
        [open],
      )
      return open
    })
  }
  async recover() {
    const pending = await this.db.query("SELECT DISTINCT sender_pid FROM assistant_cases WHERE state='sending'")
    for (const row of pending)
      if (abandonedAtStartup(row.sender_pid)) {
        await this.db.query(
          "UPDATE assistant_cases SET state='uncertain',draft=NULL,revision=revision+1,updated_at=now() WHERE state='sending' AND sender_pid IS $1",
          [row.sender_pid],
        )
      }
  }
  async style(project: string, w: Watch) {
    const rows = await this.db.query(
      `SELECT substr(f.text,1,300) AS text FROM fragments f JOIN sources s ON s.current_version_id=f.version_id
      JOIN entities e ON s.entity_id=e.id JOIN fragment_projects fp ON fp.fragment_id=f.id
      WHERE fp.project_id=$1 AND s.provider='slack' AND s.connector_id=$2 AND s.status='active' AND e.data->>'channel'=$3 AND f.metadata->>'speaker_label'=$4
      AND COALESCE(e.data->>'remote_processing',1) NOT IN (0,'false') AND NOT EXISTS (SELECT 1 FROM fragment_projects other
      JOIN entities proj ON proj.id=other.project_id WHERE other.fragment_id=f.id AND proj.data->>'remote_processing' IN (0,'false'))
      ORDER BY f.start_time DESC LIMIT 6`,
      [project, w.connector_id, w.channel, w.owner],
    )
    return rows.map((r) => r.text as string)
  }
  async settle(project: string, w: Watch, root: string, thread: SlackRead) {
    const key = ['slack', w.team, w.channel, root].join('/')
    const [row] = await this.db.query<CaseRow>('SELECT * FROM assistant_cases WHERE project_id=$1 AND source_key=$2', [project, key])
    if (!row) return
    const receipt = row.send_id && thread.messages.find((m) => m.client_msg_id === row.send_id)
    if (receipt && row.send_id && !row.receipt) await this.confirmed(row, row.send_id, receipt.ts, receipt.text || '')
    if (thread.handled || !thread.signal) {
      await this.db.query(
        `UPDATE assistant_cases SET state='handled',draft=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND state='open' AND revision=$2`,
        [row.id, row.revision],
      )
    }
  }
  async observe(
    project: string,
    p: Profile,
    version: number,
    s: Signal,
    signal: AbortSignal,
    thread?: SlackRead,
    instruction?: string,
    defer = false,
    expected?: number,
  ) {
    const [existing] = await this.db.query<CaseRow>('SELECT * FROM assistant_cases WHERE project_id=$1 AND source_key=$2', [project, s.key])
    if (expected !== undefined) check(existing?.revision === expected && existing.state === 'open', sameCase, 409)
    if (existing && ['sending', 'uncertain'].includes(existing.state)) return
    if (existing?.state === 'sent' && s.kind === 'slack' && Number(existing.source.ts) >= Number(s.source.ts)) return
    const sameSignal = existing?.fingerprint === s.fingerprint && existing.source.jira_verification !== 'out_of_scope'
    if (sameSignal && existing.state !== 'open' && !existing.source.dismissed) return
    if (s.kind !== 'slack' && sameSignal && existing.state === 'open' && !existing.source.refresh) return
    const after = s.kind === 'slack' ? Date.parse(s.at) + p.delay_minutes * 60_000 : this.now().getTime()
    if (this.now().getTime() < after && !existing) return
    const threadQuery =
      s.kind === 'slack' && thread
        ? [
            s.text,
            ...thread.messages
              .filter((m) => m.ts !== s.source.ts)
              .slice(-4)
              .reverse()
              .map((m) => m.text),
          ]
            .join('\n')
            .slice(0, 5000)
        : s.text
    const query = instruction ? threadQuery + '\n' + instruction : threadQuery
    const live = s.kind === 'slack' ? await this.sharedJira(project, { ...s, source_key: s.key }, query, signal) : undefined
    const jiraHash = live && contextHashOf(live.evidence, live)
    const memory = async () => {
      const hits = await this.lookup(project, query, { channel: s.source.channel, root: s.source.root, key: s.key, jira: true })
      return s.kind === 'slack' ? shareable(this.model, hits) : hits
    }
    let usedMemory = s.kind !== 'jira' && (!live?.evidence.length ||
      (existing?.fingerprint === s.fingerprint && existing?.source.jira_hash === jiraHash && existing?.source.used_memory === true))
    let evidence = [...(s.evidence ?? live?.evidence ?? []), ...(usedMemory ? await memory() : [])]
    let contextHash = contextHashOf(evidence, live)
    const unchanged = sameSignal && existing.source.context_hash === contextHash
    if (
      unchanged &&
      !instruction &&
      !(existing.source.deferred && !defer) &&
      (!existing.source.retry || this.now().getTime() - Date.parse(existing.updated_at) < 3600_000)
    )
      return
    let reason = s.reasons.join('. '),
      score = s.score,
      draft: string | null = null,
      retry = false,
      relevant = true
    const remote = s.kind === 'slack' ? live?.remote !== false && await this.permitsRemote(s.source) : evidence.every(e => e.remote)
    if (s.kind === 'slack' && !defer) {
      const w = p.slack.find((w) => w.connector_id === s.source.connector_id && w.channel === s.source.channel)
      check(w, 'Canal fuera del perfil', 409)
      const contextual = !simple.test(s.text)
      if (!s.source.mention && !s.source.question && !evidence.length) return
      try {
        const examples = await this.style(project, w)
        const assess = () => this.model.run(
          'secretary',
          project,
          p,
          assistantInstruction,
          {
            message: s.text,
            jira: live?.status !== 'not_applicable' ? live && { status: live.status, detail: live.detail, citations: live.evidence.map(e => e.id) } : undefined,
            thread: thread?.messages.slice(-8).map((m) => ({ speaker: m.user, text: m.text?.slice(0, 600) })),
            evidence,
            style: p.style,
            owner: w.owner,
            examples,
            instruction: instruction || null,
          },
          assessment.extend({ citations: citationIds(evidence) }),
          remote && evidence.every((e) => e.remote),
          signal,
          { owner: !!instruction },
        )
        let answer = await assess()
        const supported = () => answer.status === 'supported' && answer.citations.every(id => evidence.some(e => e.id === id)) &&
          (!contextual || answer.citations.length > 0)
        if (!usedMemory && !supported()) {
          const additional = await memory()
          usedMemory = true
          if (additional.length) {
            evidence = [...evidence, ...additional]
            contextHash = contextHashOf(evidence, live)
            answer = await assess()
          }
        }
        const asksState = /\b(estado|status|sigue|abiert[oa]|cerrad[oa]|asignad[oa]|vencimiento|bloquead[oa]|existe|vence|due|closed|open)\b/i.test(query) &&
          /\b(?:[A-Z][A-Z0-9_]*-\d+|jira|tickets?|issues?|tareas?)\b/i.test(query)
        const unverified = asksState && live && (!live.evidence.length || live.status !== 'verified')
        const currentCitation = !asksState || !live?.evidence.length || answer.citations.some(id => live.evidence.some(e => e.id === id))
        relevant = !!s.source.mention || answer.relevant
        score = Math.max(s.score, answer.urgency)
        reason += '. ' + (unverified ? live.detail : answer.explanation)
        if (supported() && currentCitation && !unverified) draft = answer.draft.trim() || null
        if (answer.status === 'supported' && !draft) reason += '. Falta una fuente vigente que respalde la respuesta.'
      } catch (e) {
        signal.throwIfAborted()
        retry = true
        relevant = !!s.source.mention || (s.source.question && (s.score >= 6 || evidence.length > 0))
        reason += '. ' + (e instanceof Error ? e.message : 'Modelo no disponible')
      }
    }
    signal.throwIfAborted()
    check(await this.current(project, version), 'El perfil cambió', 409)
    const source = {
      ...s.source,
      text: s.text,
      at: s.at,
      query,
      context_hash: contextHash,
      jira_hash: jiraHash,
      used_memory: usedMemory,
      retry,
      deferred: defer,
      remote,
      dismissed: !relevant,
    }
    const state = relevant ? 'open' : 'closed'
    const values = [
      project,
      s.key,
      s.kind,
      s.title,
      score,
      reason,
      state,
      source,
      evidence,
      s.fingerprint,
      draft,
      new Date(after).toISOString(),
      this.now().toISOString(),
    ]
    return this.db.transaction(async (sql) => {
      const [row] = await sql.query<CaseRow>(
        `INSERT INTO assistant_cases(project_id,source_key,kind,title,score,reason,state,source,evidence,fingerprint,draft,notify_after,updated_at,id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 WHERE EXISTS(SELECT 1 FROM assistant_profiles WHERE project_id=$1 AND version=$16 AND config->>'active'=1)
      ON CONFLICT(project_id,source_key) DO UPDATE SET title=excluded.title,score=excluded.score,reason=excluded.reason,state=excluded.state,
      source=excluded.source,evidence=excluded.evidence,fingerprint=excluded.fingerprint,draft=excluded.draft,notify_after=excluded.notify_after,
      revision=assistant_cases.revision+1,send_id=NULL,receipt=NULL,updated_at=excluded.updated_at
      WHERE assistant_cases.revision=$15 AND assistant_cases.state NOT IN ('sending','uncertain') RETURNING *`,
        [...values, randomUUID(), existing?.revision ?? 0, version],
      )
      if (row && relevant && s.kind === 'slack' && !defer && !instruction)
        await sql.query(
          "INSERT INTO assistant_messages(project_id,case_id,role,body,evidence,created_at) VALUES($1,$2,'secretary',$3,$4,now())",
          [project, row.id, draft ? reason + '\n\n' + draft : reason, evidence],
        )
      return row
    })
  }
  private async sharedJira(project: string, row: JiraCase, query: string, signal: AbortSignal) {
    const live = await this.liveEvidence(project, row, query, signal)
    return {...live, evidence: await shareable(this.model, live.evidence)}
  }
  async permitsRemote(source: Signal['source']) {
    const [restricted] = await this.db.query(
      `SELECT 1 FROM connectors c WHERE c.id=$1 AND (c.config->>'remote_processing' IN (0,'false') OR
      EXISTS(SELECT 1 FROM entities e JOIN sources s ON s.entity_id=e.id WHERE s.connector_id=c.id AND e.data->>'channel'=$2
      AND e.data->>'thread_ts'=$3 AND e.data->>'remote_processing' IN (0,'false')) OR
      EXISTS(SELECT 1 FROM json_each(c.project_ids) cp JOIN entities p ON p.id=cp.value WHERE p.data->>'remote_processing' IN (0,'false')))`,
      [source.connector_id, source.channel, source.root],
    )
    return !restricted
  }
  async live(row: CaseRow, p: Profile, signal: AbortSignal) {
    const w = watcher(p, row)
    check(row.kind === 'slack' && w, 'El canal ya no está en el perfil', 409)
    const channel = await this.access(row.project_id, w, signal)
    const thread = await channel.thread(row.source.root, true)
    await this.settle(row.project_id, w, row.source.root, thread)
    return { channel, thread }
  }
  async confirmed(row: CaseRow, request: string, receipt: string, text: string) {
    await this.db.transaction(async (sql) => {
      const match = await sql.query(
        "UPDATE assistant_cases SET state='sent',receipt=$2,draft=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND send_id=$3 AND receipt IS NULL RETURNING id",
        [row.id, receipt, request],
      )
      if (match.length)
        await sql.query(
          "INSERT INTO assistant_messages(project_id,case_id,role,body,evidence,created_at) VALUES($1,$2,'secretary',$3,'[]',now())",
          [row.project_id, row.id, 'Enviado a Slack · ' + row.source.channel + '\n' + text],
        )
    })
  }
  async approve(id: string, revision: number, p: Profile, version: number, signal: AbortSignal) {
    const row = await this.get(id)
    if (row.state === 'sent' && row.receipt && row.source.approved_revision === revision) return row
    check(row.state === 'open' && row.revision === revision && row.draft, sameCase, 409)
    const { channel, thread } = await this.live(row, p, signal)
    const live = await this.sharedJira(row.project_id, row, row.source.query ?? row.title, signal)
    const evidence = [...live.evidence]
    if (row.source.used_memory !== false || !live.evidence.length)
      evidence.push(...await shareable(this.model, await this.lookup(row.project_id, row.source.query ?? row.title, {
        channel: row.source.channel, root: row.source.root, key: row.source_key, jira: true,
      })))
    if (!thread.signal || thread.fingerprint !== row.fingerprint || contextHashOf(evidence, live) !== row.source.context_hash) {
      await this.db.query(
        "UPDATE assistant_cases SET draft=NULL,revision=revision+1,source=json_set(source,'$.context_hash',''),updated_at=now() WHERE id=$1 AND state='open' AND revision=$2",
        [id, revision],
      )
      check(false, sameCase, 409)
    }
    const request = randomUUID()
    check(await this.current(row.project_id, version), 'Perfil pausado', 409)
    const claimed = await this.db.query(
      `UPDATE assistant_cases SET state='sending',send_id=$3,sender_pid=$6,source=json_set(source,'$.approved_revision',$2,'$.approved_text',draft),updated_at=now()
      WHERE id=$1 AND revision=$2 AND state='open' AND EXISTS(SELECT 1 FROM assistant_profiles WHERE project_id=$4 AND version=$5 AND config->>'active'=1) RETURNING id`,
      [id, revision, request, row.project_id, version, process.pid],
    )
    check(claimed.length, sameCase, 409)
    try {
      signal.throwIfAborted()
      const receipt = await channel.send(row.source.root, row.draft, request)
      await this.confirmed(row, request, receipt, row.draft)
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'slack_rejected') {
        await this.db.query(
          "UPDATE assistant_cases SET state='open',reason=$3,send_id=NULL,sender_pid=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND send_id=$2 AND receipt IS NULL",
          [id, request, row.reason + '. ' + error.message],
        )
        throw error
      }
      await this.db.query(
        "UPDATE assistant_cases SET state='uncertain',draft=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND send_id=$2 AND receipt IS NULL",
        [id, request],
      )
      throw error
    }
    return this.get(id)
  }
}
