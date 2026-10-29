/** Reglas del SKILL.md que el daemon materializa (`packages/daemon/src/adapters/skills.ts`).
 *  El frontmatter lo genera el daemon con `name` igual al slug: los CLIs no cargan una skill
 *  cuya carpeta y cuyo `name` no coinciden. */

export const SKILL_SLUG_RE = /^[a-z][a-z0-9_-]{1,47}$/

/** Escalar YAML entre comillas dobles. Igual que `_yaml_scalar` del daemon. */
export function yamlScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
  return `"${escaped.trim()}"`
}

/** Frontmatter que queda en el SKILL.md materializado. */
export function renderFrontmatter(slug: string, description: string, displayName: string): string {
  const text = description.trim() || displayName.trim() || slug
  return ["---", `name: ${yamlScalar(slug)}`, `description: ${yamlScalar(text)}`, "---"].join("\n")
}

export interface BodyFrontmatter {
  /** Valor de `name:` sin comillas, o cadena vacía si no está. */
  name: string
  /** Valor de `description:` sin comillas, o cadena vacía si no está. */
  description: string
  /** Cuerpo sin el bloque. */
  rest: string
}

function unquote(value: string): string {
  return value.trim().replace(/^["']/, "").replace(/["']$/, "")
}

/** Frontmatter pegado dentro del cuerpo: el daemon antepone el suyo y quedarían dos bloques. */
export function extractBodyFrontmatter(body: string): BodyFrontmatter | null {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body)
  if (match === null) return null
  const block = match[1] ?? ""
  return {
    name: unquote(/^name:\s*(.*)$/m.exec(block)?.[1] ?? ""),
    description: unquote(/^description:\s*(.*)$/m.exec(block)?.[1] ?? ""),
    rest: body.slice(match[0].length),
  }
}

export interface SkillDraft {
  slug: string
  displayName: string
  description: string
  body: string
}

/** Convierte un SKILL.md completo en un borrador: el frontmatter se separa del cuerpo. */
export function draftFromSkillFile(text: string, fallbackSlug: string): SkillDraft {
  const parsed = extractBodyFrontmatter(text)
  const slug = slugify(parsed?.name || fallbackSlug)
  return {
    slug,
    displayName: parsed?.name || fallbackSlug,
    description: parsed?.description ?? "",
    body: (parsed ? parsed.rest : text).replace(/^\s*\n/, ""),
  }
}

/** Slug válido a partir de un texto libre; puede quedar inválido si el texto no tiene letras. */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 48)
}

/** Descarga un blob obtenido por la API autenticada: un enlace directo no llevaría el token. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
