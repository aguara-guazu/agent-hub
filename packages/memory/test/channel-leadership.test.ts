import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { MemoryDatabase } from "../src/database.js"
import { MemoryStore } from "../src/store.js"
import { MemoryOperations } from "../src/operations.js"
import { MemoryAI } from "../src/ai.js"
import { Vault, defaultAI } from "../src/config.js"
import { chatFolder } from "../src/local-chat.js"
import { LEADER_LIVENESS_TIMEOUT_MS, LEADERSHIP_ATTEMPTS_PER_CHANNEL, LEADERSHIP_ATTEMPTS_PER_SESSION, LEADERSHIP_COOLDOWN_MS, SESSION_LEASE_MS } from "../src/channel-authority.js"
import type { AgentContext } from "../src/agents.js"
import { existingChannel } from "./helpers/chat-channel.js"

let root: string, dir: string, other: string, db: MemoryDatabase, ops: MemoryOperations

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const repo = (path: string) => {
  execFileSync("mkdir", ["-p", path])
  git(path, "init", "-q", "-b", "main")
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "seed")
}
const worktree = (name: string) => { const path = join(dir, name); git(dir, "worktree", "add", "-qb", name, path); return path }
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-leadership-"))
  dir = join(root, "alpha"); other = join(root, "beta")
  repo(dir); repo(other)
  db = new MemoryDatabase(join(root, "memory.sqlite")); await db.migrate()
  ops = new MemoryOperations(new MemoryStore(db, root), new MemoryAI(async () => defaultAI, new Vault(root)))
  await ops.call("create_entity", { kind: "project", title: "Alpha", data: { folders: [dir] } })
  await ops.call("create_entity", { kind: "project", title: "Beta", data: { folders: [other] } })
})
afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }) })

type Agent = Awaited<ReturnType<typeof register>>
async function register(name: string, path = dir) {
  const a: AgentContext = { agent_id: "installed-client", session_id: `native:${name.padEnd(64, "0")}`, cli_kind: "kiro", client: "Kiro", cwd: path }
  const k = randomUUID()
  const r = await ops.chat.lifecycle(a, { session_key: k, native_id: name, event: "Stop", at: new Date().toISOString() })
  const folder = await chatFolder(path)
  await db.query("UPDATE chat_channels SET path=$2 WHERE id=$1", [r.channel.id, folder.root])
  await existingChannel(ops.chat, r, folder.root)
  const named = await ops.call("chat_set_nick", { session_key: k, nickname: `nick-${name}` }, "mcp", a)
  return { a, k, name, channel: r.channel as Record<string, any>, session: named.session as Record<string, any> }
}
const call = (who: Agent, operation: string, input: Record<string, unknown> = {}) => ops.call(operation, { session_key: who.k, ...input }, "mcp", who.a)
const take = (who: Agent, channelId: string, expected: string | null, reason = "El líder no responde") =>
  call(who, "chat_take_leadership", { channel_id: channelId, expected_leader_id: expected, reason })
const channel = async (id: string) => (await db.query("SELECT * FROM chat_channels WHERE id=$1", [id]))[0]!
const events = (channelId: string, kind?: string) => db.query(`SELECT * FROM chat_authority_events WHERE channel_id=$1 ${kind ? "AND kind=$2" : ""} ORDER BY seq`, kind ? [channelId, kind] : [channelId])
/** Last Hub-verified signal `minutes` ago, as the lease and last_seen columns would record it. */
async function silence(who: Agent, minutes: number) {
  const at = Date.now() - minutes * 60_000
  await db.query("UPDATE chat_sessions SET last_seen_at=$2,lease_until=$3 WHERE id=$1", [who.session.id, iso(at), iso(at + SESSION_LEASE_MS)])
}
async function rejected(promise: Promise<unknown>, status: number, code?: string) {
  await expect(promise).rejects.toMatchObject({ statusCode: status, ...(code ? { code } : {}) })
}
async function thread(who: Agent, channelId: string, title = "Tema") {
  return call(who, "chat_send", { channel_id: channelId, title, text: "hola", mentions: [], request_id: randomUUID() })
}
const silentMinutes = LEADER_LIVENESS_TIMEOUT_MS / 60_000 + 5

