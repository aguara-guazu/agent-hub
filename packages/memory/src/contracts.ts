import { z } from 'zod'

export const id = z.string().uuid()
export const jsonObject = z.record(z.string(), z.json())
export const kinds = ['company', 'project', 'person', 'meeting', 'event', 'document', 'message', 'issue', 'note', 'collection', 'fact'] as const
export const kindSchema = z.enum(kinds)
export type EntityKind = z.infer<typeof kindSchema>
export const instant = z.iso.datetime({ offset: true })
export const fieldsSchema = z.array(z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'entity', 'json']),
  required: z.boolean().default(false),
}).strict()).max(64).refine(fields => new Set(fields.map(f => f.key)).size === fields.length, 'Campos repetidos')
export type CollectionField = z.infer<typeof fieldsSchema>[number]

export const entityInput = z.object({
  kind: kindSchema,
  title: z.string().trim().min(1).max(500),
  data: jsonObject.default({}),
  project_ids: z.array(id).max(100).default([]),
}).strict()
export const entityPatch = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  data: jsonObject.optional(),
  expected_updated_at: instant.optional(),
}).strict()
export const linkInput = z.object({
  from_id: id, to_id: id, type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  data: jsonObject.default({}), evidence_ids: z.array(id).max(100).default([]),
}).strict().refine(v => v.from_id !== v.to_id, 'Una relación requiere dos entidades distintas')
export const participantInput = z.object({
  external_id: z.string().min(1).max(512), name: z.string().max(300),
  email: z.email().optional(), person_id: id.optional(),
  identity_verified: z.boolean().default(false),
  email_status: z.enum(['verified', 'missing', 'ambiguous', 'permission_required']).optional(),
  email_source: z.string().max(1000).optional(),
  email_candidates: z.array(z.email()).max(30).optional(),
}).strict()
export const fragmentInput = z.object({
  text: z.string().min(1).max(100_000),
  external_id: z.string().max(512).optional(),
  speaker: z.string().max(512).optional(),
  start_time: instant.optional(), end_time: instant.optional(),
  offset_ms: z.number().int().nonnegative().optional(),
  project_ids: z.array(id).max(100).optional(),
  metadata: jsonObject.default({}),
}).strict()
export const importInput = z.object({
  provider: z.enum(['manual', 'google', 'notion', 'slack', 'jira']).default('manual'),
  account: z.string().min(1).max(512).default('local'),
  external_id: z.string().min(1).max(1024),
  kind: z.enum(['meeting', 'event', 'document', 'message', 'issue', 'note']),
  title: z.string().trim().min(1).max(500),
  url: z.url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'URL HTTP requerida').optional(),
  occurred_at: instant.optional(),
  timezone: z.string().max(100).optional(),
  text: z.string().max(5_000_000).default(''),
  participants: z.array(participantInput).max(1000).default([]),
  fragments: z.array(fragmentInput).max(20_000).default([]),
  project_ids: z.array(id).max(100).default([]),
  metadata: jsonObject.default({}),
  original: z.json().optional(),
  connector_id: id.optional(),
}).strict()
export type ImportInput = z.infer<typeof importInput>
export const searchInput = z.object({
  query: z.string().trim().max(2000).default(''),
  project_id: id.optional(), person_id: id.optional(),
  /** Only fragments that belong to no project, for material not yet assigned (loose meetings, general notes). */
  unassigned: z.boolean().default(false),
  kind: kindSchema.optional(), provider: z.string().max(30).optional(),
  from: instant.optional(), to: instant.optional(),
  mode: z.enum(['hybrid', 'text', 'semantic']).default('hybrid'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict()
export type SearchInput = z.infer<typeof searchInput>
export const recordInput = z.object({
  values: jsonObject, evidence_ids: z.array(id).max(100).default([]),
  idempotency_key: z.string().min(1).max(512).optional(),
}).strict()
export const ruleInput = z.object({
  collection_id: id, name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(8000),
  project_ids: z.array(id).max(100).default([]),
  person_id: id.optional(), enabled: z.boolean().default(true),
}).strict()
export const connectorInput = z.object({
  provider: z.enum(['google', 'notion', 'slack', 'jira']),
  name: z.string().trim().min(1).max(200),
  config: jsonObject.default({}),
  project_ids: z.array(id).max(100).default([]),
  enabled: z.boolean().default(false),
  interval_minutes: z.number().int().min(5).max(1440).default(30),
}).strict()

export interface Entity {
  id: string; kind: EntityKind; title: string; data: Record<string, any>;
  created_at: string; updated_at: string
}
export interface Fragment {
  id: string; version_id: string; ordinal: number; text: string;
  speaker_id: string | null; start_time: string | null; end_time: string | null;
  offset_ms: number | null; metadata: Record<string, any>;
}
/** `transient` marks provider failures (overload, 5xx, rate limit, timeouts) that are retried with backoff instead of failing the job. */
export class MemoryError extends Error {
  constructor(readonly statusCode: number, message: string, readonly transient = false) { super(message); this.name = 'MemoryError' }
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new MemoryError(422, result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}
export function check(condition: unknown, message: string, code = 422): asserts condition {
  if (!condition) throw new MemoryError(code, message)
}
