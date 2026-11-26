import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { api } from "../../lib/api"
import type { CaseRow, Evidence, NoticeEntry, PortfolioPolicy, Profile, Role } from "@agenthub/shared/assistants"
import type { ChipTone } from "../../components/ui"

export interface Project {
  id: string
  title: string
  active: boolean
  last_scan: string | null
  last_error: string | null
}
export interface SettingsData {
  project_id: string
  title: string
  config: Profile
  version: number
  last_scan: string | null
  last_error: string | null
  connectors: { id: string; name: string; channels: string[] }[]
  estimates: { role: Role; model: string; samples: number; median_tokens: number | null }[]
}
export type Issue = CaseRow & { project_title?: string }
export interface ChatMessage {
  seq: number
  role: Role | "owner"
  body: string
  evidence: Evidence[]
  created_at: string
  case_id?: string | null
  case_title?: string | null
}
export interface Discussion {
  item: CaseRow | null
  messages: ChatMessage[]
}
export interface Work {
  project_id: string
  project_title?: string
  id: string
  case_id?: string | null
  role: Role
  objective: string
  state: "queued" | "running" | "done" | "cancelled" | "blocked" | "paused"
  updated_at?: string
  result: {
    summary: string
    sha?: string
    base?: string
    worktree?: string
    criteria?: string[]
    missing?: string[]
    verification?: string[]
  } | null
}
export interface PortfolioSettings {
  version: number
  config: PortfolioPolicy
}
export interface InboxPage {
  items: Issue[]
  has_more: boolean
  total: number
  urgent: number
  important: number
}
/** `local`: followed projects hold material that an external model may not read; `disabled`: no model at all. */
export interface ModelStatus {
  gap: "disabled" | "local" | null
  projects: number
}
export type View = "attention" | "history" | "work"
export type Band = "urgent" | "important" | "low"

export const PAGE_SIZE = 60
export const band = (score: number): Band => (score >= 8 ? "urgent" : score >= 5 ? "important" : "low")
export const scoreTone = (score: number): ChipTone => (score >= 8 ? "danger" : score >= 5 ? "warn" : "info")
export const ownerDismissed = (issue: CaseRow) => issue.state === "closed" && !!issue.source?.owner_dismissed

export function usePolicy() {
  return useQuery({ queryKey: ["assistants", "policy"], queryFn: () => api.get<PortfolioSettings>("/assistants/settings") })
}
export function useProjects() {
  return useQuery({
    queryKey: ["assistants", "projects"],
    queryFn: () => api.get<{ items: Project[]; model?: ModelStatus }>("/assistants/projects"),
    refetchInterval: 15000,
  })
}
export function useProfile(project: string) {
  return useQuery({
    queryKey: ["assistants", "settings", project],
    enabled: !!project,
    queryFn: () => api.get<SettingsData>("/assistants/projects/" + project),
  })
}
const inboxPath = (project: string, state: "attention" | "history", search: string, limit: number, offset: number) =>
  "/assistants/inbox?" +
  new URLSearchParams({
    ...(project ? { project } : {}),
    ...(search ? { q: search } : {}),
    state,
    limit: String(limit),
    offset: String(offset),
  })
export function useInbox(project: string, state: "attention" | "history", search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["assistants", "inbox", project, state, search],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<InboxPage>(inboxPath(project, state, search, PAGE_SIZE, pageParam)),
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((count, p) => count + p.items.length, 0) : undefined),
    refetchInterval: 10000,
  })
}
/** Open issues of the whole inbox or of one project, whatever view or search is on screen. */
export function usePendingCount(project: string) {
  return useQuery({
    queryKey: ["assistants", "inbox", project, "count"],
    queryFn: () => api.get<InboxPage>(inboxPath(project, "attention", "", 1, 0)),
    refetchInterval: 10000,
    select: (page) => page.total,
  })
}
export function useNotice(id: string | null) {
  return useQuery({
    queryKey: ["assistants", "notice", id],
    enabled: !!id,
    queryFn: () => api.get<{ entries: NoticeEntry[] }>("/assistants/notices/" + id),
    refetchInterval: 15000,
  })
}
export function useIssue(id: string | undefined) {
  return useQuery({
    queryKey: ["assistants", "case", id],
    enabled: !!id,
    queryFn: () => api.get<Discussion>("/assistants/cases/" + id),
    refetchInterval: 5000,
    select: (discussion) => discussion.item,
  })
}
export function useWork(project: string) {
  return useQuery({
    queryKey: ["assistants", "work", project],
    queryFn: () => api.get<{ items: Work[]; total: number; blocked: number }>("/assistants/work" + (project ? "/" + project : "")),
    refetchInterval: 8000,
  })
}
export function useChat() {
  return useQuery({
    queryKey: ["assistants", "chat"],
    queryFn: () => api.get<Discussion>("/assistants/chat"),
    refetchInterval: 15000,
  })
}
export function safeLink(value: unknown) {
  return typeof value === "string" && (/^https:\/\//i.test(value) || /^\/#\/(?:memory|projects)\//.test(value)) ? value : undefined
}
