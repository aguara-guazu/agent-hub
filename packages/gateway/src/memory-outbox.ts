/** Durable local delivery. Only memory writes and Jira reads can be replayed; never Jira mutations. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import type { SnapshotView } from './policy.js'
import { type ConnectionPool, resultText } from './runtime.js'
import { isMemorySpec, issuesIn, JIRA_REREADS, siteFromResources } from './memory-bridge.js'

export interface MemoryDelivery {
  operation: 'sync_tasks' | 'finish_notes'
  args: Record<string, unknown>
  meta: Record<string, unknown>
  reread?: { server: string; tool: string; args: Record<string, unknown> }
  siteLookup?: { server: string; tool: string; cloudId: string }
}
interface Entry extends MemoryDelivery { id: string; attempts: number; available_at: number }
export const integrationDirectory = (stateDir: string, agentId: string) => join(stateDir, 'memory-delivery', createHash('sha256').update(agentId).digest('hex'))

export class MemoryOutbox {
  private running: Promise<void> | undefined
  constructor(readonly directory: string) {}
  async watch(onChange: () => void): Promise<FSWatcher> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return watch(this.directory, { persistent: false }, (_event, name) => { if (name?.endsWith('.json')) onChange() })
  }
  async enqueue(delivery: MemoryDelivery): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const entry: Entry = { ...delivery, id: randomUUID(), attempts: 0, available_at: 0 }
    await this.save(entry)
    return entry.id
  }
  private async save(entry: Entry) {
    const path = join(this.directory, `${entry.id}.json`), temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600 })
    await rename(temp, path)
  }
  async pending(): Promise<number> { return (await readdir(this.directory).catch(() => [])).filter(n => /^[\da-f-]{36}\.json$/.test(n)).length }
  async has(id: string): Promise<boolean> { return readFile(join(this.directory, `${id}.json`)).then(() => true, () => false) }
  flush(view: () => SnapshotView, pool: ConnectionPool): Promise<void> {
    this.running ??= this.drain(view, pool).finally(() => { this.running = undefined })
    return this.running
  }
  private async drain(view: () => SnapshotView, pool: ConnectionPool) {
    const names = (await readdir(this.directory).catch(() => [])).filter(n => /^[\da-f-]{36}\.json$/.test(n)).sort()
    for (const name of names) {
      const path = join(this.directory, name), lock = `${path}.lock`
      try { await mkdir(lock); await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 }) }
      catch {
        // Another gateway or the daemon owns this delivery. Recover only after that process exits.
        try {
          const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(lock, { recursive: true, force: true }) }
          }
        } catch {
          // A crash between mkdir and writing pid must not strand the delivery forever.
          const info = await stat(lock).catch(() => undefined)
          if (info && Date.now() - info.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true })
        }
        continue
      }
      let entry: Entry | undefined
      try {
        entry = JSON.parse(await readFile(path, 'utf8')) as Entry
        if (entry.available_at > Date.now()) continue
        const current = view()
        const memory = current.upstreams().find(isMemorySpec)
        if (!memory || !current.tools.some(t => t.serverSlug === memory.slug && t.toolName === entry!.operation)) continue
        if (!['sync_tasks', 'finish_notes'].includes(entry.operation)) continue
        const args = { ...entry.args }
        if (entry.siteLookup) {
          const lookup = entry.siteLookup
          if (lookup.tool.toLowerCase() !== 'getaccessibleatlassianresources') continue
          const spec = current.upstreams().find(s => s.slug === lookup.server)
          if (!spec || !current.tools.some(t => t.serverSlug === lookup.server && t.toolName === lookup.tool)) continue
          const resources = await pool.callTool(current.agentInstanceId, spec, lookup.tool, {})
          const site = siteFromResources(resources, lookup.cloudId)
          if (resources.is_error || !site) throw new Error('jira_site')
          args['site_url'] = site
        }
        if (entry.reread) {
          const read = entry.reread
          if (!JIRA_REREADS.includes(read.tool.toLowerCase())) continue
          const spec = current.upstreams().find(s => s.slug === read.server)
          if (!spec || !current.tools.some(t => t.serverSlug === read.server && t.toolName === read.tool)) continue
          const fresh = await pool.callTool(current.agentInstanceId, spec, read.tool, read.args)
          const issues = issuesIn(fresh)
          if (fresh.is_error || !issues.length) throw new Error('jira_read')
          args['issues'] = issues
        }
        const result = await pool.callTool(current.agentInstanceId, memory, entry.operation, args, entry.meta)
        if (result.is_error) throw new Error('memory_write')
        if (entry.operation === 'sync_tasks') {
          const summary = result.structured_content ?? JSON.parse(resultText(result)) as Record<string, unknown>
          if (Number(summary['invalid']) > 0 || (Array.isArray(summary['unmatched']) && summary['unmatched'].length)) throw new Error('unmatched')
        }
        await rm(path, { force: true })
      } catch {
        if (entry) { entry.attempts++; entry.available_at = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(entry.attempts - 1, 6)); await this.save(entry).catch(() => undefined) }
      } finally { await rm(lock, { recursive: true, force: true }) }
    }
  }
}
