/** Formas que devuelven las operaciones chat_* de /memory/call y GET /memory/teams/:id (packages/memory). */

export interface Channel {
  id: string
  name: string
  path: string
  branch: string | null
  threads: number
  team_plan_id?: string | null
  parent_channel_id?: string | null
  leader_id?: string | null
  orca_workspace_id?: string | null
  read_only?: boolean | null
  kind?: string
  closed_at?: string | null
  deleted_at?: string | null
}

export interface Participant {
  id: string
  channel_id: string
  label: string
  cli_kind: string
  state: string
  capability: string
  last_seen_at: string
  wake_error: string | null
  nickname?: string | null
  role?: string
  needs_nickname?: boolean
  connection_state?: string
  state_reason?: string | null
  state_observed_at?: string
  created_at?: string
  closed_at?: string | null
  removed_at?: string | null
  team_id?: string | null
  team_role?: string | null
  team_state?: string | null
  master_channel_id?: string | null
  work_thread_id?: string | null
}

export interface Thread {
  id: string
  channel_id: string
  channel_name: string
  title: string
  state: string
  messages: number
  preview: string
  author_label: string
  updated_at: string
  task_id: string | null
  pending_responses?: number
  awaiting_labels?: string
  participants?: string
  team_root_thread_id?: string | null
  team_plan_id?: string | null
  team_plan_state?: string | null
}

export interface Receipt {
  recipient_id: string
  label: string
  notified_at: string | null
  read_at: string | null
  handled_at: string | null
  attempts: number
  error: string | null
  cancelled_at?: string | null
  response_required?: number
  response_message_id?: string | null
  response_alerted_at?: string | null
}

export interface Message {
  id: string
  author_id: string
  author_label: string
  text: string
  created_at: string
  reply_to: string | null
  mentions: Receipt[]
}

export interface MemberUsage {
  worktree_name?: string
  cli: string
  model: string
  status: string
  reason?: string
}

export interface Member {
  id: string
  role: string
  task: string
  cli: string
  model: string
  prompt?: string
  effort?: string
  worktree_name?: string
  nickname?: string | null
  state?: string
  work_thread_id?: string
  workspace_path?: string
  session_id?: string | null
  runtime?: { state: string; updated_at?: string }
  work?: { status: string; summary: string; waiting_for?: string; updated_at: string } | null
  last_report?: { id: string; thread_id: string; text: string; created_at: string } | null
}

export interface Plan {
  id: string
  digest: string
  objective: string
  state: string
  root_thread_id?: string
  master_channel_id?: string
  parent: { path: string; kind?: string }
  base_revision: string
  plan: { permissions: string; members: Member[]; usage?: MemberUsage[]; usage_redacted?: boolean }
  members?: Member[]
  progress: { workspaces_created: number; processes_accepted: number; joined: number; total: number }
  authorization?: {
    source: string | null
    instruction: string | null
    coordinator_id: string
    approved_by_user_id: string | null
    delegation?: { project_id: string; version: number }
  }
  launch?: { started_at: string | null; accepted_at: string | null; instruction_declared: boolean }
  close?: { at: string | null; reason: string | null }
}
