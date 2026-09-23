/**
 * Biblioteca de skills de la persona: `~/.agents/skills/<slug>/SKILL.md`.
 *
 * Es la carpeta canónica de `npx skills add -g` (https://github.com/vercel-labs/skills): la
 * biblioteca deja ahí la copia única y enlaza a cada agente que la persona eligió. El daemon la
 * recorre y reporta al core lo que encuentra; el core la refleja en el catálogo y, a partir de
 * ahí, el hub decide en qué cliente se enlaza cada una. Nada se copia: una skill externa se
 * enlaza siempre a su carpeta original, así conserva scripts y referencias y `npx skills update`
 * sigue funcionando.
 *
 * La procedencia sale de `~/.agents/.skill-lock.json` cuando existe (`source`, por ejemplo
 * `vercel-labs/skills`); no es obligatoria.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalJson, sha256, SKILL_FILENAME } from '@agenthub/shared'

import { regionDigest, TREE_REGION } from './adapters/atomic.js'

export const EXTERNAL_SKILLS_DIR = '.agents/skills'
export const SKILL_LOCK_FILE = '.agents/.skill-lock.json'

/** Lo que viaja al core por cada skill encontrada. */
export interface ExternalSkill {
  slug: string
  display_name: string
  description: string
  body: string
  tree_hash: string
  source_path: string
  source_ref: string
}

export interface ExternalScan {
  root: string
  skills: ExternalSkill[]
  /** Carpetas que no se reportan y por qué. */
  ignored: { name: string; reason: string }[]
}

/** Respuesta del core a un reporte: qué cambió en el catálogo. */
export interface ExternalSkillsOutcome {
  created: string[]
  updated: string[]
  removed: string[]
  skipped: { slug: string; reason: string }[]
}

export function externalSkillsRoot(home: string): string {
  return join(home, EXTERNAL_SKILLS_DIR)
}

export interface Frontmatter {
  fields: Record<string, string>
  body: string
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Frontmatter YAML de un SKILL.md, con lo justo para `name`, `description` y afines:
 * escalares planos o entrecomillados, bloques `>`/`|` (con `-` opcional) y continuaciones
 * indentadas. Cualquier otra estructura queda como texto plano en su clave.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
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
    while (next < lines.length && (/^\s+\S/.test(lines[next]!) || lines[next]!.trim() === '')) {
      if (lines[next]!.trim() === '' && !(next + 1 < lines.length && /^\s+\S/.test(lines[next + 1]!))) break
      continuation.push(lines[next]!)
      next += 1
    }
    const block = /^([>|])([+-]?)$/.exec(rest)
    if (block !== null) {
      const dedented = continuation.map((item) => item.replace(/^\s+/, ''))
      fields[key] = block[1] === '>' ? dedented.join(' ').replace(/\s+/g, ' ').trim() : dedented.join('\n').trim()
    } else if (continuation.length > 0 && rest !== '' && !rest.startsWith('"') && !rest.startsWith("'")) {
      fields[key] = [rest, ...continuation.map((item) => item.trim())].join(' ').trim()
    } else {
      fields[key] = unquote(rest)
    }
    index = next
  }
  return { fields, body: text.slice(match[0].length) }
}

function readLock(home: string): Record<string, string> {
  const path = join(home, SKILL_LOCK_FILE)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { skills?: Record<string, { source?: unknown }> }
    const refs: Record<string, string> = {}
    for (const [slug, entry] of Object.entries(parsed.skills ?? {})) {
      if (entry && typeof entry.source === 'string') refs[slug] = entry.source
    }
    return refs
  } catch {
    return {}
  }
}

/** Recorre la biblioteca. Una carpeta sin SKILL.md, oculta o enlazada no es una skill. */
export function scanExternalSkills(home: string): ExternalScan {
  const root = externalSkillsRoot(home)
  const scan: ExternalScan = { root, skills: [], ignored: [] }
  if (!existsSync(root)) return scan
  const refs = readLock(home)
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    let info
    try {
      info = lstatSync(dir)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) {
      scan.ignored.push({ name, reason: 'es un enlace, no una carpeta propia' })
      continue
    }
    if (!info.isDirectory()) continue
    const file = join(dir, SKILL_FILENAME)
    if (!existsSync(file)) {
      scan.ignored.push({ name, reason: `no tiene ${SKILL_FILENAME}` })
      continue
    }
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch (error) {
      scan.ignored.push({ name, reason: `no se pudo leer ${SKILL_FILENAME}: ${(error as Error).message}` })
      continue
    }
    const treeHash = regionDigest(dir, TREE_REGION)
    if (treeHash === null) continue
    const { fields, body } = parseFrontmatter(text)
    scan.skills.push({
      slug: name,
      display_name: fields['title'] || fields['name'] || name,
      description: fields['description'] ?? '',
      body: body.replace(/^\n+/, ''),
      tree_hash: treeHash,
      source_path: dir,
      source_ref: refs[name] ?? '',
    })
  }
  return scan
}

/** Huella de un recorrido, para no repetir un reporte idéntico al core. */
export function scanDigest(scan: ExternalScan): string {
  return sha256(canonicalJson(scan.skills.map((skill) => [skill.slug, skill.tree_hash, skill.source_ref])))
}

/**
 * Aviso de cambios en la biblioteca. Si la carpeta todavía no existe se observa a su padre
 * para enterarse de cuando aparezca; sin ninguno de los dos, queda el reescaneo periódico.
 * `unref` evita que el observador mantenga vivo un comando de una sola pasada.
 */
export function watchExternalSkills(home: string, onChange: () => void): () => void {
  const root = externalSkillsRoot(home)
  const target = existsSync(root) ? root : existsSync(dirname(root)) ? dirname(root) : null
  if (target === null) return () => undefined
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(target, { recursive: target === root }, () => onChange())
    watcher.unref()
    watcher.on('error', () => undefined)
  } catch {
    return () => undefined
  }
  return () => {
    watcher?.close()
    watcher = null
  }
}
