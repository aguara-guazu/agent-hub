import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
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
import { chatDefinitions, chatFolder } from "../src/local-chat.js"
import { LocalChatRuntime } from "../src/local-chat-runtime.js"
import { SESSION_LEASE_MS } from "../src/channel-authority.js"
import { canReadChannel, READ_GRANT_LIVENESS_GRACE_MS, READ_GRANT_MAX_TTL_MS, READ_REQUEST_PENDING_TTL_MS, validateGrantPhrase } from "../src/chat-read-access.js"
import { registerMemory } from "../src/routes.js"
import type { AgentContext } from "../src/agents.js"
import { existingChannel } from "./helpers/chat-channel.js"

let root: string, dir: string, other: string, db: MemoryDatabase, ops: MemoryOperations, beta: string

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const repo = (path: string) => {
  execFileSync("mkdir", ["-p", path])
  git(path, "init", "-q", "-b", "main")
  git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "seed")
}
const worktree = (name: string) => { const path = join(dir, name); git(dir, "worktree", "add", "-qb", name, path); return path }
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-read-access-"))
  dir = join(root, "alpha"); other = join(root, "beta")
  repo(dir); repo(other)
  db = new MemoryDatabase(join(root, "memory.sqlite")); await db.migrate()
  ops = new MemoryOperations(new MemoryStore(db, root), new MemoryAI(async () => defaultAI, new Vault(root)))
  await ops.call("create_entity", { kind: "project", title: "Alpha", data: { folders: [dir] } })
  beta = (await ops.call("create_entity", { kind: "project", title: "Beta", data: { folders: [other] } })).id
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
async function rejected(promise: Promise<unknown>, status: number, code?: string) {
  await expect(promise).rejects.toMatchObject({ statusCode: status, ...(code ? { code } : {}) })
}
const thread = async (who: Agent, title = "Tema") =>
  (await call(who, "chat_send", { channel_id: who.channel.id, title, text: `mensaje de ${who.name}`, mentions: [], request_id: randomUUID() })).thread_id as string
const reply = (who: Agent, threadId: string) => call(who, "chat_send", { thread_id: threadId, text: "respuesta", mentions: [], request_id: randomUUID() })
const events = (kind: string) => db.query("SELECT * FROM chat_authority_events WHERE kind=$1 ORDER BY seq", [kind])
const phrase = "Confirmo que nick-member puede ver los canales del proyecto Beta"

/** Alpha: channel of `leader` with `member`, plus a side channel; Beta: channel of `outsider`. Each channel has one thread. */
async function world() {
  const leader = await register("leader"), member = await register("member")
  const side = await register("side", worktree("side")), outsider = await register("outsider", other)
  return { leader, member, side, outsider, sideThread: await thread(side), betaThread: await thread(outsider) }
}
async function granted(w: Awaited<ReturnType<typeof world>>) {
  const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "Necesito ver la API de Beta" })
  await call(w.leader, "chat_read_elevate", { request_id: request.request_id })
  const result = await ops.chat.confirmReadRequest(request.request_id, phrase, "owner")
  return { requestId: request.request_id as string, grantId: result.grant.id as string }
}

describe("lectura dentro del proyecto", () => {
  it("un agente lee otro canal de su proyecto pero no escribe ahí", async () => {
    const w = await world()
    expect((await call(w.member, "chat_threads")).items.map((t: any) => t.id)).toContain(w.sideThread)
    expect((await call(w.member, "chat_read", { thread_id: w.sideThread, unread_only: false })).items).toHaveLength(1)
    await rejected(reply(w.member, w.sideThread), 403)
    const interest = await call(w.member, "chat_read_interest", { channel_id: w.side.channel.id, reason: "Quiero seguir ese canal" })
    expect(interest).toMatchObject({ readable: true, writable: false, leader_id: w.leader.session.id, notified: true })
    expect((await events("read_interest"))[0]).toMatchObject({ actor_session_id: w.member.session.id, target_session_id: w.leader.session.id })
  })

  it("no lee canales, hilos ni agentes de otro proyecto sin permiso", async () => {
    const w = await world()
    await rejected(call(w.member, "chat_read", { thread_id: w.betaThread, unread_only: false }), 403)
    expect((await call(w.member, "chat_threads")).items.map((t: any) => t.id)).not.toContain(w.betaThread)
    expect((await call(w.member, "chat_threads", { channel_id: w.outsider.channel.id })).items).toHaveLength(0)
    expect((await call(w.member, "chat_channels")).items.map((c: any) => c.id)).not.toContain(w.outsider.channel.id)
    expect((await call(w.member, "chat_agents")).items.map((s: any) => s.id)).not.toContain(w.outsider.session.id)
    await rejected(call(w.member, "chat_read_interest", { channel_id: w.outsider.channel.id, reason: "x" }), 403)
  })

  it("una sesión sin proyecto sólo lee su propio canal", async () => {
    const w = await world()
    const loose = join(root, "loose"); repo(loose)
    const stray = await register("stray", loose)
    await rejected(call(stray, "chat_read", { thread_id: w.sideThread, unread_only: false }), 403)
    expect((await call(stray, "chat_threads", { unassigned: true })).items).toHaveLength(0)
  })
})

