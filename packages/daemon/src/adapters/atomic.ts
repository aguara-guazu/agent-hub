/**
 * Escritura atómica, merge quirúrgico y manifiesto de lo que el hub gestiona.
 *
 * Tres invariantes gobiernan este módulo:
 *
 * 1. Nunca se reescribe un archivo entero desde cero. Se lee, se toca únicamente la
 *    región que el hub gestiona y se vuelve a serializar. Todo lo demás sobrevive.
 * 2. La escritura es temp + rename dentro del MISMO directorio: un rename entre
 *    dispositivos no es atómico. Kiro relee su mcp.json apenas cambia, así que un
 *    archivo a medio escribir le tumba todos los servers del scope.
 * 3. Si en la región gestionada aparece contenido que el hub no puso, no se pisa: se
 *    reporta deriva y decide la persona.
 *
 * El manifiesto (`~/.agenthub/managed.json`) es lo que hace posible el punto 3 y, de
 * paso, lo que impide borrar skills personales: el hub solo borra lo que registró.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import * as toml from '@iarna/toml'

export const HUB_DIRNAME = '.agenthub'
export const MANIFEST_VERSION = 1

export type RegionKind = 'json_value' | 'json_prefixed_list' | 'json_hooks' | 'toml_table' | 'tree'
/** `adopt`: un enlace ajeno equivalente pasa al manifiesto sin reescribirse. */
export type ChangeAction = 'write' | 'symlink' | 'delete' | 'adopt'

export function hubDir(home: string): string {
  return join(home, HUB_DIRNAME)
}

export function manifestPath(home: string): string {
  return join(hubDir(home), 'managed.json')
}

export function backupDir(home: string): string {
  return join(hubDir(home), 'backups')
}

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigParseError'
  }
}

// --------------------------------------------------------------------------- //
// Región gestionada
// --------------------------------------------------------------------------- //

/** El pedacito de un archivo del que el hub se hace cargo. */
export interface ManagedRegion {
  kind: RegionKind
  keyPath: string[]
  prefix: string
}

export function region(kind: RegionKind, keyPath: string[] = [], prefix = ''): ManagedRegion {
  return { kind, keyPath, prefix }
}

export function regionLabel(r: ManagedRegion): string {
  const dotted = r.keyPath.join('.')
  if (r.kind === 'json_prefixed_list') return `${dotted}[${r.prefix}*]`
  return dotted || '<archivo>'
}

function manifestSuffix(r: ManagedRegion): string {
  return `${r.kind}:${r.keyPath.join('.')}:${r.prefix}`
}

export function manifestKey(path: string, r: ManagedRegion): string {
  return `${path}#${manifestSuffix(r)}`
}

