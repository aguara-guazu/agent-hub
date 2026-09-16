/**
 * Skills de fábrica: las que la app distribuye a todos los clientes por la política por defecto.
 *
 * Cada una guarda en settings el id de la fila creada (`<clave>_id`) y el hash de la última
 * versión distribuida (`<clave>_hash`). Se actualiza con la app sólo mientras el contenido
 * guardado siga siendo el distribuido: una copia editada por la persona se conserva tal cual
 * y una borrada no vuelve a crearse.
 */
import { skillContentHash } from '../hashing.js'
import type { Store } from '../store.js'
import type { User } from '../types.js'

export interface FactorySkill {
  slug: string
  display_name: string
  description: string
  body: string
}

export type FactorySkillOutcome = 'created' | 'updated' | 'unchanged' | 'deleted'

export function applyFactorySkill(store: Store, owner: User, key: string, skill: FactorySkill): FactorySkillOutcome {
  const skillId = store.setting(`${key}_id`)
  const existing = skillId ? store.skill(skillId) : undefined
  if (skillId && !existing) return 'deleted'
  const body = skill.body
  const hash = skillContentHash(skill.display_name, skill.description, body)
  if (!existing) {
    let slug = skill.slug
    for (let suffix = 2; store.skillBySlug(owner.id, slug); suffix++) slug = `${skill.slug}-${suffix}`
    const created = store.insertSkill({ user_id: owner.id, slug, display_name: skill.display_name, description: skill.description, body, content_hash: hash })
    store.setSetting(`${key}_id`, created.id)
    store.setSetting(`${key}_hash`, hash)
    return 'created'
  }
  const shipped = store.setting(`${key}_hash`)
  if (existing.content_hash === shipped && existing.content_hash !== hash) {
    store.updateSkill(existing.id, { display_name: skill.display_name, description: skill.description, body, version: existing.version + 1, content_hash: hash })
    store.setSetting(`${key}_hash`, hash)
    return 'updated'
  }
  return 'unchanged'
}