describe("permiso entre proyectos", () => {
  it("pedido, elevación por el líder, confirmación de la persona y lectura sin escritura", async () => {
    const w = await world()
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "Necesito ver la API de Beta" })
    expect(request).toMatchObject({ state: "pending_leader", leader_id: w.leader.session.id, notified: true })
    expect((await db.query("SELECT 1 FROM chat_status_notices WHERE recipient_id=$1 AND cause='read_request'", [w.leader.session.id])).length).toBe(1)
    await rejected(ops.chat.confirmReadRequest(request.request_id, phrase, "owner"), 409, "request_not_pending")
    await rejected(call(w.member, "chat_read_elevate", { request_id: request.request_id }), 403)
    await rejected(call(w.outsider, "chat_read_elevate", { request_id: request.request_id }), 403)
    expect(await call(w.leader, "chat_read_elevate", { request_id: request.request_id, note: "Lo necesita" })).toMatchObject({ state: "pending_person" })
    await rejected(call(w.leader, "chat_read_elevate", { request_id: request.request_id }), 409)
    const result = await ops.chat.confirmReadRequest(request.request_id, phrase, "owner")
    expect(result.grant).toMatchObject({ project_id: beta, session_id: w.member.session.id })
    expect(Date.parse(result.grant.expires_at) - Date.now()).toBeLessThanOrEqual(READ_GRANT_MAX_TTL_MS)
    expect((await events("read_granted"))[0]).toMatchObject({ actor_user_id: "owner", actor_session_id: null, target_session_id: w.member.session.id, reason: phrase })
    expect((await call(w.member, "chat_read", { thread_id: w.betaThread, unread_only: false })).items).toHaveLength(1)
    expect((await call(w.member, "chat_threads")).items.map((t: any) => t.id)).toContain(w.betaThread)
    await rejected(reply(w.member, w.betaThread), 403)
    await rejected(ops.chat.confirmReadRequest(request.request_id, phrase, "owner"), 409, "request_not_pending")
    expect(await db.query("SELECT * FROM chat_read_grants")).toHaveLength(1)
  })

  it("valida la frase: estructura, proyecto de destino y solicitante", async () => {
    const w = await world()
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "x" })
    await call(w.leader, "chat_read_elevate", { request_id: request.request_id })
    await rejected(ops.chat.confirmReadRequest(request.request_id, "sí, dale", "owner"), 400, "phrase_structure")
    await rejected(ops.chat.confirmReadRequest(request.request_id, "Confirmo que nick-member puede ver los canales del proyecto Alpha", "owner"), 400, "phrase_target")
    await rejected(ops.chat.confirmReadRequest(request.request_id, "Confirmo que nick-leader puede ver los canales del proyecto Beta", "owner"), 400, "phrase_requester")
    expect(await db.query("SELECT * FROM chat_read_grants")).toHaveLength(0)
    expect(await ops.chat.confirmReadRequest(request.request_id, "Confirmo que el agente del proyecto «Alpha» puede ver los canales del proyecto «Beta».", "owner"))
      .toMatchObject({ state: "granted" })
  })

  it("normaliza la frase sin aceptar que el proyecto de destino sustituya al solicitante", () => {
    expect(validateGrantPhrase("CONFIRMO QUE «nick-member» puede leer los canales de proyecto «Beta»!", { target: "Beta", nickname: "nick-member", requesterProject: "Alpha" }).ok).toBe(true)
    expect(validateGrantPhrase("I confirm that nick-member can read the channels of project Beta", { target: "Beta", nickname: "nick-member", requesterProject: "Alpha" }).ok).toBe(true)
    expect(validateGrantPhrase("Confirmo que el agente de Beta puede ver los canales del proyecto Beta", { target: "Beta", nickname: "nick-member", requesterProject: "Beta" }))
      .toMatchObject({ ok: false, code: "requester" })
    expect(validateGrantPhrase("Confirmo que nick-memberx puede ver los canales del proyecto Beta", { target: "Beta", nickname: "nick-member", requesterProject: null }))
      .toMatchObject({ ok: false, code: "requester" })
  })

  it("la persona rechaza y el agente sigue sin leer", async () => {
    const w = await world()
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "x" })
    await call(w.leader, "chat_read_elevate", { request_id: request.request_id })
    expect(await ops.chat.rejectReadRequest(request.request_id, "owner", "No hace falta")).toMatchObject({ state: "rejected" })
    expect((await events("read_rejected"))[0]).toMatchObject({ actor_user_id: "owner" })
    await rejected(call(w.member, "chat_read", { thread_id: w.betaThread, unread_only: false }), 403)
    await rejected(ops.chat.confirmReadRequest(request.request_id, phrase, "owner"), 409, "request_not_pending")
  })

  it("un líder reemplazado después del pedido ya no puede elevarlo", async () => {
    const w = await world()
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "x" })
    const at = Date.now() - 30 * 60_000
    await db.query("UPDATE chat_sessions SET last_seen_at=$2,lease_until=$3 WHERE id=$1", [w.leader.session.id, iso(at), iso(at + SESSION_LEASE_MS)])
    const third = await register("third")
    await call(third, "chat_take_leadership", { channel_id: w.leader.channel.id, expected_leader_id: w.leader.session.id, reason: "silencio" })
    await rejected(call(w.leader, "chat_read_elevate", { request_id: request.request_id }), 403)
    expect(await call(third, "chat_read_elevate", { request_id: request.request_id })).toMatchObject({ state: "pending_person" })
  })

  it("ninguna herramienta MCP confirma, rechaza ni revoca permisos", async () => {
    const w = await world()
    const names = Object.keys(chatDefinitions)
    expect(names.filter(name => /confirm|grant|reject|revoke|designate/.test(name))).toEqual([])
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "x" })
    await call(w.leader, "chat_read_elevate", { request_id: request.request_id })
    for (const operation of ["chat_read_confirm", "chat_read_grant", "confirm_read_request"])
      await expect(call(w.leader, operation, { request_id: request.request_id, phrase })).rejects.toBeTruthy()
    expect(await db.query("SELECT * FROM chat_read_grants")).toHaveLength(0)
  })
})

