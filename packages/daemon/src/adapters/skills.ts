/**
 * Materialización de skills en el disco de la persona.
 *
 * Cada skill del hub vive una sola vez, en el store canónico del daemon
 * (`~/.agenthub/skills/<slug>/SKILL.md`), y cada CLI la ve por un symlink desde su
 * propia raíz de skills. Una skill externa (importada de `~/.agents/skills`) no pasa por
 * el store: el symlink apunta a su carpeta original, que conserva scripts y referencias.
 * Si el symlink no se puede crear (Windows sin privilegios) se cae a una copia, que es
 * el plan B previsto y no un error.
 *
 * Lo que el hub borra sale del manifiesto, nunca de listar el directorio: en esas
 * carpetas también viven las skills personales y no se tocan.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { renderSkillMd, SKILL_FILENAME, type SnapshotSkill } from '@agenthub/shared'

import {
  contentTree,
  detectDrift,
  driftItem,
  hubDir,
  Manifest,
  planDelete,
  planFileWrite,
  planSymlink,
  regionDigest,
  regionLabel,
  TREE_REGION,
  type DriftItem,
  type FileChange,
  type ManagedRegion,
} from './atomic.js'
import type { Snapshot } from './base.js'

/** Native user roots keep client-specific enablement independent. */
export const SKILL_ROOTS: Record<string, string> = {
  claude_code: '.claude/skills',
  codex_cli: '.codex/skills',
  gemini_cli: '.gemini/skills',
  kiro: '.kiro/skills',
  // Claude Desktop no carga skills desde el disco y no tiene raíz.
  opencode: '.config/opencode/skills',
}

export { renderSkillMd, SKILL_FILENAME }
const STORE_SUBDIR = 'skills'

/** El slug es nombre de carpeta: se valida acá aunque el catálogo ya lo valide. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/

export function skillsRoot(cliKind: string, home: string): string {
  return join(home, SKILL_ROOTS[cliKind]!)
}

export function storeRoot(home: string): string {
  return join(hubDir(home), STORE_SUBDIR)
}

export function storeDir(home: string, slug: string): string {
  return join(storeRoot(home), slug)
}

export function storeFile(home: string, slug: string): string {
  return join(storeDir(home, slug), SKILL_FILENAME)
}

/** Una skill externa se enlaza a su carpeta original; sin carpeta no hay nada que enlazar. */
export function isExternalSkill(skill: SnapshotSkill): boolean {
  return skill.source === 'external' && typeof skill.source_path === 'string' && skill.source_path !== ''
}

/** Planifica store, enlaces y bajas de las skills del snapshot. */
export function planSkills(
  snapshot: Snapshot,
  home: string,
  roots: readonly string[],
  options: { cliKind?: string; manifest?: Manifest } = {},
): [FileChange[], DriftItem[]] {
  const manifest = options.manifest ?? Manifest.load(home)
  const cliKind = options.cliKind ?? ''
  const store = storeRoot(home)
  const changes: FileChange[] = []
  const drift: DriftItem[] = []

  const wanted: Record<string, SnapshotSkill> = {}
  for (const skill of snapshot.skills ?? []) {
    const slug = skill.slug
    if (!SAFE_SLUG.test(slug)) {
      drift.push(
        driftItem(store, 'slug', `la skill '${slug}' tiene un nombre que no puede ser carpeta; no se materializa`),
      )
      continue
    }
    if (isExternalSkill(skill) && !existsSync(skill.source_path!)) {
      drift.push(
        driftItem(skill.source_path!, 'carpeta', `la skill externa '${slug}' ya no está en su carpeta; no se enlaza`),
      )
      continue
    }
    wanted[slug] = skill
  }

  const rendered: Record<string, string> = {}
  for (const slug of Object.keys(wanted)) {
    if (!isExternalSkill(wanted[slug]!)) rendered[slug] = renderSkillMd(wanted[slug]!)
  }

  for (const slug of Object.keys(rendered).sort()) {
    const [change, items] = planFileWrite({
      home,
      path: storeFile(home, slug),
      content: rendered[slug]!,
      manifest,
      cliKind,
      mode: 0o644,
      skillsRoot: store,
      skillSlug: slug,
      summary: `skill ${slug} en el store del daemon`,
    })
    if (change !== null) changes.push(change)
    drift.push(...items)
  }

  for (const root of roots) {
    for (const slug of Object.keys(wanted).sort()) {
      const skill = wanted[slug]!
      const external = isExternalSkill(skill)
      const [change, items] = planSymlink({
        home,
        path: join(root, slug),
        target: external ? skill.source_path! : storeDir(home, slug),
        manifest,
        cliKind,
        skillsRoot: root,
        skillSlug: slug,
        summary: external ? `skill ${slug} (biblioteca) enlazada en ${root}` : `skill ${slug} disponible en ${root}`,
        ...(external ? { adopt: true } : { targetTree: contentTree(SKILL_FILENAME, rendered[slug]!) }),
      })
      if (change !== null) changes.push(change)
      drift.push(...items)
    }
  }

  const [removalChanges, removalDrift] = planRemovals(home, roots, wanted, manifest, cliKind)
  changes.push(...removalChanges)
  drift.push(...removalDrift)
  return [changes, drift]
}