// --------------------------------------------------------------------------- //
// Lectura de disco
// --------------------------------------------------------------------------- //

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  if (isSymlink(path)) return null
  try {
    const info = statSync(path)
    if (!info.isFile()) return null
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function dig(doc: unknown, keyPath: string[]): unknown {
  let cursor: unknown = doc
  for (const key of keyPath) {
    if (cursor === null || typeof cursor !== 'object' || !(key in (cursor as Record<string, unknown>))) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function sha256Bytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Huella de un archivo, un symlink o un árbol de archivos. */
function readTree(path: string): unknown {
  if (isSymlink(path)) return { symlink: readlinkSync(path) }
  if (!exists(path)) return null
  const info = statSync(path)
  if (info.isDirectory()) {
    const entries: Record<string, string> = {}
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const child = join(dir, name)
        const rel = relative(path, child)
        if (isSymlink(child)) {
          entries[rel] = 'symlink:' + readlinkSync(child)
        } else if (statSync(child).isDirectory()) {
          walk(child)
        } else {
          entries[rel] = sha256Bytes(readFileSync(child))
        }
      }
    }
    walk(path)
    return { tree: entries }
  }
  return { file: sha256Bytes(readFileSync(path)) }
}

export function readRegion(path: string, r: ManagedRegion): unknown {
  if (r.kind === 'tree') return readTree(path)

  const text = readText(path)
  if (text === null) return null

  if (r.kind === 'toml_table') {
    let doc: unknown
    try {
      doc = toml.parse(text)
    } catch (exc) {
      throw new ConfigParseError(`${path} no es TOML válido: ${(exc as Error).message}`)
    }
    const value = dig(doc, r.keyPath)
    return value === undefined ? null : value
  }

  let parsed: unknown
  try {
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch (exc) {
    throw new ConfigParseError(`${path} no es JSON válido: ${(exc as Error).message}`)
  }

  if (r.kind === 'json_value') return dig(parsed, r.keyPath)
  if (r.kind === 'json_hooks') {
    const hooks = dig(parsed, r.keyPath)
    const mine = Object.fromEntries(Object.entries((hooks && typeof hooks === 'object' ? hooks : {}) as Record<string, unknown>)
      .flatMap(([event, groups]) => { const own = Array.isArray(groups) ? groups.filter(isHubHook) : []; return own.length ? [[event, own]] : [] }))
    return Object.keys(mine).length ? mine : null
  }

  const raw = dig(parsed, r.keyPath)
  if (!Array.isArray(raw)) return null
  const mine = raw.filter((x): x is string => typeof x === 'string' && x.startsWith(r.prefix)).sort()
  // Una lista sin entradas del hub equivale a "acá no hay nada mío".
  return mine.length > 0 ? mine : null
}

/** Cómo se va a ver un directorio que contiene un único archivo con `content`. */
export function contentTree(filename: string, content: string): { tree: Record<string, string> } {
  return { tree: { [filename]: sha256Bytes(Buffer.from(content, 'utf-8')) } }
}

export function fileDigest(path: string): string | null {
  if (isSymlink(path)) return null
  try {
    if (!statSync(path).isFile()) return null
    return sha256Bytes(readFileSync(path))
  } catch {
    return null
  }
}

export function canonicalDigest(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const blob = stableStringify(value)
  return sha256Bytes(Buffer.from(blob, 'utf-8'))
}

/** JSON con claves ordenadas para hashes y escrituras deterministas. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function regionDigest(path: string, r: ManagedRegion): string | null {
  return canonicalDigest(readRegion(path, r))
}

// --------------------------------------------------------------------------- //
// Manifiesto
// --------------------------------------------------------------------------- //

/** Registro de lo que el hub escribió en esta máquina. */
export class Manifest {
  readonly home: string
  files: Record<string, string>
  skills: Record<string, string[]>

  constructor(home: string, files: Record<string, string> = {}, skills: Record<string, string[]> = {}) {
    this.home = home
    this.files = files
    this.skills = skills
  }

  static load(home: string): Manifest {
    const raw = readText(manifestPath(home))
    if (raw === null) return new Manifest(home)
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      // Un manifiesto ilegible se trata como vacío: peor sería borrar por error.
      return new Manifest(home)
    }
    const obj = (data ?? {}) as { files?: Record<string, unknown>; skills?: Record<string, unknown> }
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj.files ?? {})) files[String(k)] = String(v)
    const skills: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(obj.skills ?? {})) {
      skills[String(k)] = Array.isArray(v) ? v.map((s) => String(s)) : []
    }
    return new Manifest(home, files, skills)
  }

  save(): void {
    const payload = {
      version: MANIFEST_VERSION,
      files: Object.fromEntries(Object.entries(this.files).sort(([a], [b]) => (a < b ? -1 : 1))),
      skills: Object.fromEntries(
        Object.entries(this.skills)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, [...v].sort()]),
      ),
    }
    const target = manifestPath(this.home)
    mkdirSync(dirname(target), { recursive: true })
    chmodSync(dirname(target), 0o700)
    atomicWriteText(target, JSON.stringify(payload, null, 2) + '\n', 0o600)
  }

  digestFor(path: string, r: ManagedRegion): string | null {
    return this.files[manifestKey(path, r)] ?? null
  }

  record(path: string, r: ManagedRegion, digest: string | null): void {
    const key = manifestKey(path, r)
    if (digest === null) delete this.files[key]
    else this.files[key] = digest
  }

  /** Olvida la región de `path` y la de todo lo que colgaba de él. */
  forgetUnder(path: string): void {
    const prefix = `${path}#`
    const nested = `${path}${sep}`
    for (const key of Object.keys(this.files)) {
      if (key.startsWith(prefix) || key.startsWith(nested)) delete this.files[key]
    }
  }

  skillsFor(root: string): string[] {
    return [...(this.skills[root] ?? [])]
  }

  addSkill(root: string, slug: string): void {
    const bucket = (this.skills[root] ??= [])
    if (!bucket.includes(slug)) bucket.push(slug)
  }

  dropSkill(root: string, slug: string): void {
    const bucket = this.skills[root]
    if (bucket) {
      const idx = bucket.indexOf(slug)
      if (idx >= 0) bucket.splice(idx, 1)
      if (bucket.length === 0) delete this.skills[root]
    }
  }
}

