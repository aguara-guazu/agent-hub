/** Orca exports a stable workspace identity to every terminal and its children.
 * Never use a terminal handle: siblings in the same workspace must share a channel.
 */
export function orcaWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ORCA_WORKTREE_ID
  return value && value.length <= 4000 && /^(?:folder:[a-f0-9-]{36}|[a-f0-9-]{36}::[^\r\n]+)$/i.test(value) ? value : undefined
}
