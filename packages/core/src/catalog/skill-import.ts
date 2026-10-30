/**
 * Borrador de skill del hub a partir de un ZIP: el formato de `GET /api/catalog/skills/:id/zip`
 * (`<carpeta>/SKILL.md`) o `SKILL.md` en la raíz. Una skill del hub guarda solo su SKILL.md, así
 * que el resto de los archivos se informa como ignorado. Nada se escribe en disco.
 */
import { MAX_SKILL_BYTES as MAX_TOTAL_BYTES, listZip, readZipEntry, ZipReadError } from "../zip.js"
import { parseFrontmatter, SKILL_FILENAME, SKILL_MD_MAX_BYTES, SKILL_ZIP_MAX_ENTRIES } from "@agenthub/shared"

export interface SkillZipDraft {
  /** `name` del frontmatter, sin validar como slug. */
  name: string
  displayName: string
  description: string
  body: string
  ignoredFiles: string[]
}

/** Metadatos que agregan macOS y Finder al comprimir; no son parte de la skill. */
function junk(name: string): boolean {
  return name === "__MACOSX" || name.startsWith("__MACOSX/") || name === ".DS_Store" || name.endsWith("/.DS_Store")
}

export function skillDraftFromZip(archive: Buffer): SkillZipDraft {
  const entries = listZip(archive, { maxEntries: SKILL_ZIP_MAX_ENTRIES, maxTotalBytes: MAX_TOTAL_BYTES })
  const files = entries.filter((entry) => !entry.directory && !junk(entry.name))
  const candidates = files.filter((entry) => entry.name === SKILL_FILENAME || /^[^/]+\/SKILL\.md$/.test(entry.name))
  if (candidates.length === 0) throw new ZipReadError(422, `el ZIP no tiene ${SKILL_FILENAME} en la raíz ni en una carpeta de primer nivel`)
  if (candidates.length > 1) throw new ZipReadError(422, `el ZIP tiene más de un ${SKILL_FILENAME}: ${candidates.map((entry) => entry.name).join(", ")}`)
  const skillFile = candidates[0]!
  const prefix = skillFile.name.slice(0, -SKILL_FILENAME.length)
  const outside = prefix ? files.filter((entry) => !entry.name.startsWith(prefix)) : []
  if (outside.length > 0) throw new ZipReadError(422, `todo el contenido del ZIP debe estar dentro de ${prefix}; fuera: ${outside.slice(0, 5).map((entry) => entry.name).join(", ")}`)

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readZipEntry(archive, skillFile, SKILL_MD_MAX_BYTES))
  } catch (error) {
    if (error instanceof ZipReadError) throw error
    throw new ZipReadError(422, `${SKILL_FILENAME} no es texto UTF-8`)
  }
  const { fields, body } = parseFrontmatter(text)
  if (Object.keys(fields).length === 0) throw new ZipReadError(422, `${SKILL_FILENAME} no empieza con un frontmatter --- … ---`)
  const name = (fields["name"] ?? "").trim()
  const description = (fields["description"] ?? "").trim()
  if (!name) throw new ZipReadError(422, `el frontmatter de ${SKILL_FILENAME} no tiene name`)
  if (!description) throw new ZipReadError(422, `el frontmatter de ${SKILL_FILENAME} no tiene description`)
  return {
    name,
    displayName: (fields["title"] ?? "").trim() || name,
    description,
    body: body.replace(/^(?:\r?\n)+/, ""),
    ignoredFiles: files.filter((entry) => entry !== skillFile).map((entry) => entry.name.slice(prefix.length)).sort(),
  }
}
