import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { MemoryDatabase } from '../database.js'
import { MemoryError } from '../contracts.js'
import type { OpenResidentTeams } from './teams.js'
import { runAssistantTerminal } from './terminal.js'

export interface AssistantTurn {
  /** Marks an explicit owner request in the local usage history. */
  owner?: boolean
  /** A stable case, microtask, project or portfolio conversation. Background assessments are independent turns. */
  conversation?: string
  team?: boolean
  /** The validated worktree allocated to a development microtask. */
  worktree?: string
}

type TerminalInput = Parameters<typeof runAssistantTerminal>[0]
export interface AssistantTerminalPorts {
  openTeams?: OpenResidentTeams | undefined
  kiroKey?: () => string | undefined
  readTools?: ((provider: TerminalInput['provider']) => string[]) | undefined
}

async function workspace(db: MemoryDatabase, project: string, configured: string, shared: boolean) {
  if (!shared) {
    const folders = await db.query<{ path: string }>(
      `SELECT repo_path AS path FROM project_repositories WHERE project_id=$1
       UNION SELECT f.value AS path FROM entities e,json_each(e.data,'$.folders') f WHERE e.id=$1 AND f.type='text'
       ORDER BY path`, [project],
    )
    const paths = folders.map(r => r.path)
    if (paths.includes(configured)) paths.unshift(configured)
    for (const path of paths) {
      if (isAbsolute(path) && (await stat(path).catch(() => null))?.isDirectory()) return realpath(path)
    }
  }
  const cwd = join(db.directory, 'assistant-workspaces', shared ? 'portfolio' : project)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  return realpath(cwd)
}

export class AssistantSessions {
  private turns = new Map<string, Promise<unknown>>()

  constructor(private db: MemoryDatabase, private terminal = runAssistantTerminal, private ports: AssistantTerminalPorts = {}) {}

  run(project: string, repository: string, turn: AssistantTurn, input: Omit<TerminalInput, 'cwd' | 'sessionId' | 'env'>) {
    const key = JSON.stringify([project, turn.conversation])
    const execute = async () => {
      input.signal.throwIfAborted()
      const cwd = turn.worktree ?? await workspace(this.db, project, repository, turn.team === false)
      const previous = turn.conversation && (await this.db.query<{ native_id: string }>(
        'SELECT native_id FROM assistant_terminal_sessions WHERE project_id=$1 AND conversation=$2 AND provider=$3 AND model=$4 AND effort=$5 AND cwd=$6',
        [project, turn.conversation, input.provider, input.model, input.effort, cwd],
      ))[0]?.native_id
      const teams = turn.team === false ? undefined : await this.ports.openTeams?.(project, cwd, input.signal)
      const kiroKey = input.provider === 'kiro' ? this.ports.kiroKey?.() : undefined
      const env = { ...teams?.env }
      if (kiroKey) env.KIRO_API_KEY = kiroKey
      const params = {
        ...input, cwd,
        ...(Object.keys(env).length ? { env } : {}),
        readTools: this.ports.readTools?.(input.provider) ?? [],
        prompt: teams ? teams.guidance + '\n\n' + input.prompt : input.prompt,
      }
      try {
        let result
        try {
          result = await this.terminal({ ...params, ...(previous ? { sessionId: previous } : {}) })
        } catch (error) {
          // A rejected resume did not start a turn. The Hub transcript in the prompt can seed its replacement.
          if (!previous || !(error instanceof MemoryError) || error.code !== 'assistant_session_missing') throw error
          input.signal.throwIfAborted()
          result = await this.terminal(params)
        }
        input.signal.throwIfAborted()
        if (turn.conversation && result.sessionId) await this.db.query(
          `INSERT INTO assistant_terminal_sessions(project_id,conversation,provider,model,effort,cwd,native_id) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(project_id,conversation) DO UPDATE SET provider=excluded.provider,model=excluded.model,effort=excluded.effort,cwd=excluded.cwd,native_id=excluded.native_id`,
          [project, turn.conversation, input.provider, input.model, input.effort, cwd, result.sessionId],
        )
        return result
      } finally { teams?.close() }
    }
    if (!turn.conversation) return execute()
    const next = (this.turns.get(key) ?? Promise.resolve()).then(execute, execute)
    this.turns.set(key, next)
    return next.finally(() => { if (this.turns.get(key) === next) this.turns.delete(key) })
  }
}