/** Da de baja solo lo que el manifiesto dice que puso el hub. */
function planRemovals(
  home: string,
  roots: readonly string[],
  wanted: Record<string, SnapshotSkill>,
  manifest: Manifest,
  cliKind: string,
): [FileChange[], DriftItem[]] {
  const store = storeRoot(home)
  const changes: FileChange[] = []
  const drift: DriftItem[] = []
  // Migrate only links recorded by older Hub versions; personal .agents skills survive.
  const legacyRoots = cliKind === 'codex_cli' || cliKind === 'gemini_cli' ? [join(home, '.agents/skills')] : []

  for (const root of [...roots, ...legacyRoots, store]) {
    for (const slug of manifest.skillsFor(root).sort()) {
      if (slug in wanted && !legacyRoots.includes(root)) continue
      const path = join(root, slug)
      if (root === store) {
        // Another client's link is a live reference, even if this client's snapshot is OFF.
        if (Object.entries(manifest.skills).some(([otherRoot, slugs]) =>
          otherRoot !== store && !roots.includes(otherRoot) && !legacyRoots.includes(otherRoot) && slugs.includes(slug),
        )) continue
        const expected = manifest.digestFor(storeFile(home, slug), TREE_REGION)
        const found = regionDigest(storeFile(home, slug), TREE_REGION)
        if (expected !== null && found !== null && expected !== found) {
          drift.push(
            driftItem(
              storeFile(home, slug),
              regionLabel(TREE_REGION),
              'salió del snapshot pero está editado a mano; no se borra',
              expected,
              found,
            ),
          )
          continue
        }
      }
      const [change, items] = planDelete({
        home,
        path,
        manifest,
        cliKind,
        skillsRoot: root,
        skillSlug: slug,
        summary: `skill ${slug} salió del snapshot`,
      })
      if (change !== null) changes.push(change)
      drift.push(...items)
    }
  }

  return [changes, drift]
}

export function skillsDriftTargets(home: string, roots: readonly string[]): Array<[string, ManagedRegion]> {
  const manifest = Manifest.load(home)
  const store = storeRoot(home)
  const targets: Array<[string, ManagedRegion]> = []
  for (const slug of manifest.skillsFor(store)) targets.push([storeFile(home, slug), TREE_REGION])
  for (const root of roots) {
    for (const slug of manifest.skillsFor(root)) targets.push([join(root, slug), TREE_REGION])
  }
  return targets
}

export function skillsDrift(home: string, roots: readonly string[]): DriftItem[] {
  return detectDrift(home, skillsDriftTargets(home, roots))
}