// --------------------------------------------------------------------------- //
// Cambios y deriva
// --------------------------------------------------------------------------- //

/** Un cambio planificado, todavía no escrito. */
export interface FileChange {
  home: string
  path: string
  action: ChangeAction
  region: ManagedRegion
  expectedDigest: string | null
  baseDigest: string | null
  content: string
  target: string | null
  mode: number
  summary: string
  cliKind: string
  skillsRoot: string | null
  skillSlug: string | null
  fallbackCopy: boolean
}

export function makeChange(partial: Partial<FileChange> & Pick<FileChange, 'home' | 'path' | 'action' | 'region'>): FileChange {
  return {
    expectedDigest: null,
    baseDigest: null,
    content: '',
    target: null,
    mode: 0o600,
    summary: '',
    cliKind: '',
    skillsRoot: null,
    skillSlug: null,
    fallbackCopy: false,
    ...partial,
  }
}

function dedupKey(change: FileChange): string {
  return `${change.path}\u0000${change.action}\u0000${change.content}\u0000${change.target ?? ''}`
}

/** Una región gestionada que en disco no dice lo que el hub dejó. */
export interface DriftItem {
  path: string
  region: string
  reason: string
  expectedDigest: string | null
  foundDigest: string | null
}

export function driftItem(
  path: string,
  regionText: string,
  reason: string,
  expectedDigest: string | null = null,
  foundDigest: string | null = null,
): DriftItem {
  return { path, region: regionText, reason, expectedDigest, foundDigest }
}

export function describeDrift(item: DriftItem): string {
  return `${item.path} [${item.region}]: ${item.reason}`
}

export interface DriftReport {
  cliKind: string
  items: DriftItem[]
}

export function driftDetail(report: DriftReport): string {
  return report.items.map(describeDrift).join(' | ')
}

export interface ApplyResult {
  written: string[]
  removed: string[]
  /** Enlaces que ya existían con el mismo destino y ahora administra el hub. */
  adopted: string[]
  skipped: string[]
  drift: DriftItem[]
  backups: Record<string, string>
}

function emptyResult(): ApplyResult {
  return { written: [], removed: [], adopted: [], skipped: [], drift: [], backups: {} }
}

export function applyOk(result: ApplyResult): boolean {
  return result.drift.length === 0
}

// --------------------------------------------------------------------------- //
// Escritura
// --------------------------------------------------------------------------- //

/** Escribe por temp + rename en el mismo directorio del destino. */
export function atomicWriteText(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (exc) {
    try {
      closeSync(fd)
    } catch {
      /* ya cerrado */
    }
    rmSync(tmp, { force: true })
    throw exc
  }
  fsyncDir(dirname(path))
}

function basename(path: string): string {
  return path.split(sep).pop() ?? path
}

