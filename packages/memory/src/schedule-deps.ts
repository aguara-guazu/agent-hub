import type { AttentionReaders, CollectDeps, ScheduleAutomation } from './schedule-contract.js'

/**
 * Collect dependencies of one run. Evaluated on every run so effects the core injects after the service is built are seen as soon as they exist.
 * Later sources win: the readers of the schedule core, then those of the project automation, then the ones the core exposes over the decision store.
 */
export function scheduleDeps(own: AttentionReaders, project: { attentionReaders(): AttentionReaders }, automation: ScheduleAutomation): Omit<CollectDeps, 'store' | 'now'> {
  const { effects } = automation
  return { attention: { ...own, ...project.attentionReaders(), ...effects?.attention }, ...(effects?.jira ? { jira: effects.jira } : {}) }
}
