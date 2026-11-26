import { z } from 'zod'
import { collectClose, renderClose, closeSynthesisSchema } from '../daily-close.js'
import { proposedItems } from '../daily-templates.js'
import type { AttentionReaders, JiraGuard } from '../schedules/schedule-contract.js'
import type { MemoryStore } from '../store.js'
import { digest } from './slack.js'

export const compareInput = z
  .object({
    current: closeSynthesisSchema.nullable().default(null),
    proposed: closeSynthesisSchema.nullable().default(null),
    delivery: z
      .array(z.enum(['hub_inbox', 'app_window', 'gmail_self', 'slack_self']))
      .max(4)
      .optional(),
  })
  .strict()
export async function compareClose(
  store: MemoryStore,
  project: string,
  now: Date,
  statusProjects: () => Promise<string[]>,
  readers: AttentionReaders,
  jira: JiraGuard | undefined,
  input: z.infer<typeof compareInput>,
) {
  const live = await statusProjects()
  const activated = (await readers.activated_projects?.()) ?? []
  const pkg = await collectClose(
    {
      store,
      now: () => now,
      statusProjects: async () => live.filter((id) => id === project),
      ...(jira ? { jira } : {}),
      attention: {
        activated_projects: async () => activated.map((p) => p.project_id ?? p.ref).filter((id) => id === project),
        push_candidates: async () => proposedItems(((await readers.push_candidates?.()) ?? []).filter((p) => p.project_id === project)),
      },
    },
    { scheduledFor: now.toISOString() },
  )
  const [schedule] = await store.db.query(
    "SELECT delivery FROM schedules WHERE template='daily_close' AND state='active' ORDER BY updated_at DESC LIMIT 1",
  )
  const snapshot = digest(pkg)
  function preview(synthesis: z.infer<typeof closeSynthesisSchema> | null, delivery: string[]) {
    const draft = renderClose(pkg, synthesis, null, snapshot)
    return { title: draft.title, body: draft.body_md, items: draft.items, effects: draft.proposed_effects, delivery }
  }
  const targets = schedule?.delivery ?? []
  return {
    snapshot,
    at: now.toISOString(),
    gaps: pkg.gaps,
    current: preview(input.current, targets),
    proposed: preview(input.proposed, input.delivery ?? targets),
    external_sends: 0,
  }
}