describe("caducidad y revocación", () => {
  it("vence por tope de vida", async () => {
    const w = await world(), { grantId } = await granted(w)
    await db.query("UPDATE chat_read_grants SET expires_at=$2 WHERE id=$1", [grantId, iso(Date.now() - 1000)])
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(false)
    expect(await ops.chat.sweepReadAccess()).toMatchObject({ revoked: 1 })
    expect((await events("read_revoked"))[0]).toMatchObject({ reason: "max_ttl", target_session_id: w.member.session.id })
    expect((await events("read_revoked"))[0]!.evidence).toMatchObject({ grant_id: grantId, max_ttl_ms: READ_GRANT_MAX_TTL_MS })
  })

  it("vence al cerrarse la sesión", async () => {
    const w = await world(), { grantId } = await granted(w)
    await db.query("UPDATE chat_sessions SET closed_at=now(),lease_until=NULL WHERE id=$1", [w.member.session.id])
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(false)
    await ops.chat.sweepReadAccess()
    expect((await db.query("SELECT revoke_reason FROM chat_read_grants WHERE id=$1", [grantId]))[0]!.revoke_reason).toBe("session_closed")
  })

  it("vence al perder liveness", async () => {
    const w = await world(), { grantId } = await granted(w)
    await db.query("UPDATE chat_sessions SET lease_until=$2 WHERE id=$1", [w.member.session.id, iso(Date.now() - READ_GRANT_LIVENESS_GRACE_MS - 60_000)])
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(false)
    await ops.chat.sweepReadAccess()
    const [event] = await events("read_revoked")
    expect(event).toMatchObject({ reason: "liveness_lost" })
    expect(event!.evidence).toMatchObject({ grant_id: grantId, threshold_ms: READ_GRANT_LIVENESS_GRACE_MS })
  })

  it("vence cuando el agente completa su trabajo", async () => {
    const w = await world(), { grantId } = await granted(w)
    const own = await thread(w.member, "Trabajo")
    await call(w.member, "chat_work_update", { thread_id: own, work_id: "w1", request_id: "s1", expected_version: 0, event: "started", summary: "empiezo" })
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(true)
    const report = await reply(w.member, own)
    await call(w.member, "chat_work_update", { thread_id: own, work_id: "w1", request_id: "s2", expected_version: 1, event: "completed", summary: "listo", report_message_id: report.id })
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(false)
    await ops.chat.sweepReadAccess()
    expect((await db.query("SELECT revoke_reason FROM chat_read_grants WHERE id=$1", [grantId]))[0]!.revoke_reason).toBe("work_completed")
  })

  it("no lo recupera abriendo otro trabajo después de completar uno", async () => {
    const w = await world(), { grantId } = await granted(w)
    const own = await thread(w.member, "Trabajo")
    await call(w.member, "chat_work_update", { thread_id: own, work_id: "w1", request_id: "s1", expected_version: 0, event: "started", summary: "empiezo" })
    const report = await reply(w.member, own)
    await call(w.member, "chat_work_update", { thread_id: own, work_id: "w1", request_id: "s2", expected_version: 1, event: "completed", summary: "listo", report_message_id: report.id })
    await call(w.member, "chat_work_update", { thread_id: own, work_id: "w2", request_id: "s3", expected_version: 0, event: "started", summary: "otra cosa" })
    expect(await canReadChannel(db, w.member.session.id, w.outsider.channel.id)).toBe(false)
    await ops.chat.sweepReadAccess()
    expect((await db.query("SELECT revoke_reason FROM chat_read_grants WHERE id=$1", [grantId]))[0]!.revoke_reason).toBe("work_completed")
  })

  it("el ciclo del Hub revoca aunque falle otro paso del mismo ciclo", async () => {
    const w = await world(), { grantId } = await granted(w)
    await db.query("UPDATE chat_sessions SET closed_at=now(),lease_until=NULL WHERE id=$1", [w.member.session.id])
    vi.spyOn(ops.chat, "processTurnAlerts").mockRejectedValue(new Error("fallo de otro paso"))
    const runtime = new LocalChatRuntime(ops.chat, async () => undefined, () => true, async () => undefined)
    await expect(runtime.tick()).rejects.toThrow("fallo de otro paso")
    expect((await db.query("SELECT revoke_reason FROM chat_read_grants WHERE id=$1", [grantId]))[0]!.revoke_reason).toBe("session_closed")
  })

  it("la persona revoca y queda auditado", async () => {
    const w = await world(), { grantId } = await granted(w)
    expect(await ops.chat.revokeReadGrant(grantId, "owner", "Ya no")).toMatchObject({ revoked: true })
    await rejected(call(w.member, "chat_read", { thread_id: w.betaThread, unread_only: false }), 403)
    expect((await events("read_revoked"))[0]).toMatchObject({ actor_user_id: "owner", reason: "Ya no" })
    await rejected(ops.chat.revokeReadGrant(grantId, "owner"), 404)
  })

  it("cancela pedidos sin respuesta pasado su plazo", async () => {
    const w = await world()
    const request = await call(w.member, "chat_read_request", { project_id: beta, reason: "x" })
    await db.query("UPDATE chat_read_requests SET created_at=$2 WHERE id=$1", [request.request_id, iso(Date.now() - READ_REQUEST_PENDING_TTL_MS - 60_000)])
    expect(await ops.chat.sweepReadAccess()).toMatchObject({ cancelled: 1 })
    expect((await events("read_cancelled"))[0]).toMatchObject({ reason: "pending_ttl" })
  })
})

