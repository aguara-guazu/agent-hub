import { z } from 'zod'
import { repositorySnapshot } from './project-automation.js'

/** Policy of one delegated repository exactly as the delegation version in force fixed it; the push executor never reads limits from the approved item. */
export interface DelegatedPushPolicy {
  project_id: string
  repo_id: string
  repo_path: string
  policy: { canonical_remote_url: string; default_branch: string; allowed_branches: string[]; remote_name: string }
}

const stored = z.object({ item_kinds: z.array(z.string()), repositories: z.array(repositorySnapshot) }).loose()

/**
 * Resolves the repository against the project's delegation in force: automation enabled, version not revoked, `git_push` among the delegated kinds
 * and the repository part of that version's snapshot. Anything else is null, so a revoked or replaced delegation stops pushes already approved.
 */
export async function delegatedPushPolicy(db: { query(sql: string, params?: unknown[]): Promise<Array<Record<string, any>>> }, repoId: string): Promise<DelegatedPushPolicy | null> {
  const row = (await db.query(`SELECT r.project_id,d.document FROM project_repositories r JOIN project_automation a ON a.project_id=r.project_id AND a.enabled=1
    JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version AND d.revoked_at IS NULL WHERE r.id=$1`, [repoId]))[0]
  if (!row) return null
  const parsed = stored.safeParse(typeof row.document === 'string' ? JSON.parse(row.document) : row.document)
  if (!parsed.success || !parsed.data.item_kinds.includes('git_push')) return null
  const repository = parsed.data.repositories.find(entry => entry.repo_id === repoId)
  if (!repository) return null
  return { project_id: String(row.project_id), repo_id: repoId, repo_path: repository.repo_path,
    policy: { canonical_remote_url: repository.canonical_remote_url, default_branch: repository.default_branch, allowed_branches: repository.allowed_branches, remote_name: repository.remote_name } }
}
