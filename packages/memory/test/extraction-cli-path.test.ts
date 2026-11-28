import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { findExtractionCli } from '../src/cli-extraction.js'

it('resuelve el ejecutable real de la instalación npm de Claude en Windows sin depender del PATH gráfico', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude npm-'))
  const prefix = join(home, 'AppData', 'npm')
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
  const native = join(pkg, 'bin', 'claude.exe')
  const resolve = () => findExtractionCli('claude_code', { PATH: '', APPDATA: dirname(prefix) }, home, 'win32')
  try {
    mkdirSync(dirname(native), { recursive: true })
    writeFileSync(join(prefix, 'claude.cmd'), '@echo off')
    writeFileSync(native, '', { mode: 0o755 })
    expect(resolve()).toBe(native)
    rmSync(native)
    writeFileSync(join(pkg, 'cli.js'), '')
    expect(resolve()).toBe(join(pkg, 'cli.js'))
    rmSync(join(pkg, 'cli.js'))
    expect(resolve()).toBeUndefined()
  } finally { rmSync(home, { recursive: true, force: true }) }
})
