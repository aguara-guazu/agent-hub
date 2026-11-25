import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Machine, User } from '../../types.js'
import { validateCatalogSlug } from '../../serialize.js'
import { record as auditRecord } from '../../audit/ledger.js'
import { isObject, optionalString, requireObject, withinRestoreWindow, type CatalogContext } from '../http.js'

export function registerExternalSkillSync(fastify: FastifyInstance, { store, currentDaemon, notifyAfterCommit }: Pick<CatalogContext, 'store' | 'notifyAfterCommit'> & {
  currentDaemon(request: FastifyRequest): { machine: Machine; user: User }
}) {
  /**
   * Lo que el daemon encontró en la biblioteca de skills de la máquina (`~/.agents/skills`).
   * Es una foto completa: lo que falta respecto al reporte anterior se da de baja, junto con
   * sus reglas. Una skill del hub con el mismo slug no se pisa: se informa como omitida.
   */
  fastify.put('/api/sync/external-skills', async (request) => {
    const daemon = currentDaemon(request)
    const body = requireObject(request.body)
    const reported = Array.isArray(body.skills) ? body.skills.filter(isObject) : []
    const user = daemon.user
    const machineId = daemon.machine.id
    const actor = `daemon@${daemon.machine.hostname}`
    const existing = new Map(store.externalSkillsOfMachine(user.id, machineId).map((skill) => [skill.slug, skill]))
    const seen = new Set<string>()
    const created: string[] = []
    const updated: string[] = []
    const removed: string[] = []
    const skipped: { slug: string; reason: string }[] = []

    for (const item of reported) {
      const rawSlug = typeof item.slug === 'string' ? item.slug : ''
      let slug: string
      try {
        slug = validateCatalogSlug(rawSlug)
      } catch (error) {
        skipped.push({ slug: rawSlug, reason: (error as Error).message })
        continue
      }
      if (seen.has(slug)) continue
      seen.add(slug)
      const displayName = optionalString(item, 'display_name') || slug
      const description = optionalString(item, 'description')
      const skillBody = optionalString(item, 'body')
      const treeHash = optionalString(item, 'tree_hash')
      const sourcePath = optionalString(item, 'source_path')
      const sourceRef = optionalString(item, 'source_ref')
      if (!treeHash || !sourcePath) {
        skipped.push({ slug, reason: 'faltan tree_hash o source_path' })
        continue
      }
      const current = existing.get(slug)
      if (current === undefined) {
        const other = store.skillBySlug(user.id, slug)
        if (other) {
          skipped.push({ slug, reason: other.source === 'hub' ? 'ya existe una skill del hub con ese slug' : 'ya la reporta otra máquina' })
          continue
        }
        const restorable = store.deletedSkillBySlug(user.id, slug)
        if (restorable && withinRestoreWindow(restorable.deleted_at)) {
          skipped.push({ slug, reason: 'hay una skill del hub borrada que todavía se puede restaurar' })
          continue
        }
        const row = store.insertSkill({
          user_id: user.id, slug, display_name: displayName, description, body: skillBody, content_hash: treeHash,
          source: 'external', source_path: sourcePath, source_ref: sourceRef, source_machine_id: machineId,
        })
        auditRecord(store, user.organization_id, actor, 'skill.imported', 'skill', row.id, { slug, source_path: sourcePath, source_ref: sourceRef })
        created.push(slug)
        continue
      }
      const changed =
        current.content_hash !== treeHash || current.display_name !== displayName || current.description !== description ||
        current.body !== skillBody || current.source_path !== sourcePath || current.source_ref !== sourceRef
      if (!changed) continue
      store.updateSkill(current.id, {
        display_name: displayName, description, body: skillBody, source_path: sourcePath, source_ref: sourceRef,
        ...(current.content_hash !== treeHash ? { content_hash: treeHash, version: current.version + 1 } : {}),
      })
      updated.push(slug)
    }

    for (const [slug, row] of existing) {
      if (seen.has(slug)) continue
      store.forgetResource('skill', [row.id])
      store.deleteSkill(row.id)
      auditRecord(store, user.organization_id, actor, 'skill.removed', 'skill', row.id, { slug, source_path: row.source_path })
      removed.push(slug)
    }

    if (created.length > 0 || updated.length > 0 || removed.length > 0) notifyAfterCommit('user', user.id)
    return { created, updated, removed, skipped }
  })
}
