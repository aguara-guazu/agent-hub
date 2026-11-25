import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const suites = {
  connections: ['packages/memory/test/connectors', 'packages/memory/test/google-', 'packages/memory/test/gmail-', 'packages/core/test/jira-server-route'],
  agents: ['packages/memory/test/local-chat', 'packages/memory/test/chat-read-access', 'packages/memory/test/team-', 'packages/memory/test/fleet-', 'packages/memory/test/usage-'],
  memory: ['packages/memory/test/remember', 'packages/memory/test/memory.test', 'packages/memory/test/global-search', 'packages/memory/test/project-assistance', 'packages/memory/test/attachments', 'packages/memory/test/work-tracking'],
  mcp: ['packages/core/test/probe', 'packages/core/test/oauth', 'packages/gateway/src/server.test', 'packages/gateway/src/tool-schema', 'packages/gateway/src/memory-bridge'],
  skills: ['packages/core/test/skill-sync', 'packages/memory/test/skill.test', 'packages/daemon/src/adapters/skills.test'],
  transcriptions: ['desktop/src/modules/transcriptions/', 'packages/memory/test/media-', 'packages/memory/test/recording-', 'packages/memory/test/transcript', 'packages/memory/test/diarization-'],
  schedules: ['desktop/src/modules/schedules/', 'packages/memory/test/schedule-', 'packages/memory/test/project-automation', 'packages/core/test/automations', 'packages/core/test/effects-schedule'],
  sharing: ['packages/memory/test/sharing.test'],
}

const [id, ...options] = process.argv.slice(2)
if (!Object.hasOwn(suites, id)) {
  console.error('Elegí un módulo con npm run test:module -- <id>. Disponibles: ' + Object.keys(suites).join(', '))
  process.exitCode = 2
} else {
  const require = createRequire(import.meta.url)
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const result = spawnSync(process.execPath, [vitest, 'run', '--exclude', '**/dist/**', ...suites[id], ...options], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
