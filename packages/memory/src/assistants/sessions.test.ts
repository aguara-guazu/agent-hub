import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { MemoryDatabase } from '../database.js'
import { MemoryError } from '../contracts.js'
import { MemoryStore } from '../store.js'
import { AssistantSessions } from './sessions.js'
import type { runAssistantTerminal } from './terminal.js'

it('persiste y serializa cada conversación nativa por asunto y respeta cambios de terminal y modelo', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-assistant-sessions-')))
  const db = new MemoryDatabase(join(dir, 'test.sqlite'))
  try {
    await db.migrate()
    const project = (await new MemoryStore(db, dir).create({ kind: 'project', title: 'Atlas' })).id
    const close = vi.fn()
    const openTeams = vi.fn(async () => ({ env: { TEST_SCOPE: project }, guidance: 'Coordiná este proyecto.', close }))
    const terminal = vi.fn<typeof runAssistantTerminal>(async input => ({
      value: { reply: 'Respuesta' }, inputTokens: 12, outputTokens: 6, sessionId: input.sessionId || randomUUID(),
    }))
    const params = { provider: 'claude_code' as const, model: 'elegido', effort: 'high', prompt: 'Consulta', schema: {}, signal: new AbortController().signal }
    const sessions = new AssistantSessions(db, terminal, { openTeams })
    const ask = (conversation: string) => sessions.run(project, '', { conversation }, params)
    const [first, second, other] = await Promise.all([ask('case/a'), ask('case/a'), ask('case/b')])
    expect(first.sessionId).toBe(second.sessionId)
    expect(other.sessionId).not.toBe(first.sessionId)
    expect(terminal.mock.calls.map(([i]) => i.sessionId)).toContain(first.sessionId)
    expect(terminal.mock.calls[0]![0]).toMatchObject({ cwd: join(dir, 'assistant-workspaces', project), model: 'elegido', effort: 'high', env: { TEST_SCOPE: project } })
    expect(close).toHaveBeenCalledTimes(3)
    const restored = new AssistantSessions(db, terminal, { openTeams })
    expect((await restored.run(project, '', { conversation: 'case/a' }, params)).sessionId).toBe(first.sessionId)
    expect((await restored.run(project, '', { conversation: 'case/a' }, { ...params, model: 'otro' })).sessionId).not.toBe(first.sessionId)
    const count = openTeams.mock.calls.length
    await restored.run(project, '', { conversation: 'portfolio', team: false }, params)
    expect(openTeams).toHaveBeenCalledTimes(count)
    expect(terminal.mock.lastCall![0]).not.toHaveProperty('env')
    terminal.mockRejectedValueOnce(new MemoryError(404, 'El historial nativo caducó', false, 'assistant_session_missing'))
    await restored.run(project, '', { conversation: 'case/b' }, params)
    expect(terminal.mock.lastCall![0]).not.toHaveProperty('sessionId')
    const attempts = terminal.mock.calls.length
    terminal.mockRejectedValueOnce(new Error('Error después de haber usado una herramienta'))
    await expect(restored.run(project, '', { conversation: 'case/b' }, params)).rejects.toThrow('Error después')
    expect(terminal).toHaveBeenCalledTimes(attempts + 1)
  } finally {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