describe("rutas de la persona", () => {
  it("confirmar, rechazar, revocar y listar exigen la autorización de la persona", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hub-read-routes-"))
    const app = Fastify()
    const { service } = registerMemory(app, { directory, baseUrl: "http://localhost", worker: false, authorize: async request => {
      if (request.headers.authorization !== "Bearer owner") throw Object.assign(new Error("Owner required"), { statusCode: 401 })
      return { id: "owner" }
    } })
    const confirm = vi.fn(async () => ({ state: "granted" })), reject = vi.fn(async () => ({ state: "rejected" }))
    const revoke = vi.fn(async () => ({ revoked: true })), list = vi.fn(async () => ({ items: [] }))
    vi.spyOn(service, "get").mockResolvedValue({ operations: { chat: { confirmReadRequest: confirm, rejectReadRequest: reject, revokeReadGrant: revoke, readRequests: list, readGrants: list } } } as any)
    const id = "11111111-1111-4111-8111-111111111111"
    const routes = [
      { method: "POST" as const, url: `/api/memory/chat/read-requests/${id}/confirm`, payload: { phrase } },
      { method: "POST" as const, url: `/api/memory/chat/read-requests/${id}/reject`, payload: {} },
      { method: "POST" as const, url: `/api/memory/chat/read-grants/${id}/revoke`, payload: {} },
      { method: "GET" as const, url: "/api/memory/chat/read-requests" },
      { method: "GET" as const, url: "/api/memory/chat/read-grants" },
    ]
    try {
      for (const route of routes) {
        for (const authorization of [undefined, "Bearer agent"]) {
          const response = await app.inject({ ...route, ...(authorization ? { headers: { authorization } } : {}) })
          expect(response.statusCode).toBe(401)
        }
      }
      expect(confirm).not.toHaveBeenCalled(); expect(reject).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled()
      const accepted = await app.inject({ ...routes[0]!, headers: { authorization: "Bearer owner" } })
      expect(accepted.statusCode).toBe(200)
      expect(confirm).toHaveBeenCalledWith(id, phrase, "owner")
      const tooLong = await app.inject({ ...routes[0]!, payload: { phrase: "x".repeat(501) }, headers: { authorization: "Bearer owner" } })
      expect(tooLong.statusCode).toBe(422)
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