describe("toma de liderazgo", () => {
  it("toma el canal de un líder silencioso por más del umbral, con auditoría y aviso al desplazado", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
    await silence(leader, silentMinutes)
    const result = await take(candidate, leader.channel.id, leader.session.id)
    expect(result).toMatchObject({ mode: "takeover", leader_id: candidate.session.id, previous_leader_id: leader.session.id })
    expect(await channel(leader.channel.id)).toMatchObject({ leader_id: candidate.session.id, displaced_leader_id: leader.session.id })
    const [event] = await events(leader.channel.id, "leadership_takeover")
    expect(event).toMatchObject({ actor_session_id: candidate.session.id, target_session_id: leader.session.id })
    expect(event!.evidence.silent_ms).toBeGreaterThan(LEADER_LIVENESS_TIMEOUT_MS)
    expect(event!.evidence).toMatchObject({ threshold_ms: LEADER_LIVENESS_TIMEOUT_MS, previous_leader_id: leader.session.id })
    const notice = (await db.query("SELECT * FROM chat_status_notices WHERE recipient_id=$1 AND cause='leadership_taken'", [leader.session.id]))[0]
    expect(notice?.text).toContain(event!.id)
  })

  it("rechaza la toma si el líder tiene lease vigente", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await rejected(take(candidate, leader.channel.id, leader.session.id), 409, "leader_live")
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
    expect((await events(leader.channel.id, "leadership_rejected"))[0]!.evidence.code).toBe("leader_live")
  })

  it("rechaza la toma si el último liveness verificado está dentro del umbral", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, LEADER_LIVENESS_TIMEOUT_MS / 60_000 - 5)
    await rejected(take(candidate, leader.channel.id, leader.session.id), 409, "leader_recent")
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
  })

  it("rechaza la toma con un expected_leader_id viejo (compare-and-set)", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await rejected(take(candidate, leader.channel.id, candidate.session.id), 409, "leader_changed")
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
  })

  it("rechaza la toma desde otro proyecto o sin proyecto", async () => {
    const leader = await register("leader"), outsider = await register("outsider", other)
    await silence(leader, silentMinutes)
    await rejected(take(outsider, leader.channel.id, leader.session.id), 403, "project_mismatch")
    const loose = join(root, "loose"); repo(loose)
    const projectless = await register("projectless", loose)
    await rejected(take(projectless, leader.channel.id, leader.session.id), 403, "project_mismatch")
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
  })

  it("rechaza la toma de un miembro de equipo del Hub", async () => {
    const leader = await register("leader"), fleet = await register("fleet")
    await db.query("UPDATE chat_sessions SET capability='hub_fleet' WHERE id=$1", [fleet.session.id])
    await silence(leader, silentMinutes)
    await rejected(take(fleet, leader.channel.id, leader.session.id), 403, "team_member")
  })

  it("rechaza la toma de un canal cerrado o sin líder", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await db.query("UPDATE chat_channels SET leader_id=NULL WHERE id=$1", [leader.channel.id])
    await rejected(take(candidate, leader.channel.id, null), 409, "no_leader")
    await db.query("UPDATE chat_channels SET leader_id=$2,closed_at=now() WHERE id=$1", [leader.channel.id, leader.session.id])
    await rejected(take(candidate, leader.channel.id, leader.session.id), 409, "channel_closed")
  })

  it("no admite dos líderes: el segundo candidato simultáneo pierde el compare-and-set", async () => {
    const leader = await register("leader"), first = await register("first"), second = await register("second")
    await silence(leader, silentMinutes)
    const results = await Promise.allSettled([take(first, leader.channel.id, leader.session.id), take(second, leader.channel.id, leader.session.id)])
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1)
    const winner = (await channel(leader.channel.id)).leader_id
    expect([first.session.id, second.session.id]).toContain(winner)
    expect(await events(leader.channel.id, "leadership_takeover")).toHaveLength(1)
  })
})

