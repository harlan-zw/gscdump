/**
 * Pagination helpers shared across analyzers. SQL builders compose
 * `paginateClause` into their tail; row reducers use `paginateInMemory`
 * to slice already-materialized results.
 *
 * Sort whitelisting stays per-analyzer because each result shape has its
 * own valid columns. `resolveSort` provides a tiny safe-cast.
 */

const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 50_000

export interface PaginateInput {
  limit?: number
  offset?: number
}

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  const n = Number(limit ?? fallback)
  if (!Number.isFinite(n) || n <= 0)
    return fallback
  return Math.min(n, MAX_LIMIT)
}

export function clampOffset(offset: number | undefined): number {
  const n = Number(offset ?? 0)
  if (!Number.isFinite(n) || n < 0)
    return 0
  return Math.floor(n)
}

/**
 * Emits `LIMIT n` or `LIMIT n OFFSET m` literally (no placeholders) so it
 * can be safely concatenated into the analyzer's SQL tail. Inputs are
 * coerced and clamped — never user-controllable.
 */
export function paginateClause(input: PaginateInput): string {
  const l = clampLimit(input.limit)
  const o = clampOffset(input.offset)
  return o > 0 ? `LIMIT ${l} OFFSET ${o}` : `LIMIT ${l}`
}

/**
 * Slice a materialized result array. Use in row reducers and in SQL
 * reducers when SQL didn't push pagination down.
 */
export function paginateInMemory<T>(rows: readonly T[], input: PaginateInput): T[] {
  const l = clampLimit(input.limit, rows.length)
  const o = clampOffset(input.offset)
  return rows.slice(o, o + l)
}

/**
 * Resolve `sortBy` against an allow-list. Returns a typed key + direction
 * suitable for ORDER BY interpolation or for indexing into a comparator
 * map. Falls back to the analyzer's default when input is missing or
 * unrecognized.
 */
export function resolveSort<K extends string>(
  input: { sortBy?: string, sortDir?: 'asc' | 'desc' },
  allowed: readonly K[],
  defaults: { sortBy: K, sortDir: 'asc' | 'desc' },
): { sortBy: K, sortDir: 'asc' | 'desc' } {
  const sortBy = (input.sortBy && (allowed as readonly string[]).includes(input.sortBy))
    ? (input.sortBy as K)
    : defaults.sortBy
  const sortDir = input.sortDir === 'asc' || input.sortDir === 'desc'
    ? input.sortDir
    : defaults.sortDir
  return { sortBy, sortDir }
}
