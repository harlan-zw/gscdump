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
 * Return one sorted page without sorting the entire candidate set when the
 * requested prefix is small. A bounded max-heap retains only `offset + limit`
 * rows, then sorts that prefix. Original indexes break comparator ties so the
 * result stays as stable as modern `Array#sort`.
 */
export function paginateSortedInMemory<T>(
  rows: readonly T[],
  input: PaginateInput,
  compare: (left: T, right: T) => number,
): T[] {
  const limit = clampLimit(input.limit, rows.length)
  const offset = clampOffset(input.offset)
  const selectedCount = Math.min(rows.length, offset + limit)
  if (limit === 0 || offset >= rows.length || selectedCount === 0)
    return []

  // Full sorting is faster once most of the input must be retained and keeps
  // unusual comparator behavior on the native implementation's path.
  const fullSort = (): T[] => [...rows].sort(compare).slice(offset, offset + limit)
  if (selectedCount >= rows.length / 2)
    return fullSort()

  interface IndexedValue { value: T, index: number }
  let invalidComparison = false
  const compareStable = (left: IndexedValue, right: IndexedValue): number => {
    const order = compare(left.value, right.value)
    if (Number.isNaN(order)) {
      invalidComparison = true
      return left.index - right.index
    }
    return order || left.index - right.index
  }
  const isWorse = (left: IndexedValue, right: IndexedValue): boolean => compareStable(left, right) > 0
  const heap: IndexedValue[] = []

  const siftUp = (start: number): void => {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (!isWorse(heap[index]!, heap[parent]!))
        break
      const swap = heap[parent]!
      heap[parent] = heap[index]!
      heap[index] = swap
      index = parent
    }
  }

  const siftDown = (): void => {
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      if (left >= heap.length)
        return
      const right = left + 1
      let worse = left
      if (right < heap.length && isWorse(heap[right]!, heap[left]!))
        worse = right
      if (!isWorse(heap[worse]!, heap[index]!))
        return
      const swap = heap[index]!
      heap[index] = heap[worse]!
      heap[worse] = swap
      index = worse
    }
  }

  for (let index = 0; index < rows.length; index++) {
    const candidate = { value: rows[index]!, index }
    if (heap.length < selectedCount) {
      heap.push(candidate)
      siftUp(heap.length - 1)
    }
    else if (compareStable(candidate, heap[0]!) < 0) {
      heap[0] = candidate
      siftDown()
    }
  }

  if (invalidComparison)
    return fullSort()
  heap.sort(compareStable)
  if (invalidComparison)
    return fullSort()
  return heap.slice(offset, offset + limit).map(entry => entry.value)
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

/**
 * SQL select-list item that carries the full match count on every row.
 * Window functions run before `LIMIT`, so it counts rows the page drops.
 */
export const TOTAL_COUNT_SELECT = 'CAST(COUNT(*) OVER () AS DOUBLE) AS totalCount'

/**
 * Read the full match count that `TOTAL_COUNT_SELECT` stamped onto each row.
 * An empty page has no row to read, so it falls back to the row count.
 */
export function totalCountOf(rows: readonly Record<string, unknown>[]): number {
  const first = rows[0]
  return first?.totalCount != null ? Number(first.totalCount) : rows.length
}
