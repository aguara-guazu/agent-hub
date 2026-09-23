/**
 * Cambios que un cliente sin recarga en caliente todavía no cargó.
 *
 * Un cliente como Claude Desktop lista las herramientas una vez, al abrirse; si el
 * snapshot cambia después, sigue trabajando con la lista vieja hasta reiniciarse. El
 * gateway reporta el hash que listó (`last_listed_hash`) y el core guarda cada snapshot
 * por hash, así que se puede decir exactamente qué skills y servers difieren entre lo
 * que la app vio y lo vigente. Con eso el escritorio ofrece el reinicio con motivo.
 */
import type { PolicySnapshot } from '@agenthub/shared'

export interface PendingChanges {
  skills: {
    added: string[]
    removed: string[]
    changed: string[]
    /** Subconjunto de `added` y `changed` que entró solo desde la biblioteca de skills. */
    auto: string[]
  }
  servers: { added: string[]; removed: string[] }
}

export interface PendingRestart {
  agent_id: string
  cli_kind: string
  machine_hostname: string
  snapshot_hash: string
  listed_hash: string
  /** `null` cuando el snapshot que la app listó ya no está guardado: cambió algo, sin detalle. */
  changes: PendingChanges | null
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

export function diffSnapshots(previous: PolicySnapshot, current: PolicySnapshot): PendingChanges {
  const before = new Map(previous.skills.map((skill) => [skill.slug, skill]))
  const after = new Map(current.skills.map((skill) => [skill.slug, skill]))
  const added: string[] = []
  const changed: string[] = []
  for (const [slug, skill] of after) {
    const old = before.get(slug)
    if (old === undefined) added.push(slug)
    else if (old.content_hash !== skill.content_hash || old.description !== skill.description) changed.push(slug)
  }
  const removed = [...before.keys()].filter((slug) => !after.has(slug))
  const auto = [...added, ...changed].filter((slug) => after.get(slug)?.source === 'external')

  const serversBefore = new Set(previous.servers.map((server) => server.slug))
  const serversAfter = new Set(current.servers.map((server) => server.slug))
  return {
    skills: { added: sorted(added), removed: sorted(removed), changed: sorted(changed), auto: sorted(auto) },
    servers: {
      added: sorted([...serversAfter].filter((slug) => !serversBefore.has(slug))),
      removed: sorted([...serversBefore].filter((slug) => !serversAfter.has(slug))),
    },
  }
}

export function hasChanges(changes: PendingChanges): boolean {
  return (
    changes.skills.added.length + changes.skills.removed.length + changes.skills.changed.length +
    changes.servers.added.length + changes.servers.removed.length
  ) > 0
}
