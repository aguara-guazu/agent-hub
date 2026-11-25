import { type FastifyInstance } from 'fastify'
import { skillContentHash } from '../../hashing.js'
import { buildZip, collectFiles, ZipReadError } from "../../zip.js"
import { skillDraftFromZip, type SkillZipDraft } from "../../catalog/skill-import.js"
import { validateCatalogSlug } from '../../serialize.js'
import { serializeSkill } from '../../serialize_catalog.js'
import type { AccountSkillsReport, SkillRow, User } from '../../types.js'
import { renderSkillMd, SKILL_FILENAME } from '@agenthub/shared'
import { SKILL_ZIP_MAX_BYTES, type SkillZipImportExtras } from "@agenthub/shared"
import {
  HttpError,
  requireObject,
  rejectUnknown,
  requireString,
  optionalString,
  withinRestoreWindow,
  type CatalogContext,
} from '../http.js'

export function registerSkillsRoutes(fastify: FastifyInstance, { store, currentUser, notifyAfterCommit }: CatalogContext) {
  function skillOr404(user: User, skillId: string) {
    const skill = store.skill(skillId)
    if (!skill || skill.user_id !== user.id) throw new HttpError(404, 'la skill no existe')
    return skill
  }

  /**
   * Estado de una skill en la cuenta de claude.ai de cada Claude Desktop de la persona, según
   * la caché que el daemon reportó. `missing` es «no subida»; sin reporte no hay entrada.
   */
  function claudeAiStatus(user: User, skill: SkillRow) {
    return store.agentsOfUser(user.id)
      .filter(({ agent }) => agent.cli_kind === 'claude_desktop' && agent.account_skills !== null)
      .map(({ agent, machine }) => {
        const report = agent.account_skills as AccountSkillsReport
        const found = report.skills.find((item) => item.slug === skill.slug)
        return {
          agent_id: agent.id,
          machine_hostname: machine.hostname,
          checked_at: report.checked_at,
          status: found ? found.status : 'missing',
        }
      })
  }

  function skillView(user: User, skill: SkillRow) {
    return { ...serializeSkill(skill), claude_ai: claudeAiStatus(user, skill) }
  }

  /** Una skill externa se edita y se borra con `npx skills`; el hub sólo decide dónde se expone. */
  function rejectExternal(skill: SkillRow, verb: string): void {
    if (skill.source !== 'external') return
    throw new HttpError(409, `la skill ${skill.slug} viene de la biblioteca de skills (${skill.source_path}); ${verb} con npx skills, no desde el hub`)
  }

  fastify.get('/api/catalog/skills', async (request) => {
    const user = await currentUser(request)
    return store.skillsOfUser(user.id).map((skill) => skillView(user, skill))
  })

  fastify.get('/api/catalog/skills/:id/zip', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const skill = skillOr404(user, id)
    let files
    if (skill.source === 'external') {
      try {
        files = collectFiles(skill.source_path)
      } catch (error) {
        throw new HttpError(413, (error as Error).message)
      }
      if (files === null) throw new HttpError(409, `la carpeta de la skill ya no está en ${skill.source_path}`)
    } else {
      files = [{ name: SKILL_FILENAME, data: Buffer.from(renderSkillMd(skill), 'utf-8') }]
    }
    const archive = buildZip(files.map((file) => ({ name: `${skill.slug}/${file.name}`, data: file.data })))
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${skill.slug}.zip"`)
      .send(archive)
  })

  function createHubSkill(user: User, slug: string, displayName: string, description: string, skillBody: string): SkillRow {
    if (store.skillBySlug(user.id, slug)) throw new HttpError(409, `ya tenes una skill con el slug ${slug}`)
    const skill = store.insertSkill({
      user_id: user.id,
      slug,
      display_name: displayName,
      description,
      body: skillBody,
      content_hash: skillContentHash(displayName, description, skillBody),
    })
    notifyAfterCommit('user', user.id)
    return skill
  }

  fastify.post('/api/catalog/skills', async (request, reply) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['slug', 'display_name', 'description', 'body'])
    const slug = validateCatalogSlug(requireString(body, 'slug'))
    const displayName = requireString(body, 'display_name')
    const description = optionalString(body, 'description')
    const skillBody = optionalString(body, 'body')
    return reply.code(201).send(skillView(user, createHubSkill(user, slug, displayName, description, skillBody)))
  })

  // Parser binario solo en este ámbito: el resto de la API sigue aceptando únicamente JSON.
  void fastify.register(async (scope) => {
    scope.addContentTypeParser(["application/zip", "application/x-zip-compressed", "application/octet-stream"], { parseAs: "buffer" },
      (_request, body, done) => done(null, body))

    scope.post("/api/catalog/skills/import", { bodyLimit: SKILL_ZIP_MAX_BYTES }, async (request, reply) => {
      const user = await currentUser(request)
      const query = (request.query ?? {}) as Record<string, unknown>
      rejectUnknown(query, ["slug", "display_name"])
      const archive = request.body
      if (!Buffer.isBuffer(archive) || archive.length === 0) throw new HttpError(422, "el cuerpo debe ser un archivo ZIP")
      let draft: SkillZipDraft
      try {
        draft = skillDraftFromZip(archive)
      } catch (error) {
        if (error instanceof ZipReadError) throw new HttpError(error.status, error.message)
        throw error
      }
      const slug = validateCatalogSlug(optionalString(query, "slug") || draft.name)
      const displayName = optionalString(query, "display_name").trim() || draft.displayName
      const skill = createHubSkill(user, slug, displayName, draft.description, draft.body)
      const extras: SkillZipImportExtras = { ignored_files: draft.ignoredFiles }
      return reply.code(201).send({ ...skillView(user, skill), ...extras })
    })
  })

  fastify.patch('/api/catalog/skills/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const skill = skillOr404(user, id)
    rejectExternal(skill, 'se edita')
    const body = requireObject(request.body)
    rejectUnknown(body, ['display_name', 'description', 'body'])
    const displayName = 'display_name' in body ? requireString(body, 'display_name') : skill.display_name
    const description = 'description' in body ? optionalString(body, 'description') : skill.description
    const skillBody = 'body' in body ? optionalString(body, 'body') : skill.body
    const newHash = skillContentHash(displayName, description, skillBody)
    const fields: { display_name?: string; description?: string; body?: string; version?: number; content_hash?: string } = {
      display_name: displayName,
      description,
      body: skillBody,
    }
    if (newHash !== skill.content_hash) {
      fields.version = skill.version + 1
      fields.content_hash = newHash
    }
    store.updateSkill(skill.id, fields)
    notifyAfterCommit('user', user.id)
    return skillView(user, store.skill(skill.id)!)
  })

  fastify.delete('/api/catalog/skills/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const skill = skillOr404(user, id)
    rejectExternal(skill, 'se quita')
    store.softDeleteSkill(skill.id)
    notifyAfterCommit('user', user.id)
    return reply.code(204).send()
  })

  fastify.post('/api/catalog/skills/:id/restore', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const deleted = store.deletedSkill(id)
    // The window is checked here, not only by the purge: a purge timer that has not run yet must not extend it.
    if (!deleted || deleted.user_id !== user.id || !withinRestoreWindow(deleted.deleted_at)) {
      const live = store.skill(id)
      if (live && live.user_id === user.id) throw new HttpError(409, 'la skill no está eliminada')
      throw new HttpError(404, 'la skill no existe o ya venció el plazo para restaurarla')
    }
    rejectExternal(deleted, 'se restaura')
    if (store.skillBySlug(user.id, deleted.slug)) throw new HttpError(409, `ya tenes otra skill con el slug ${deleted.slug}`)
    store.restoreSkill(deleted.id)
    notifyAfterCommit('user', user.id)
    return skillView(user, store.skill(deleted.id)!)
  })
}
