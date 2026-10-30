import { z } from "zod"
import { CHAT_MESSAGE_KINDS } from "@agenthub/shared"

/** Sessions that are not agents: excluded from participant counts, mentions and agent listings. */
export const NON_AGENT_CLI_KINDS = ["hub"] as const
const nonAgent = NON_AGENT_CLI_KINDS.map(kind => `'${kind}'`).join(",")
export const AUTHOR_SOURCE_SQL = "CASE WHEN s.agent_id='agenthub-system' AND s.cli_kind='hub' THEN 'hub' ELSE 'agent' END"

/** Optional stance label of an agent message; the Hub only stores and shows it. */
export const messageKind = z.enum(CHAT_MESSAGE_KINDS)

/** SQL column for `chat_threads` items (alias t = thread): distinct agent authors, excluding the Hub. */
export const THREAD_AGENT_COUNT_COLUMN = `(SELECT count(DISTINCT m.author_id) FROM chat_messages m JOIN chat_sessions a ON a.id=m.author_id
  WHERE m.thread_id=t.id AND a.cli_kind NOT IN (${nonAgent})) AS agent_count`
export const agentCountField = <T extends Record<string, any>>(row: T) => ({ ...row, agent_count: Number(row.agent_count ?? 0) })
