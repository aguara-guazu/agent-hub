import { effectiveCapability, resumeSurface, restorableNativeId, type CapabilityStatus, type InstalledEvidence, type ResumeCapabilityName } from './resume-capabilities.js'

/**
 * live_destination: the creator's chat is the delivery target; no run starts inside its turn.
 * fork: separate continuation from a copy of the history.
 * exclusive_resume: same conversation, only when the adapter guarantees a single writer.
 * linked_new: fresh conversation linked to the origin.
 * blocked_unsupported: the restricted profile cannot be verified, so nothing is launched.
 */
export type ResumeRung = 'live_destination' | 'fork' | 'exclusive_resume' | 'linked_new' | 'blocked_unsupported'
/** launch_uncertain follows an attempted fork/resume/start without confirmation; no other rung may be tried afterwards. */
export type ResumeOutcome = 'launched' | 'launch_uncertain' | 'failed'

export interface ResumeOrigin {
  native_id: string | null
  cli: string
  surface: string
  cwd: string | null
  /** The creator's conversation is connected and can receive the delivery. */
  live: boolean
  /** The ID came from a hook or protocol receipt, never from inference or a catalog. */
  id_authentic: boolean
  project_id?: string | null
  account?: string | null
}
export interface ResumeTarget {
  cli: string
  surface: string
  cwd: string
  headless: boolean
  profile: { restricted: boolean; verified: boolean }
  project_id?: string | null
  account?: string | null
}
/** Diagnostic only: absence of a process, lease or Watch never proves that nobody else can write to the session. */
export interface OriginObservation { process_alive?: boolean | null; lease_active?: boolean | null; watch_active?: boolean | null }
export interface ResumePlan {
  rung: ResumeRung
  reason: string
  /** Why each better rung was skipped, in ladder order. */
  downgrades: string[]
  evidence: string[]
  native_id?: string
  headless?: boolean
}

const samePath = (a: string, b: string) => {
  const clean = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return process.platform === 'linux' ? clean(a) === clean(b) : clean(a).toLowerCase() === clean(b).toLowerCase()
}

/** Pure and inference-free: the same inputs always produce the same rung and the same reasons. */
export function planResume(origin: ResumeOrigin, target: ResumeTarget, installed?: InstalledEvidence, observed: OriginObservation = {}): ResumePlan {
  const downgrades: string[] = []
  const evidence = [`origin:${origin.cli}/${origin.surface}`, `target:${target.cli}/${target.surface}`]
  for (const [name, value] of Object.entries(observed)) if (value !== undefined && value !== null) evidence.push(`${name}=${value}`)
  if (origin.live) return { rung: 'live_destination', reason: 'creator_chat_live', downgrades, evidence }
  if (target.profile.restricted && !target.profile.verified) return { rung: 'blocked_unsupported', reason: 'profile_unverifiable', downgrades, evidence }

  const originSurface = resumeSurface(origin.cli, origin.surface), targetSurface = resumeSurface(target.cli, target.surface)
  const status = (name: ResumeCapabilityName): CapabilityStatus => effectiveCapability(targetSurface?.capabilities[name], installed)
  const incompatible: string[] = []
  if (!origin.id_authentic || !restorableNativeId(origin.native_id)) incompatible.push('no_authentic_id')
  if (!originSurface || !targetSurface || originSurface.id_namespace !== targetSurface.id_namespace) incompatible.push('id_namespace_mismatch')
  if (!origin.cwd || !samePath(origin.cwd, target.cwd)) incompatible.push('cwd_incompatible')
  if (origin.project_id && target.project_id && origin.project_id !== target.project_id) incompatible.push('project_mismatch')
  if (origin.account && target.account && origin.account !== target.account) incompatible.push('account_mismatch')
  if (incompatible.length) return { rung: 'linked_new', reason: incompatible[0]!, downgrades: [...incompatible], evidence }

  const nativeId = origin.native_id!
  const forkName: ResumeCapabilityName = target.headless ? 'fork_headless' : 'fork_interactive'
  const fork = status(forkName)
  if (fork === 'supported') return { rung: 'fork', reason: forkName, downgrades, evidence, native_id: nativeId, headless: target.headless }
  downgrades.push(`${forkName}_${fork}`)

  const resume = status('resume_by_id'), headless = target.headless ? status('headless_resume') : 'supported', lock = status('exclusive_resume')
  const active = observed.process_alive === true || observed.lease_active === true || observed.watch_active === true
  if (resume === 'supported' && headless === 'supported' && lock === 'supported' && !active) {
    return { rung: 'exclusive_resume', reason: 'adapter_exclusive_resume', downgrades, evidence, native_id: nativeId, headless: target.headless }
  }
  if (resume !== 'supported') downgrades.push(`resume_by_id_${resume}`)
  if (headless !== 'supported') downgrades.push(`headless_resume_${headless}`)
  if (lock !== 'supported') downgrades.push(`exclusive_resume_${lock}`)
  if (active) downgrades.push('origin_possibly_active')
  return { rung: 'linked_new', reason: 'no_fork_or_exclusive_resume', downgrades, evidence }
}