describe("reclamo y enfriamiento", () => {
  it("la misma sesión desplazada reclama aunque el nuevo líder esté conectado; el desplazado no escribe mientras tanto", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    await rejected(thread(leader, leader.channel.id), 403)
    const result = await take(leader, leader.channel.id, candidate.session.id, "Volví")
    expect(result).toMatchObject({ mode: "reclaim", leader_id: leader.session.id, previous_leader_id: candidate.session.id })
    expect(await channel(leader.channel.id)).toMatchObject({ leader_id: leader.session.id, displaced_leader_id: null })
    expect(await events(leader.channel.id, "leadership_reclaim")).toHaveLength(1)
    expect((await db.query("SELECT 1 FROM chat_status_notices WHERE recipient_id=$1 AND cause='leadership_reclaimed'", [candidate.session.id])).length).toBe(1)
    expect(await thread(leader, leader.channel.id)).toMatchObject({ author_id: leader.session.id })
  })

  it("una sesión nueva no hereda el derecho de reclamo ni puede usar el mismo nick", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    const impostor = await register("impostor")
    await rejected(call(impostor, "chat_set_nick", { nickname: "nick-leader" }), 409)
    await rejected(take(impostor, leader.channel.id, candidate.session.id), 409, "leader_live")
    expect(await channel(leader.channel.id)).toMatchObject({ leader_id: candidate.session.id, displaced_leader_id: leader.session.id })
  })

  it("quien perdió el canal por un reclamo no lo vuelve a tomar durante el enfriamiento", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    await take(leader, leader.channel.id, candidate.session.id, "Volví")
    await silence(leader, silentMinutes)
    await rejected(take(candidate, leader.channel.id, leader.session.id), 409, "cooldown")
    await db.query("UPDATE chat_authority_events SET created_at=$2 WHERE channel_id=$1", [leader.channel.id, iso(Date.now() - LEADERSHIP_COOLDOWN_MS - 60_000)])
    expect(await take(candidate, leader.channel.id, leader.session.id)).toMatchObject({ mode: "takeover" })
  })

  it("limita los intentos por sesión dentro de la ventana", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    for (let i = 0; i < LEADERSHIP_ATTEMPTS_PER_SESSION; i++) await rejected(take(candidate, leader.channel.id, leader.session.id), 409, "leader_live")
    await silence(leader, silentMinutes)
    await rejected(take(candidate, leader.channel.id, leader.session.id), 429)
    expect(await events(leader.channel.id, "leadership_rejected")).toHaveLength(LEADERSHIP_ATTEMPTS_PER_SESSION)
  })

  it("el reclamo sigue disponible aunque otros agentes agoten el cupo del canal", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    const flooders = Math.ceil(LEADERSHIP_ATTEMPTS_PER_CHANNEL / LEADERSHIP_ATTEMPTS_PER_SESSION)
    for (let n = 0; n < flooders; n++) {
      const outsider = await register(`flood${n}`, other)
      for (let i = 0; i < LEADERSHIP_ATTEMPTS_PER_SESSION; i++) await take(outsider, leader.channel.id, candidate.session.id).catch(() => undefined)
    }
    expect(await take(leader, leader.channel.id, candidate.session.id, "Volví")).toMatchObject({ mode: "reclaim" })
  })

  it("las negativas a sesiones de otro proyecto no consumen el cupo del canal", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    const flooders = Math.ceil(LEADERSHIP_ATTEMPTS_PER_CHANNEL / LEADERSHIP_ATTEMPTS_PER_SESSION)
    for (let n = 0; n < flooders; n++) {
      const outsider = await register(`flood${n}`, other)
      for (let i = 0; i < LEADERSHIP_ATTEMPTS_PER_SESSION; i++) await rejected(take(outsider, leader.channel.id, leader.session.id), 403, "project_mismatch")
    }
    expect(await take(candidate, leader.channel.id, leader.session.id)).toMatchObject({ mode: "takeover" })
  })
})

