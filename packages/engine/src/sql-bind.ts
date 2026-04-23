// SQL-standard parameter binder. Walks SQL with single-quote tracking
// (`''` escaping) so `?` placeholders inside string literals are never
// substituted. For engines that can't bind parameters natively —
// CF Workers → DuckDB service RPC, HTTP SQL proxies, some WASM bridges.
//
// Not for general-purpose SQL execution — prefer parameterized queries.
// Every literal emitted here is subject to the driver's own SQL grammar;
// we escape quotes but don't understand dialect-specific types beyond the
// primitives below. Reject anything we can't represent safely.

function containsDisallowedControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if ((code >= 0x00 && code <= 0x08) || code === 0x0B || code === 0x0C || (code >= 0x0E && code <= 0x1F))
      return true
  }
  return false
}

export function formatLiteral(value: unknown): string {
  if (value == null)
    return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`cannot inline non-finite number: ${value}`)
    return String(value)
  }
  if (typeof value === 'boolean')
    return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'bigint')
    return value.toString()
  if (value instanceof Date)
    return `'${value.toISOString()}'`
  if (typeof value === 'string') {
    if (containsDisallowedControlChars(value))
      throw new Error('string literal contains disallowed control characters')
    return `'${value.replace(/'/g, '\'\'')}'`
  }
  throw new Error(`cannot inline value of type ${typeof value}`)
}

/**
 * Replace `?` placeholders with inline SQL literals. Single-quoted string
 * regions and SQL comments (`-- line`, `/* block *\/`) are left untouched —
 * a `?` inside `'foo?bar'` or a comment is not a placeholder. SQL-standard
 * `''` escape handling; no `\`-escape or dialect-specific identifier quoting.
 *
 * Throws when placeholder count and params length disagree.
 */
export function bindLiterals(sql: string, params: readonly unknown[]): string {
  if (params.length === 0)
    return sql
  let out = ''
  let i = 0
  let paramIdx = 0
  let inString = false
  while (i < sql.length) {
    const c = sql[i]!
    if (inString) {
      out += c
      if (c === '\'') {
        if (sql[i + 1] === '\'') {
          out += '\''
          i += 2
          continue
        }
        inString = false
      }
      i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2)
      const end = nl === -1 ? sql.length : nl
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (c === '\'') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '?') {
      if (paramIdx >= params.length)
        throw new Error(`bindLiterals: more '?' placeholders than params (have ${params.length})`)
      out += formatLiteral(params[paramIdx++])
      i++
      continue
    }
    out += c
    i++
  }
  if (paramIdx !== params.length)
    throw new Error(`bindLiterals: ${params.length - paramIdx} params unused`)
  return out
}
