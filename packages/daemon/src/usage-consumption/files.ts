import { open } from 'node:fs/promises'
import type { ConsumptionEvent } from '@agenthub/shared'

/** Events read from one session file plus the cursor to store after they are sent. */
export interface SessionReadResult {
  events: ConsumptionEvent[]
  cursor: { file_path: string; file_offset: number; scan_state: unknown }
}

/** Non-negative finite numbers only; anything else counts as zero. */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }

export function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : []
}

/** Length of text in a string or a list of text blocks. The text itself is never kept. */
export function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length
  return blocks(content).reduce((total, block) => total + (typeof block.text === 'string' ? block.text.length : 0), 0)
}

export function parseLine(line: string): Record<string, any> | null {
  try {
    const row = JSON.parse(line) as unknown
    return row && typeof row === 'object' ? (row as Record<string, any>) : null
  } catch {
    return null
  }
}

/**
 * Reads complete lines from `offset`. A file smaller than the offset was truncated or replaced,
 * so the read restarts at zero. The returned offset never points inside a line.
 */
export async function readFrom(path: string, offset: number): Promise<{ text: string; offset: number; restarted: boolean }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const restarted = size < offset
    const start = restarted ? 0 : offset
    const length = size - start
    const buffer = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const end = buffer.subarray(0, filled).lastIndexOf(0x0a)
    if (end < 0) return { text: '', offset: start, restarted }
    return { text: buffer.subarray(0, end).toString('utf8'), offset: start + end + 1, restarted }
  } finally {
    await handle.close()
  }
}