function fsyncDir(directory: string): void {
  let fd: number
  try {
    fd = openSync(directory, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    /* algunos sistemas no permiten fsync de directorios */
  } finally {
    closeSync(fd)
  }
}

function backup(change: FileChange): string | null {
  if (isSymlink(change.path)) return null
  try {
    if (!statSync(change.path).isFile()) return null
  } catch {
    return null
  }
  const stamp = createHash('sha256').update(change.path).digest('hex').slice(0, 8)
  const dest = join(backupDir(change.home), `${basename(change.path)}.${stamp}.bak`)
  mkdirSync(dirname(dest), { recursive: true })
  chmodSync(hubDir(change.home), 0o700)
  copyFileSync(change.path, dest)
  chmodSync(dest, 0o600)
  return dest
}

function removePath(path: string): void {
  if (isSymlink(path)) {
    rmSync(path, { force: true })
  } else if (exists(path)) {
    rmSync(path, { force: true, recursive: true })
  }
}

/** Codex y Gemini comparten `~/.agents/skills`: el mismo cambio llega dos veces. */
function dedup(changes: readonly FileChange[]): FileChange[] {
  const seen = new Set<string>()
  const out: FileChange[] = []
  for (const change of changes) {
    const key = dedupKey(change)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(change)
  }
  return out
}

/** Aplica los cambios planificados y devuelve qué se escribió y qué derivó. */
export function applyChanges(changes: readonly FileChange[]): ApplyResult {
  const result = emptyResult()
  const byHome = new Map<string, FileChange[]>()
  for (const change of dedup(changes)) {
    const bucket = byHome.get(change.home) ?? []
    bucket.push(change)
    byHome.set(change.home, bucket)
  }

  for (const [home, group] of byHome) {
    const manifest = Manifest.load(home)
    let touched = false
    for (const change of group) {
      let found: string | null
      try {
        found = regionDigest(change.path, change.region)
      } catch (exc) {
        if (!(exc instanceof ConfigParseError)) throw exc
        result.drift.push(driftItem(change.path, regionLabel(change.region), exc.message))
        result.skipped.push(change.path)
        continue
      }

      const stale =
        found !== change.expectedDigest ||
        (change.action === 'write' && fileDigest(change.path) !== change.baseDigest)
      if (stale) {
        result.drift.push(
          driftItem(
            change.path,
            regionLabel(change.region),
            'el archivo cambió entre el plan y la escritura; el hub no lo pisa',
            change.expectedDigest,
            found,
          ),
        )
        result.skipped.push(change.path)
        continue
      }

      perform(change, result)
      touched = true

      if (change.action === 'delete') {
        manifest.forgetUnder(change.path)
        if (change.skillsRoot !== null && change.skillSlug) manifest.dropSkill(change.skillsRoot, change.skillSlug)
      } else {
        // Se relee de disco: con el plan B de copia lo que quedó no es un symlink.
        manifest.record(change.path, change.region, regionDigest(change.path, change.region))
        if (change.skillsRoot !== null && change.skillSlug) manifest.addSkill(change.skillsRoot, change.skillSlug)
      }
    }
    if (touched) manifest.save()
  }

  return result
}

function perform(change: FileChange, result: ApplyResult): void {
  if (change.action === 'adopt') {
    result.adopted.push(change.path)
    return
  }
  if (change.action === 'write') {
    const backupPath = backup(change)
    if (backupPath) result.backups[change.path] = backupPath
    atomicWriteText(change.path, change.content, change.mode)
    result.written.push(change.path)
    return
  }

  if (change.action === 'symlink') {
    const target = change.target
    if (target === null) throw new Error('symlink sin destino')
    mkdirSync(dirname(change.path), { recursive: true })
    removePath(change.path)
    try {
      const isDir = exists(target) && statSync(target).isDirectory()
      symlinkSync(target, change.path, isDir ? 'dir' : 'file')
    } catch (exc) {
      // Windows sin privilegios: la copia es el plan B previsto, no un fallo.
      if (!change.fallbackCopy) throw exc
      if (exists(target) && statSync(target).isDirectory()) {
        cpSync(target, change.path, { recursive: true })
      } else {
        copyFileSync(target, change.path)
      }
    }
    result.written.push(change.path)
    return
  }

  removePath(change.path)
  result.removed.push(change.path)
}

// --------------------------------------------------------------------------- //
// Planificadores con merge quirúrgico
// --------------------------------------------------------------------------- //

export type PlanOutcome = [FileChange | null, DriftItem[]]

function isHubHook(group: any): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some((hook: any) => typeof hook?.command === 'string' && hook.command.includes('--agenthub-memory-hook'))
}
/** Own only Agent Hub's hook groups; preserve personal hooks and detect edits to ours. */
export function planJsonHooks(args: PlanJsonArgs): PlanOutcome {
  const r = region('json_hooks', args.keyPath)
  let doc: Record<string, unknown>, current: unknown
  try { doc = loadJsonDoc(args.path); current = readRegion(args.path, r) }
  catch (error) { return [null, [driftItem(args.path, regionLabel(r), String(error))]] }
  const desired = args.value as Record<string, unknown[]>
  const currentDigest = canonicalDigest(current), desiredDigest = canonicalDigest(Object.keys(desired).length ? desired : null)
  const drift = foreignContent(args.path, r, currentDigest, desiredDigest, args.manifest.digestFor(args.path, r))
  if (drift) return [null, [drift]]
  if (currentDigest === desiredDigest) return [null, []]
  const raw = dig(doc, args.keyPath)
  const hooks = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const merged: Record<string, unknown> = {}
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(desired)])) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return [null, [driftItem(args.path, event, 'La lista de hooks no es válida')]]
    merged[event] = [...((hooks[event] ?? []) as unknown[]).filter(g => !isHubHook(g)), ...(desired[event] ?? [])]
  }
  setIn(doc, args.keyPath, merged)
  return [makeChange({ home: args.home, path: args.path, action: 'write', region: r, expectedDigest: currentDigest,
    baseDigest: fileDigest(args.path), content: dumpJson(doc), mode: 0o600, cliKind: args.cliKind ?? '', summary: 'Eventos de sesión para notas de memoria' }), []]
}

