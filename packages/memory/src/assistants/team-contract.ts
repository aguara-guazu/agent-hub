export const residentTeamOperations = ['list', 'catalog', 'prepare', 'launch', 'status', 'read', 'message', 'control', 'answer', 'close'] as const
export type ResidentTeamOperation = typeof residentTeamOperations[number]
