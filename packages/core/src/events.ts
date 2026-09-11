/**
 * Bus de invalidación de snapshots. Espeja la semántica de
 * `backend/agenthub/modules/sync/events.py` en un solo proceso.
 *
 * Quien escribe política publica una invalidación DESPUÉS de confirmar la transacción;
 * los pedidos de `GET /sync/snapshot` que esperan se despiertan y recalculan. El techo
 * de tiempo sigue existiendo, pero pasa a ser el límite y no el ritmo.
 *
 * Limitación honesta: sirve para un solo proceso. Con varias réplicas haría falta un
 * transporte compartido (LISTEN/NOTIFY o una cola); por eso es reemplazable.
 */
import type { Store } from './store.js'

export type Scope = 'agent' | 'user'

export function key(scope: Scope, ident: string): string {
  return `${scope}:${ident}`
}

/** Un pedido en espera y las claves que lo despiertan. */
export class Subscription {
  private resolvers: (() => void)[] = []
  private fired = false

  constructor(readonly keys: ReadonlySet<string>) {}

  notify(): void {
    this.fired = true
    const pending = this.resolvers
    this.resolvers = []
    for (const resolve of pending) resolve()
  }

  clear(): void {
    this.fired = false
  }

  /** Espera hasta la próxima invalidación o hasta que venza `timeoutMs`. */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.fired) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (changed: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(changed)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.resolvers.push(() => finish(true))
    })
  }
}

export class InvalidationBus {
  private byKey = new Map<string, Set<Subscription>>()

  subscribe(keys: Iterable<string>): Subscription {
    const subscription = new Subscription(new Set(keys))
    for (const k of subscription.keys) {
      const holders = this.byKey.get(k) ?? new Set<Subscription>()
      holders.add(subscription)
      this.byKey.set(k, holders)
    }
    return subscription
  }

  unsubscribe(subscription: Subscription): void {
    for (const k of subscription.keys) {
      const holders = this.byKey.get(k)
      if (!holders) continue
      holders.delete(subscription)
      if (holders.size === 0) this.byKey.delete(k)
    }
  }

  publish(keys: Iterable<string>): number {
    const targets = new Set<Subscription>()
    for (const k of keys) for (const s of this.byKey.get(k) ?? []) targets.add(s)
    for (const s of targets) s.notify()
    return targets.size
  }

  subscriberCount(): number {
    const all = new Set<Subscription>()
    for (const holders of this.byKey.values()) for (const s of holders) all.add(s)
    return all.size
  }
}

export function agentScopeKeys(store: Store, agentId: string): string[] {
  const keys = new Set<string>([key('agent', agentId)])
  const agent = store.agent(agentId)
  if (agent) {
    const machine = store.machine(agent.machine_id)
    if (machine) keys.add(key('user', machine.user_id))
  }
  return [...keys].sort()
}

export function affectedAgentIds(store: Store, scope: Scope, scopeId: string): string[] {
  if (scope === 'agent') return [scopeId]
  return store.agentIdsOfUser(scopeId).sort()
}

/** Avisa que cambió la política de ese alcance. Llamar DESPUÉS del commit. */
export function publishPolicyChange(bus: InvalidationBus, store: Store, scope: Scope, scopeId: string): string[] {
  const agentIds = affectedAgentIds(store, scope, scopeId)
  const keys = agentIds.map((id) => key('agent', id))
  keys.push(key(scope, scopeId))
  bus.publish(keys)
  return agentIds
}