const UNSET = Symbol('unset')

function foreignContent(
  path: string,
  r: ManagedRegion,
  current: string | null,
  desired: string | null,
  expected: string | null,
): DriftItem | null {
  if (current === null || current === desired || current === expected) return null
  return driftItem(
    path,
    regionLabel(r),
    'hay contenido que el hub no escribió bajo la clave que gestiona; no se pisa',
    expected,
    current,
  )
}

function loadJsonDoc(path: string): Record<string, unknown> {
  const text = readText(path)
  if (text === null || !text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (exc) {
    throw new ConfigParseError(`${path} no es JSON válido: ${(exc as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError(`${path} no tiene un objeto JSON en la raíz`)
  }
  return parsed as Record<string, unknown>
}

function setIn(doc: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor = doc
  for (const key of keyPath.slice(0, -1)) {
    let nested = cursor[key]
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      nested = {}
      cursor[key] = nested
    }
    cursor = nested as Record<string, unknown>
  }
  cursor[keyPath[keyPath.length - 1]!] = value
}

function dumpJson(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

interface PlanJsonArgs {
  home: string
  path: string
  keyPath: string[]
  value: unknown
  manifest: Manifest
  cliKind?: string
  mode?: number
  summary?: string
}

/** Deja `value` bajo `keyPath` sin tocar ninguna otra clave del archivo. */
export function planJsonValue(args: PlanJsonArgs): PlanOutcome {
  const r = region('json_value', [...args.keyPath])
  let current: unknown
  let doc: Record<string, unknown>
  try {
    current = readRegion(args.path, r)
    doc = loadJsonDoc(args.path)
  } catch (exc) {
    if (!(exc instanceof ConfigParseError)) throw exc
    return [null, [driftItem(args.path, regionLabel(r), exc.message)]]
  }

  const currentDigest = canonicalDigest(current)
  const desiredDigest = canonicalDigest(args.value)
  const expected = args.manifest.digestFor(args.path, r)

  const drift = foreignContent(args.path, r, currentDigest, desiredDigest, expected)
  if (drift !== null) return [null, [drift]]
  if (currentDigest === desiredDigest) return [null, []]

  setIn(doc, [...args.keyPath], args.value)
  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'write',
      region: r,
      expectedDigest: currentDigest,
      baseDigest: fileDigest(args.path),
      content: dumpJson(doc),
      mode: args.mode ?? 0o600,
      summary: args.summary || `${args.path}: ${regionLabel(r)}`,
      cliKind: args.cliKind ?? '',
    }),
    [],
  ]
}

interface PlanListArgs {
  home: string
  path: string
  keyPath: string[]
  prefix: string
  values: string[]
  manifest: Manifest
  cliKind?: string
  mode?: number
  summary?: string
}

/** Sincroniza solo las entradas con `prefix` de una lista; las ajenas quedan igual. */
export function planJsonPrefixedList(args: PlanListArgs): PlanOutcome {
  const r = region('json_prefixed_list', [...args.keyPath], args.prefix)
  let current: unknown
  let doc: Record<string, unknown>
  try {
    current = readRegion(args.path, r)
    doc = loadJsonDoc(args.path)
  } catch (exc) {
    if (!(exc instanceof ConfigParseError)) throw exc
    return [null, [driftItem(args.path, regionLabel(r), exc.message)]]
  }

  const uniqueSorted = [...new Set(args.values)].sort()
  const desired = uniqueSorted.length > 0 ? uniqueSorted : null
  const currentDigest = canonicalDigest(current)
  const desiredDigest = canonicalDigest(desired)
  const expected = args.manifest.digestFor(args.path, r)

  const drift = foreignContent(args.path, r, currentDigest, desiredDigest, expected)
  if (drift !== null) return [null, [drift]]
  if (currentDigest === desiredDigest) return [null, []]

  const raw = dig(doc, [...args.keyPath])
  const kept = Array.isArray(raw)
    ? raw.filter((x) => !(typeof x === 'string' && x.startsWith(args.prefix)))
    : []
  setIn(doc, [...args.keyPath], [...kept, ...(desired ?? [])])
  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'write',
      region: r,
      expectedDigest: currentDigest,
      baseDigest: fileDigest(args.path),
      content: dumpJson(doc),
      mode: args.mode ?? 0o600,
      summary: args.summary || `${args.path}: ${regionLabel(r)}`,
      cliKind: args.cliKind ?? '',
    }),
    [],
  ]
}

interface PlanTomlArgs {
  home: string
  path: string
  keyPath: string[]
  value: Record<string, unknown>
  manifest: Manifest
  cliKind?: string
  mode?: number
  summary?: string
}

/** Edita el TOML conservando lo demás. */
export function planTomlTable(args: PlanTomlArgs): PlanOutcome {
  const r = region('toml_table', [...args.keyPath])
  const text = readText(args.path)
  let current: unknown
  let doc: Record<string, unknown>
  try {
    current = readRegion(args.path, r)
    doc = (text ? toml.parse(text) : {}) as Record<string, unknown>
  } catch (exc) {
    if (exc instanceof ConfigParseError) return [null, [driftItem(args.path, regionLabel(r), exc.message)]]
    return [null, [driftItem(args.path, regionLabel(r), `${args.path} no es TOML válido: ${(exc as Error).message}`)]]
  }

  const currentDigest = canonicalDigest(current)
  const desiredDigest = canonicalDigest(args.value)
  const expected = args.manifest.digestFor(args.path, r)

  const drift = foreignContent(args.path, r, currentDigest, desiredDigest, expected)
  if (drift !== null) return [null, [drift]]
  if (currentDigest === desiredDigest) return [null, []]

  setIn(doc, [...args.keyPath], args.value)
  let serialized: string
  try {
    serialized = toml.stringify(doc)
  } catch (exc) {
    return [null, [driftItem(args.path, regionLabel(r), `no se pudo serializar TOML: ${(exc as Error).message}`)]]
  }
  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'write',
      region: r,
      expectedDigest: currentDigest,
      baseDigest: fileDigest(args.path),
      content: serialized,
      mode: args.mode ?? 0o600,
      summary: args.summary || `${args.path}: ${regionLabel(r)}`,
      cliKind: args.cliKind ?? '',
    }),
    [],
  ]
}

export const TREE_REGION: ManagedRegion = region('tree')

interface PlanFileWriteArgs {
  home: string
  path: string
  content: string
  manifest: Manifest
  cliKind?: string
  mode?: number
  skillsRoot?: string | null
  skillSlug?: string | null
  summary?: string
}

export function planFileWrite(args: PlanFileWriteArgs): PlanOutcome {
  const current = readRegion(args.path, TREE_REGION)
  const desired = { file: sha256Bytes(Buffer.from(args.content, 'utf-8')) }
  const currentDigest = canonicalDigest(current)
  const desiredDigest = canonicalDigest(desired)
  const expected = args.manifest.digestFor(args.path, TREE_REGION)

  const drift = foreignContent(args.path, TREE_REGION, currentDigest, desiredDigest, expected)
  if (drift !== null) return [null, [drift]]
  if (currentDigest === desiredDigest) return [null, []]

  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'write',
      region: TREE_REGION,
      expectedDigest: currentDigest,
      baseDigest: fileDigest(args.path),
      content: args.content,
      mode: args.mode ?? 0o644,
      summary: args.summary || args.path,
      cliKind: args.cliKind ?? '',
      skillsRoot: args.skillsRoot ?? null,
      skillSlug: args.skillSlug ?? null,
    }),
    [],
  ]
}

interface PlanSymlinkArgs {
  home: string
  path: string
  target: string
  manifest: Manifest
  cliKind?: string
  skillsRoot?: string | null
  skillSlug?: string | null
  summary?: string
  targetTree?: unknown
  /**
   * Un enlace idéntico que el hub no registró (lo dejó otra herramienta, p. ej. `npx skills`)
   * se vuelve a escribir sólo para anotarlo en el manifiesto: desde entonces el hub lo
   * administra y lo retira cuando la skill se apaga.
   */
  adopt?: boolean
}

export function planSymlink(args: PlanSymlinkArgs): PlanOutcome {
  const current = readRegion(args.path, TREE_REGION)
  const desired = { symlink: args.target }
  const currentDigest = canonicalDigest(current)
  const desiredDigest = canonicalDigest(desired)
  const expected = args.manifest.digestFor(args.path, TREE_REGION)

  // Un enlace relativo (`../../.agents/skills/x`, como los deja `npx skills`) y el absoluto
  // del hub son el mismo destino: se comparan resueltos, no por el texto del enlace.
  const currentLink = current !== null && typeof current === 'object' && 'symlink' in current ? String((current as { symlink: unknown }).symlink) : null
  const sameTarget = currentLink !== null && resolve(dirname(args.path), currentLink) === resolve(args.target)
  if (currentDigest === desiredDigest || sameTarget) {
    if (!args.adopt || expected !== null) return [null, []]
    return [
      makeChange({
        home: args.home,
        path: args.path,
        action: 'adopt',
        region: TREE_REGION,
        expectedDigest: currentDigest,
        target: args.target,
        summary: `${args.summary || `${args.path} -> ${args.target}`} (enlace existente adoptado)`,
        cliKind: args.cliKind ?? '',
        skillsRoot: args.skillsRoot ?? null,
        skillSlug: args.skillSlug ?? null,
      }),
      [],
    ]
  }
  // Si el symlink no se pudo crear y quedó una copia, la copia al día vale igual.
  const finalTree = args.targetTree === undefined || args.targetTree === UNSET ? readTree(args.target) : args.targetTree
  if (current !== null && canonicalDigest(current) === canonicalDigest(finalTree)) return [null, []]

  const drift = foreignContent(args.path, TREE_REGION, currentDigest, desiredDigest, expected)
  if (drift !== null) return [null, [drift]]

  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'symlink',
      region: TREE_REGION,
      expectedDigest: currentDigest,
      target: args.target,
      summary: args.summary || `${args.path} -> ${args.target}`,
      cliKind: args.cliKind ?? '',
      skillsRoot: args.skillsRoot ?? null,
      skillSlug: args.skillSlug ?? null,
      fallbackCopy: true,
    }),
    [],
  ]
}

interface PlanDeleteArgs {
  home: string
  path: string
  manifest: Manifest
  cliKind?: string
  skillsRoot?: string | null
  skillSlug?: string | null
  summary?: string
}

/** Borra algo que el hub creó. Si la persona lo modificó, se reporta y se deja. */
export function planDelete(args: PlanDeleteArgs): PlanOutcome {
  const current = readRegion(args.path, TREE_REGION)
  const currentDigest = canonicalDigest(current)
  const expected = args.manifest.digestFor(args.path, TREE_REGION)

  if (currentDigest !== null && expected !== null && currentDigest !== expected) {
    return [
      null,
      [
        driftItem(
          args.path,
          regionLabel(TREE_REGION),
          'se iba a borrar porque salió del snapshot, pero está modificado; se deja como está',
          expected,
          currentDigest,
        ),
      ],
    ]
  }

  return [
    makeChange({
      home: args.home,
      path: args.path,
      action: 'delete',
      region: TREE_REGION,
      expectedDigest: currentDigest,
      summary: args.summary || `borrar ${args.path}`,
      cliKind: args.cliKind ?? '',
      skillsRoot: args.skillsRoot ?? null,
      skillSlug: args.skillSlug ?? null,
    }),
    [],
  ]
}

/** Compara lo que el manifiesto dice que el hub dejó contra lo que hay en disco. */
export function detectDrift(home: string, targets: ReadonlyArray<[string, ManagedRegion]>): DriftItem[] {
  const manifest = Manifest.load(home)
  const items: DriftItem[] = []
  for (const [path, r] of targets) {
    const expected = manifest.digestFor(path, r)
    if (expected === null) continue
    let found: string | null
    try {
      found = regionDigest(path, r)
    } catch (exc) {
      if (!(exc instanceof ConfigParseError)) throw exc
      items.push(driftItem(path, regionLabel(r), exc.message, expected, null))
      continue
    }
    if (found === null) {
      items.push(driftItem(path, regionLabel(r), 'la entrada que escribió el hub ya no está', expected, null))
    } else if (found !== expected) {
      items.push(driftItem(path, regionLabel(r), 'alguien editó a mano la entrada que gestiona el hub', expected, found))
    }
  }
  return items
}
