/** Coordination surfaces controlled by the global collaboration switch. Memory stays available. */
export function isCollaborationTool(name: string): boolean {
  return name.startsWith('chat_') || name.startsWith('team_') || ['send_message', 'read_messages', 'ack_message', 'claim_work'].includes(name)
}
export function isCollaborationSkill(slug: string): boolean {
  return ['local-collaboration', 'hub-collaboration'].includes(slug)
}
