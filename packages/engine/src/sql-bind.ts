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

/** Escape single quotes for inlining inside a SQL string literal (SQL-standard `''` escaping). */
export function sqlEscape(s: string): string {
  return s.replace(/'/g, '\'\'')
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
 * Replace `?` and `$N` placeholders with inline SQL literals. Single-quoted
 * string regions and SQL comments (`-- line`, `/* block *\/`) are left
 * untouched — a `?` or `$1` inside `'foo?bar'` or a comment is not a
 * placeholder. SQL-standard `''` escape handling; no `\`-escape or
 * dialect-specific identifier quoting.
 *
 * `?` placeholders bind sequentially against `params`. `$N` (Postgres-style)
 * binds explicitly to `params[N-1]`. The two styles must not be mixed in the
 * same query.
 *
 * Throws when placeholder count and params length disagree, or when a `$N`
 * index is out of range.
 */
export function bindLiterals(sql: string, params: readonly unknown[]): string {
  if (params.length === 0)
    return sql
  let out = ''
  let i = 0
  let qmarkIdx = 0
  const usedDollar = new Set<number>()
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
      if (qmarkIdx >= params.length)
        throw new Error(`bindLiterals: more '?' placeholders than params (have ${params.length})`)
      out += formatLiteral(params[qmarkIdx++])
      i++
      continue
    }
    if (c === '$' && sql[i + 1] && sql[i + 1]! >= '0' && sql[i + 1]! <= '9') {
      let j = i + 1
      while (j < sql.length && sql[j]! >= '0' && sql[j]! <= '9') j++
      const n = Number(sql.slice(i + 1, j))
      if (n < 1 || n > params.length)
        throw new Error(`bindLiterals: $${n} out of range (have ${params.length} params)`)
      usedDollar.add(n - 1)
      out += formatLiteral(params[n - 1])
      i = j
      continue
    }
    out += c
    i++
  }
  if (qmarkIdx > 0 && usedDollar.size > 0)
    throw new Error('bindLiterals: cannot mix \'?\' and \'$N\' placeholders in the same query')
  const used = qmarkIdx > 0 ? qmarkIdx : usedDollar.size
  if (used !== params.length)
    throw new Error(`bindLiterals: ${params.length - used} params unused`)
  return out
}
