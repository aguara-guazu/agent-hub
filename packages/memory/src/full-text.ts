interface Clause { positive: string[]; negative: string[] }

/** Web-search AND/OR/NOT precedence. FTS5 has no unary NOT, so complements use rowid sets. */
export function fullTextMatches(table: 'fragments' | 'entities', text: string, params: unknown[]): { sql: string; operators: boolean } {
  const clauses: Clause[] = [{ positive: [], negative: [] }]
  let pendingOr = false, operators = false
  for (const match of text.matchAll(/(-?)"([^"]*)"|(-?)([^\s"]+)/g)) {
    const quoted = match[2] !== undefined, raw = match[2] ?? match[4] ?? ''
    const negative = Boolean(match[1] || match[3])
    const current = clauses.at(-1)!
    if (!quoted && !negative && raw.toLowerCase() === 'or') {
      pendingOr = current.positive.length + current.negative.length > 0
      continue
    }
    const tokens = raw.match(/[\p{L}\p{N}_]+/gu)
    if (!tokens) continue
    if (pendingOr) { clauses.push({ positive: [], negative: [] }); operators = true; pendingOr = false }
    if (negative) operators = true
    const target = negative ? clauses.at(-1)!.negative : clauses.at(-1)!.positive
    // A quoted sequence is a phrase; unquoted punctuation separates ANDed words.
    if (quoted) target.push(`"${tokens.join(' ')}"`)
    else if (negative) target.push(`(${tokens.map(t => `"${t}"`).join(' AND ')})`)
    else target.push(...tokens.map(t => `"${t}"`))
  }
  const bind = (value: string) => { params.push(value); return `$${params.length}` }
  const fts = `${table}_fts`
  const branches = clauses.filter(c => c.positive.length || c.negative.length).map(clause => {
    const exclusion = clause.negative.length ? `rowid NOT IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ${bind(clause.negative.join(' OR '))})` : ''
    if (!clause.positive.length) return `SELECT rid,0 AS rank FROM ${table} WHERE ${exclusion.replace(/^rowid/, 'rid')}`
    return `SELECT rowid AS rid,-bm25(${fts}) AS rank FROM ${fts} WHERE ${fts} MATCH ${bind(clause.positive.join(' AND '))}${exclusion ? ` AND ${exclusion}` : ''}`
  })
  const sql = !branches.length ? 'SELECT NULL AS rid,0 AS rank WHERE 0' : branches.length === 1 ? branches[0]!
    : `WITH matches AS MATERIALIZED (${branches.join(' UNION ALL ')}) SELECT rid,max(rank) AS rank FROM matches GROUP BY rid`
  return { sql, operators }
}

/** Necessary substring condition for LIKE, including escaped wildcards. Short patterns scan normally. */
export function substringMatch(text: string): string | null {
  let longest = '', literal = ''
  const flush = () => { if (Array.from(literal).length > Array.from(longest).length) longest = literal; literal = '' }
  // Parse the actual LIKE pattern: a trailing escape in the query consumes its appended '%'.
  const chars = Array.from(`%${text}%`.toLowerCase())
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    if (char === '\\' && i + 1 < chars.length) literal += chars[++i]!
    else if (char === '%' || char === '_') flush()
    else literal += char
  }
  flush()
  return Array.from(longest).length >= 3 ? `"${longest.replaceAll('"', '""')}"` : null
}
