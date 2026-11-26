import { randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { check } from '../contracts.js'
import { projectForPath } from '../agents.js'
import type { MemoryDatabase, Sql } from '../database.js'

export const residentApproval = 'resident_notifications'
export const residentAgent = 'resident-notifications'
export const residentScope = (projectId: string) => 'assistant:notifications:' + projectId
export interface ResidentTeamRun { projectId: string; cwd: string; active(): void }
export type CheckResidentProject = (sql: Sql, projectId: string, delegate: boolean) => Promise<void>

/** The stable coordinator is reachable only through a live resident turn. Its ordinary chat login key is discarded. */
export async function residentCoordinator(db: MemoryDatabase, run: ResidentTeamRun, authorize: CheckResidentProject): Promise<Record<string, any>> {
  check(isAbsolute(run.cwd), 'El asistente necesita una carpeta local de proyecto.', 409)
  const cwd = await realpath(run.cwd).catch(() => undefined)
  check(cwd, 'La carpeta del asistente no está disponible.', 409)
  return db.transaction(async sql => {
    await authorize(sql, run.projectId, false)
    const mapped = await projectForPath(sql, cwd)
    check(!mapped || mapped.id === run.projectId, 'La carpeta pertenece a otro proyecto.', 403)
    const scope = residentScope(run.projectId)
    let [channel] = await sql.query('SELECT * FROM chat_channels WHERE scope_key=$1', [scope])
    // Backup restores historical sessions closed, with their process bindings stripped. Keep their plans as history.
    if (channel?.closed_at && !channel.deleted_at) {
      await sql.query('UPDATE chat_channels SET scope_key=$2 WHERE id=$1', [channel.id, scope + ':closed:' + channel.id])
      channel = undefined
    }
    run.active()
    if (!channel) {
      const id = randomUUID(), sessionId = 'resident:' + randomUUID()
      await sql.query(`INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at)
        VALUES($1,$2,$3,'Asistente de notificaciones',$4,'virtual',now())`, [id, run.projectId, cwd, scope])
      await sql.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,nickname,cli_kind,channel_id,state,capability,event_at)
        VALUES($1,$2,$3,'Asistente de notificaciones','Asistente de notificaciones','assistant',$4,'idle','resident_assistant',now())`,
        [sessionId, residentAgent, randomBytes(32).toString('hex'), id])
      channel = (await sql.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1 RETURNING *', [id, sessionId]))[0]
    }
    check(channel && !channel.closed_at && !channel.deleted_at && channel.project_id === run.projectId,
      'El canal del asistente ya no está vigente para este proyecto.', 403)
    const [who] = await sql.query(`SELECT * FROM chat_sessions WHERE id=$1 AND channel_id=$2 AND agent_id=$3
      AND capability='resident_assistant' AND closed_at IS NULL AND removed_at IS NULL`, [channel.leader_id, channel.id, residentAgent])
    check(who, 'El asistente ya no coordina el canal de este proyecto.', 403)
    if (channel.path !== cwd) await sql.query('UPDATE chat_channels SET path=$2,updated_at=now() WHERE id=$1', [channel.id, cwd])
    await sql.query("UPDATE chat_sessions SET last_seen_at=now(),activity_at=now(),lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds') WHERE id=$1", [who.id])
    run.active()
    return { ...who, residentRun: run, residentCwd: cwd }
  })
}
