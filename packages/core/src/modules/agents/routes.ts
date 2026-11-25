import { type FastifyInstance, type FastifyRequest } from 'fastify'
import { record as auditRecord } from '../../audit/ledger.js'
import { serializeAgent, serializeMachine } from '../../serialize_catalog.js'
import { generateDaemonToken } from '../../security.js'
import type { AgentInstance, Machine, User } from '../../types.js'
import { CLI_KINDS as SHARED_CLI_KINDS, type CliKind } from '@agenthub/shared'
import { HttpError, isAdmin, isObject, requireObject, requireString, optionalString, type CatalogContext } from '../http.js'

const CLI_KINDS: readonly string[] = SHARED_CLI_KINDS
export function registerAgentsRoutes(fastify: FastifyInstance, { store, currentUser, notifyAfterCommit, currentDaemon, ownedAgent }: CatalogContext & {
  currentDaemon(request: FastifyRequest): { machine: Machine; user: User }
  ownedAgent(user: User, agentId: string): AgentInstance
}) {
  function ownedMachine(user: User, machineId: string): Machine {
    const machine = store.machine(machineId)
    if (!machine || machine.user_id !== user.id) throw new HttpError(404, 'maquina inexistente')
    return machine
  }

  // ============================================================ machines
  function machineForWrite(user: User, machineId: string): Machine {
    if (!isAdmin(user)) return ownedMachine(user, machineId)
    const machine = store.machine(machineId)
    if (!machine) throw new HttpError(404, 'maquina inexistente')
    const owner = store.user(machine.user_id)
    if (!owner || owner.organization_id !== user.organization_id) throw new HttpError(404, 'maquina inexistente')
    return machine
  }

  fastify.post('/api/machines/enroll', async (request) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    const hostname = requireString(body, 'hostname')
    const os = optionalString(body, 'os')
    const daemonVersion = optionalString(body, 'daemon_version')
    const at = new Date().toISOString()

    let machine = store.machineByHostname(user.id, hostname)
    let revoked = 0
    if (!machine) {
      machine = store.insertMachine({ user_id: user.id, hostname, os, daemon_version: daemonVersion })
    } else {
      store.updateMachine(machine.id, { os: os || machine.os, daemon_version: daemonVersion || machine.daemon_version })
      revoked = store.revokeTokensOfMachine(machine.id, at)
      machine = store.machine(machine.id)!
    }
    const [raw, digest] = generateDaemonToken()
    store.insertToken({ user_id: user.id, machine_id: machine.id, name: `daemon@${machine.hostname}`, token_hash: digest })

    auditRecord(store, user.organization_id, user, 'machine.enroll', 'machine', machine.id, {
      hostname: machine.hostname,
      os: machine.os,
      revoked_tokens: revoked,
    })
    return {
      machine: serializeMachine(machine, user, store.agentsOfMachine(machine.id)),
      token: raw,
    }
  })

  fastify.get('/api/machines', async (request) => {
    const user = await currentUser(request)
    if (isAdmin(user)) {
      return store.machinesOfOrg(user.organization_id).map(({ machine, owner }) =>
        serializeMachine(machine, owner, store.agentsOfMachine(machine.id)),
      )
    }
    return store.machinesOfUser(user.id).map((machine) => serializeMachine(machine, user, store.agentsOfMachine(machine.id)))
  })

  fastify.delete('/api/machines/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const machine = machineForWrite(user, id)
    store.revokeTokensOfMachine(machine.id, new Date().toISOString())
    auditRecord(store, user.organization_id, user, 'machine.delete', 'machine', machine.id, { hostname: machine.hostname })
    store.deleteMachine(machine.id)
    return reply.code(204).send()
  })

  fastify.post('/api/machines/:id/agents', async (request) => {
    const daemon = currentDaemon(request)
    const { id } = request.params as { id: string }
    if (id !== daemon.machine.id) throw new HttpError(403, 'el token no corresponde a esa maquina')
    const body = requireObject(request.body)
    const agents = Array.isArray(body.agents) ? body.agents : []
    const existing = new Map(store.agentsOfMachine(daemon.machine.id).map((a) => [a.cli_kind, a]))
    for (const item of agents) {
      if (!isObject(item)) continue
      const cliKind = String(item.cli_kind ?? '')
      if (!CLI_KINDS.includes(cliKind)) throw new HttpError(422, `cli_kind invalido: ${cliKind}`)
      const kind = cliKind as CliKind
      const cliVersion = typeof item.cli_version === 'string' ? item.cli_version : ''
      const configPath = typeof item.config_path === 'string' ? item.config_path : ''
      const found = existing.get(kind)
      if (!found) {
        const created = store.insertAgent({ machine_id: daemon.machine.id, cli_kind: kind, cli_version: cliVersion, config_path: configPath })
        existing.set(kind, created)
        auditRecord(store, daemon.user.organization_id, `daemon@${daemon.machine.hostname}`, 'agent.detected', 'agent_instance', created.id, {
          cli_kind: cliKind,
          cli_version: cliVersion,
        })
      } else {
        store.updateAgent(found.id, {
          cli_version: cliVersion || found.cli_version,
          config_path: configPath || found.config_path,
        })
      }
    }
    return store.agentsOfMachine(daemon.machine.id).map((a) => serializeAgent(a, daemon.machine))
  })

  fastify.patch('/api/machines/agents/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const agent = ownedAgent(user, id)
    const machine = store.machine(agent.machine_id)!
    const body = requireObject(request.body)
    if (typeof body.enabled === 'boolean' && body.enabled !== agent.enabled) {
      store.updateAgent(agent.id, { enabled: body.enabled })
      auditRecord(store, user.organization_id, user, body.enabled ? 'agent.enabled' : 'agent.disabled', 'agent_instance', agent.id, {
        cli_kind: agent.cli_kind,
        hostname: machine.hostname,
      })
      notifyAfterCommit('agent', agent.id)
    }
    return serializeAgent(store.agent(agent.id)!, machine)
  })
}