describe("multi-canal y expulsión", () => {
  it("un líder conserva varios canales; el flujo de un solo canal no cambia", async () => {
    const leader = await register("leader"), member = await register("member")
    const task = await call(leader, "chat_create_channel", { task_key: "tarea", name: "Tarea" })
    const taskChannel = task.channel.id as string
    expect((await channel(leader.channel.id)).leader_id).toBe(leader.session.id)
    expect((await channel(taskChannel)).leader_id).toBe(leader.session.id)
    expect(await thread(member, member.channel.id)).toMatchObject({ author_id: member.session.id })
    expect(await thread(leader, leader.channel.id)).toMatchObject({ author_id: leader.session.id })
    expect(await thread(leader, taskChannel)).toMatchObject({ author_id: leader.session.id })
    await silence(leader, silentMinutes)
    await take(member, leader.channel.id, leader.session.id)
    expect((await channel(taskChannel)).leader_id).toBe(leader.session.id)
    expect(await thread(leader, taskChannel)).toMatchObject({ author_id: leader.session.id })
    await rejected(thread(leader, leader.channel.id), 400)
  })

  it("el nuevo líder no puede expulsar al desplazado para quitarle el reclamo", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    await rejected(call(candidate, "chat_kick", { channel_id: leader.channel.id, participant_id: leader.session.id, reason: "fuera" }), 403)
    expect((await db.query("SELECT removed_at FROM chat_sessions WHERE id=$1", [leader.session.id]))[0]!.removed_at).toBeNull()
    expect(await take(leader, leader.channel.id, candidate.session.id, "Volví")).toMatchObject({ mode: "reclaim" })
  })

  it("un líder no puede expulsar a un miembro que lidera otro canal; la persona sí", async () => {
    const lead = await register("lead"), member = await register("member")
    const sideLeader = await register("side", worktree("side"))
    expect(sideLeader.channel.id).not.toBe(lead.channel.id)
    await silence(sideLeader, silentMinutes)
    await take(member, sideLeader.channel.id, sideLeader.session.id)
    await rejected(call(lead, "chat_kick", { channel_id: lead.channel.id, participant_id: member.session.id, reason: "fuera" }), 403)
    expect((await channel(sideLeader.channel.id)).leader_id).toBe(member.session.id)
    await ops.chat.kick({ channel_id: lead.channel.id, participant_id: member.session.id, reason: "orden de la persona" }, { user_id: "owner" })
    expect((await channel(sideLeader.channel.id)).leader_id).toBeNull()
  })

  it("un líder sigue expulsando a un miembro común de su canal", async () => {
    const leader = await register("leader"), member = await register("member")
    const result = await call(leader, "chat_kick", { channel_id: leader.channel.id, participant_id: member.session.id, reason: "fuera" })
    expect(result.session.removed_at).toBeTruthy()
  })
})

describe("la persona prevalece", () => {
  it("la designación desde la UI anula el derecho de reclamo y queda auditada", async () => {
    const leader = await register("leader"), candidate = await register("candidate"), chosen = await register("chosen")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    await ops.chat.designateCoordinator({ channel_id: leader.channel.id, participant_id: chosen.session.id, expected_leader_id: candidate.session.id }, "owner")
    expect(await channel(leader.channel.id)).toMatchObject({ leader_id: chosen.session.id, displaced_leader_id: null })
    expect((await events(leader.channel.id, "leadership_designated"))[0]).toMatchObject({ actor_user_id: "owner", target_session_id: chosen.session.id })
    await rejected(take(leader, leader.channel.id, chosen.session.id, "Volví"), 409, "cooldown")
    expect((await channel(leader.channel.id)).leader_id).toBe(chosen.session.id)
  })

  it("la persona puede expulsar al desplazado y eso libera el reclamo", async () => {
    const leader = await register("leader"), candidate = await register("candidate")
    await silence(leader, silentMinutes)
    await take(candidate, leader.channel.id, leader.session.id)
    await ops.chat.kick({ channel_id: leader.channel.id, participant_id: leader.session.id, reason: "orden de la persona" }, { user_id: "owner" })
    expect(await channel(leader.channel.id)).toMatchObject({ leader_id: candidate.session.id, displaced_leader_id: null })
  })

  it("ninguna herramienta MCP designa coordinador", async () => {
    const leader = await register("leader"), member = await register("member")
    await rejected(call(member, "chat_designate_coordinator", { channel_id: leader.channel.id, participant_id: member.session.id, expected_leader_id: leader.session.id }), 404)
  })
})
