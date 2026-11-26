import { z } from 'zod'
const id = z.string().uuid()

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const zone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v })
      return true
    } catch {
      return false
    }
  })
export const role = z.enum(['secretary', 'pm', 'developer'])
export type Role = z.infer<typeof role>
export const watch = z
  .object({
    connector_id: id,
    channel: z.string().regex(/^[CG][A-Z0-9]{2,30}$/),
    owner: z.string().regex(/^[UW][A-Z0-9]{2,30}$/),
    team: z.string().regex(/^T[A-Z0-9]{2,30}$/),
    colleagues: z
      .array(z.string().regex(/^[UW][A-Z0-9]{2,30}$/))
      .max(100)
      .default([]),
  })
  .strict()
export type Watch = z.infer<typeof watch>
const profileFields = z
  .object({
    active: z.boolean().default(false),
    delay_minutes: z.number().int().min(1).max(240).default(10),
    timezone: zone.default(Intl.DateTimeFormat().resolvedOptions().timeZone),
    start: hhmm.default('09:00'),
    end: hhmm.default('18:00'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
    threshold: z.number().int().min(1).max(10).default(5),
    night_work: z.boolean().default(true),
    keep_awake: z.boolean().default(false),
    daily_turns: z.number().int().min(1).max(500).default(24),
    slack: z.array(watch).max(30).default([]),
    github_repos: z
      .array(z.string().regex(/^[\w-]+\/[\w.-]+$/))
      .max(12)
      .default([]),
    jira_owner: z.string().max(180).default(''),
    style: z.string().trim().max(2000).default(''),
    repository: z.string().max(2000).default(''),
    files: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    verify: z.array(z.string().min(1).max(400)).max(24).default([]),
  })
  .strict()
const differentHours = (p: { start: string; end: string }) => p.start !== p.end
const hoursMessage = 'El horario debe tener un inicio y un fin distintos'
export const profile = profileFields.refine(differentHours, hoursMessage)
export const noticeSettings = z
  .object({
    pause_in_meetings: z.boolean().default(true),
    adaptive_cooldown: z.boolean().default(true),
    interrupt_severity: z.number().int().min(1).max(10).nullable().default(9),
    cooldown_minutes: z.number().int().min(1).max(180).default(15),
    reminder_minutes: z.number().int().min(5).max(240).default(30),
    daily_limit: z.number().int().min(1).max(4).default(3),
  })
  .strict()
export const portfolioPolicy = profileFields
  .pick({
    delay_minutes: true,
    threshold: true,
    timezone: true,
    start: true,
    end: true,
    weekdays: true,
    night_work: true,
    keep_awake: true,
    daily_turns: true,
    style: true,
  })
  .extend({ notifications: noticeSettings.prefault({}) })
  .refine(differentHours, hoursMessage)
export type PortfolioPolicy = z.infer<typeof portfolioPolicy>
export type Profile = z.infer<typeof profile>
export const textInput = z.string().trim().min(1).max(4000)
export interface Evidence {
  id: string
  title: string
  text: string
  url: string
  at: string
  remote: boolean
}
export interface Signal {
  key: string
  kind: 'slack' | 'jira' | 'meeting' | 'pr'
  title: string
  text: string
  at: string
  url: string
  score: number
  reasons: string[]
  fingerprint: string
  source: Record<string, any>
}
export interface CaseRow {
  id: string
  project_id: string
  source_key: string
  kind: Signal['kind']
  title: string
  score: number
  reason: string
  state: 'open' | 'handled' | 'sent' | 'sending' | 'uncertain' | 'closed'
  source: Signal['source']
  evidence: Evidence[]
  fingerprint: string
  draft: string | null
  revision: number
  send_id: string | null
  receipt: string | null
  updated_at: string
}

export interface NoticeEntry {
  id: string
  project_id: string
  project: string
  revision: number
  kind: Signal['kind'] | 'work'
  source: string
  title: string
  reason: string
  suggestion: string
  url: string
  route: string
  severity: number
  priority: number
  calendar: string | null
}
export interface AssistantNotice {
  id: string
  revision: number
  delivery_id: string
  route: string
  title: string
  body: string
  pending_count: number
  entries: NoticeEntry[]
}
