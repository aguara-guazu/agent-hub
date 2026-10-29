export interface Frontmatter {
  fields: Record<string, string>
  body: string
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Frontmatter YAML de un SKILL.md, con lo justo para `name`, `description` y afines:
 * escalares planos o entrecomillados, bloques `>`/`|` (con `-` opcional) y continuaciones
 * indentadas. Cualquier otra estructura queda como texto plano en su clave. Sin bloque,
 * `fields` queda vacío y `body` es el texto completo.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) return { fields: {}, body: text }
  const lines = match[1]!.split(/\r?\n/)
  const fields: Record<string, string> = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const keyMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (keyMatch === null) {
      index += 1
      continue
    }
    const key = keyMatch[1]!
    const rest = keyMatch[2]!.trim()
    const continuation: string[] = []
    let next = index + 1
    while (next < lines.length && (/^\s+\S/.test(lines[next]!) || lines[next]!.trim() === "")) {
      if (lines[next]!.trim() === "" && !(next + 1 < lines.length && /^\s+\S/.test(lines[next + 1]!))) break
      continuation.push(lines[next]!)
      next += 1
    }
    const block = /^([>|])([+-]?)$/.exec(rest)
    if (block !== null) {
      const dedented = continuation.map((item) => item.replace(/^\s+/, ""))
      fields[key] = block[1] === ">" ? dedented.join(" ").replace(/\s+/g, " ").trim() : dedented.join("\n").trim()
    } else if (continuation.length > 0 && rest !== "" && !rest.startsWith("\"") && !rest.startsWith("'")) {
      fields[key] = [rest, ...continuation.map((item) => item.trim())].join(" ").trim()
    } else {
      fields[key] = unquote(rest)
    }
    index = next
  }
  return { fields, body: text.slice(match[0].length) }
}

/** Tope del cuerpo de `POST /api/catalog/skills/import` (el ZIP tal como llega). */
export const SKILL_ZIP_MAX_BYTES = 10 * 1024 * 1024
/** Tope del SKILL.md descomprimido; igual al tope de cuerpo JSON de `POST /api/catalog/skills`. */
export const SKILL_MD_MAX_BYTES = 1024 * 1024
/** Tope de entradas del directorio central del ZIP. */
export const SKILL_ZIP_MAX_ENTRIES = 1000

/**
 * `POST /api/catalog/skills/import`
 *
 * Request: cuerpo binario con `Content-Type: application/zip` (también `application/x-zip-compressed`
 * u `application/octet-stream`), hasta SKILL_ZIP_MAX_BYTES. Formato aceptado: el de
 * `GET /api/catalog/skills/:id/zip` (`<carpeta>/SKILL.md`) o `SKILL.md` en la raíz.
 * Query opcional: `slug` reemplaza al `name` del frontmatter; `display_name` reemplaza a `title`/`name`.
 *
 * Response 201: la misma vista que `POST /api/catalog/skills` más `ignored_files`.
 * Errores `{ detail }`: 401; 409 slug ya usado; 413 ZIP o SKILL.md sobre el tope; 415 tipo de
 * contenido; 422 ZIP inválido, ZIP64, cifrado, rutas inseguras (absolutas, `..`, `\`, NUL, unidad),
 * enlaces simbólicos, sin SKILL.md o con más de uno, varias carpetas raíz, SKILL.md no UTF-8,
 * frontmatter ausente o sin `name`/`description`, slug inválido.
 */
export interface SkillZipImportExtras {
  /** Archivos del ZIP que el hub no guarda: una skill del hub es solo su SKILL.md. Rutas relativas a la carpeta de la skill. */
  ignored_files: string[]
}
