import type { DataRow, SearchAnalyticsQuery } from '../../core/types'
import type { GoogleSearchConsoleClient } from '../../core/client'

/**
 * Supported GSC dimensions for streaming queries.
 * Maps to GSC API dimension names.
 */
export type DimensionKey = 'query' | 'page' | 'date' | 'device' | 'country'

/**
 * Maps each dimension to its output field name.
 * Note: 'query' maps to 'keyword' to match existing API conventions.
 */
type DimensionFields = {
  query: { keyword: string }
  page: { page: string }
  date: { date: string }
  device: { device: string }
  country: { country: string }
}

/**
 * Recursively extracts and merges fields for each dimension in a tuple.
 * Used for type inference from dimensions array.
 */
type ExtractFields<D extends readonly DimensionKey[]> =
  D extends readonly [infer First extends DimensionKey, ...infer Rest extends DimensionKey[]]
    ? DimensionFields[First] & ExtractFields<Rest>
    : object

/**
 * Output row type for streaming queries.
 * Combines GSC metrics (clicks, impressions, ctr, position) with
 * typed dimension fields based on the dimensions array.
 *
 * @example
 * // For dimensions: ['query', 'page']
 * // StreamRow = { keyword: string, page: string, clicks?: number, impressions?: number, ctr?: number, position?: number }
 */
export type StreamRow<D extends readonly DimensionKey[]> =
  Omit<DataRow, 'keys'> & ExtractFields<D>


// Map dimension name to field name for row transformation
const DIMENSION_TO_FIELD: Record<DimensionKey, string> = {
  query: 'keyword',
  page: 'page',
  date: 'date',
  device: 'device',
  country: 'country',
}

function mapRowToDimensions<D extends readonly DimensionKey[]>(
  row: DataRow,
  dimensions: D,
): StreamRow<D> {
  const { keys, ...metrics } = row
  const fields: Record<string, string> = {}

  dimensions.forEach((dim, i) => {
    fields[DIMENSION_TO_FIELD[dim]] = keys?.[i] || ''
  })

  return { ...metrics, ...fields } as StreamRow<D>
}

/**
 * Async generator for memory-efficient pagination of GSC search analytics.
 * Yields batches of typed rows as they're fetched, avoiding accumulation in memory.
 *
 * **Design:** Single generic function with type inference replaces separate
 * `fetchPagesStream`, `fetchKeywordsStream` wrappers. Output type is inferred
 * from the dimensions tuple:
 * - `['query']` → `{ keyword: string, clicks, impressions, ctr, position }`
 * - `['page']` → `{ page: string, clicks, impressions, ctr, position }`
 * - `['query', 'page']` → `{ keyword: string, page: string, ... }`
 *
 * Each yield contains up to 25,000 rows (one API page). Use `collectStream()`
 * to gather all batches if full array is needed.
 *
 * @param client - GSC client instance
 * @param siteUrl - Site URL (e.g., 'https://example.com/' or 'sc-domain:example.com')
 * @param query - Query with dimensions array (requires `as const` for type inference)
 *
 * @example
 * ```ts
 * // Stream keyword+page combinations
 * for await (const batch of queryRecursiveStream(client, url, {
 *   dimensions: ['query', 'page'] as const,
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31',
 * })) {
 *   // batch: { keyword: string, page: string, clicks, impressions, ctr, position }[]
 *   await db.insert(batch)
 * }
 *
 * // Or collect all at once
 * const allRows = await collectStream(queryRecursiveStream(client, url, {
 *   dimensions: ['page'] as const,
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31',
 * }))
 * ```
 *
 * @remarks
 * - Requires `as const` on dimensions array for proper type inference
 * - Use for large datasets (>25k rows) where memory is a concern
 * - Non-paginating queries (devices, countries) don't benefit from streaming
 */
export async function* queryRecursiveStream<const D extends readonly DimensionKey[]>(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  query: Omit<SearchAnalyticsQuery, 'dimensions'> & { dimensions: D },
): AsyncGenerator<StreamRow<D>[], void, undefined> {
  const rowLimit = query.rowLimit || 25_000
  let startRow = 0

  while (true) {
    const res = await client.searchAnalytics.query(siteUrl, {
      ...query,
      dimensions: [...query.dimensions], // spread to mutable array
      startRow,
      rowLimit,
    })

    const rows = res.rows || []
    if (rows.length === 0)
      break

    yield rows.map(row => mapRowToDimensions(row, query.dimensions))

    startRow += rows.length
    if (rows.length < rowLimit)
      break
  }
}

/** Collect all batches into single array (for testing / simple cases) */
export async function collectStream<T>(gen: AsyncGenerator<T[], void, undefined>): Promise<T[]> {
  const all: T[] = []
  for await (const batch of gen) {
    all.push(...batch)
  }
  return all
}
