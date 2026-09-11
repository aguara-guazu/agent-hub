import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PolicySnapshot, SnapshotSkill } from '@agenthub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyChanges } from './atomic.js'
import { planSkills, renderSkillMd, skillsDrift, skillsRoot, storeFile } from './skills.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agenthub-skills-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function snap(skills: SnapshotSkill[]): PolicySnapshot {
  return {
    agent_instance_id: 'a1',
    cli_kind: 'kiro',
    user_id: 'u',
    user_email: 'e',
    machine_id: 'm',
    servers: [],
    skills,
    denied: [],
    snapshot_hash: 'h',
    generated_at: '2020-01-01T00:00:00Z',
  }
}

const runbook: SnapshotSkill = {
  id: 'sk1',
  slug: 'runbook-rds',
  display_name: 'Runbook RDS',
  description: 'Cómo responder un incidente',
  body: '# Pasos\n1. Mirar\n',
  version: 1,
  content_hash: 'c1',
}

describe('renderSkillMd', () => {
  it('arma frontmatter con name igual al slug', () => {
    const md = renderSkillMd(runbook)
    expect(md).toContain('name: "runbook-rds"')
    expect(md).toContain('description: "Cómo responder un incidente"')
    expect(md).toContain('# Pasos')
  })
})

describe('planSkills', () => {
  it('retiene el store hasta que el último cliente apaga la skill', () => {
    const apply = (cliKind: string, enabled: boolean) => applyChanges(planSkills(snap(enabled ? [runbook] : []), home, [skillsRoot(cliKind, home)], { cliKind })[0])
    apply('claude_code', true)
    apply('codex_cli', true)
    apply('codex_cli', false)
    expect(readFileSync(join(skillsRoot('claude_code', home), runbook.slug, 'SKILL.md'), 'utf8')).toContain('# Pasos')
    expect(existsSync(join(skillsRoot('codex_cli', home), runbook.slug))).toBe(false)
    apply('claude_code', false)
    expect(existsSync(storeFile(home, runbook.slug))).toBe(false)
  })

  it('Gemini OFF no elimina una skill ON de Codex y viceversa', () => {
    const apply = (cliKind: string, enabled: boolean) => applyChanges(planSkills(snap(enabled ? [runbook] : []), home, [skillsRoot(cliKind, home)], { cliKind })[0])
    apply('codex_cli', true)
    apply('gemini_cli', false)
    expect(existsSync(join(skillsRoot('codex_cli', home), runbook.slug, 'SKILL.md'))).toBe(true)
    apply('gemini_cli', true)
    apply('codex_cli', false)
    expect(existsSync(join(skillsRoot('gemini_cli', home), runbook.slug, 'SKILL.md'))).toBe(true)
  })

  it('migra enlaces antiguos compartidos sin borrar skills personales', () => {
    const legacy = join(home, '.agents/skills')
    applyChanges(planSkills(snap([runbook]), home, [legacy])[0])
    mkdirSync(join(legacy, 'personal'), { recursive: true })
    writeFileSync(join(legacy, 'personal/SKILL.md'), 'mine')
    applyChanges(planSkills(snap([runbook]), home, [skillsRoot('codex_cli', home)], { cliKind: 'codex_cli' })[0])
    expect(existsSync(join(legacy, runbook.slug))).toBe(false)
    expect(readFileSync(join(legacy, 'personal/SKILL.md'), 'utf8')).toBe('mine')
    expect(existsSync(join(skillsRoot('codex_cli', home), runbook.slug, 'SKILL.md'))).toBe(true)
  })
  it('materializa el store y enlaza desde la raíz del CLI', () => {
    const root = skillsRoot('kiro', home)
    const [changes, drift] = planSkills(snap([runbook]), home, [root], { cliKind: 'kiro' })
    expect(drift).toHaveLength(0)
    applyChanges(changes)
    expect(readFileSync(storeFile(home, 'runbook-rds'), 'utf-8')).toContain('# Pasos')
    expect(lstatSync(join(root, 'runbook-rds')).isSymbolicLink()).toBe(true)
  })

  it('rechaza un slug que no puede ser carpeta y lo reporta como deriva', () => {
    const malo: SnapshotSkill = { ...runbook, slug: '../escape' }
    const [changes, drift] = planSkills(snap([malo]), home, [skillsRoot('kiro', home)])
    expect(changes).toHaveLength(0)
    expect(drift.length).toBeGreaterThan(0)
  })

  it('da de baja lo que salió del snapshot (registrado en el manifiesto)', () => {
    const root = skillsRoot('kiro', home)
    applyChanges(planSkills(snap([runbook]), home, [root], { cliKind: 'kiro' })[0])
    // Ahora el snapshot ya no tiene la skill: se planifican los borrados.
    const [changes] = planSkills(snap([]), home, [root], { cliKind: 'kiro' })
    const result = applyChanges(changes)
    expect(result.removed.length).toBeGreaterThan(0)
    expect(skillsDrift(home, [root])).toHaveLength(0)
  })
})
