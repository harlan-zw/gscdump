// Transforms GSC searchanalytics `keys + metrics` rows into the storage
// schema `Row` shape, bucketed by (table, date). No I/O, no recovery logic
// — just the pure shape mapping. Callers decide how to handle overflow,
// mid-job continuation, and writes (see gscdump.com's write-hook.ts for a
// concrete orchestration layer on top of this).
//
// The key indexing per table mirrors what gscdump's own `client.query()`
// emits when you select the corresponding dimensions:
//
//   pages          → keys = [page, date]
//   keywords       → keys = [query, date]
//   countries      → keys = [country, date]
//   devices        → keys = [device, date]
//   page_keywords  → keys = [page, query, date]

import type { Row, TableName } from './storage'

/**
 * Canonical GSC API dimension order per table. Consumers hitting the raw
 * `searchanalytics.query` endpoint must request dimensions in this order so
 * that `transformGscRow` / `createRowAccumulator` can decode the resulting
 * `keys[]` tuples. Storage-column names (e.g. `page` → `url`) are handled
 * inside `transformGscRow` — this record stays in GSC-API vocabulary.
 */
export const TABLE_DIMS: Record<TableName, string[]> = {
  pages: ['page', 'date'],
  keywords: ['query', 'date'],
  countries: ['country', 'date'],
  devices: ['device', 'date'],
  page_keywords: ['page', 'query', 'date'],
  search_appearance: ['searchAppearance', 'date'],
  // GSC `hourly_all` dataState — keys arrive as `[hour, page]`; the calendar
  // date is derived from the leading hour timestamp at ingest.
  hourly_pages: ['hour', 'page'],
}

export interface GscApiRow {
  keys: string[]
  clicks: number
  impressions: number
  /** Unused by ingest — the `sum_position` column encodes weighted position. */
  ctr?: number
  position: number
}

export interface IngestOptions {
  /**
   * Canonical form of a query string, stored alongside `query` as
   * `query_canonical`. Site-specific (e.g. synonym groups, stemming); if
   * omitted, `query_canonical` is null. Applied to `keywords` +
   * `page_keywords` tables only.
   */
  normalizeQuery?: (query: string) => string | null | undefined
}

/**
 * Strip a GSC URL to its pathname. Core analytics stores pages by path so
 * queries don't carry origin-prefix filters.
 */
export function toPath(gscUrl: string): string {
  try {
    return new URL(gscUrl).pathname
  }
  catch {
    return gscUrl
  }
}

/**
 * Encode weighted average position as `sum_position`. The raw GSC position
 * is 1-indexed; subtract 1 and weight by impressions so a downstream
 * `SUM(sum_position) / SUM(impressions) + 1` recovers the true mean without
 * ever materialising per-row position values.
 */
export function toSumPosition(apiPosition: number, impressions: number): number {
  return (apiPosition - 1) * Math.max(impressions, 1)
}

/**
 * Map one GSC API row into `{ date, row }` for the given table, or null if
 * the row has no keys (GSC occasionally emits empty-keys placeholders).
 */
export function transformGscRow(
  table: TableName,
  apiRow: GscApiRow,
  options: IngestOptions = {},
): { date: string, row: Row } | null {
  const keys = apiRow.keys
  if (!keys || keys.length === 0)
    return null

  const clicks = apiRow.clicks || 0
  const impressions = apiRow.impressions || 0
  const sum_position = toSumPosition(apiRow.position || 0, impressions)

  if (table === 'pages') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { url: toPath(String(keys[0] ?? '')), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'keywords') {
    const query = String(keys[0] ?? '')
    const date = String(keys[1] ?? '')
    const query_canonical = options.normalizeQuery?.(query) ?? null
    return {
      date,
      row: { query, query_canonical, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'countries') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { country: String(keys[0] ?? ''), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'devices') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { device: String(keys[0] ?? ''), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'hourly_pages') {
    // GSC `hourly_all` emits hour as ISO with PT offset
    // (e.g. `2026-05-17T15:00:00-07:00`). Calendar date = leading 10 chars.
    const hour = String(keys[0] ?? '')
    const date = hour.slice(0, 10)
    return {
      date,
      row: { url: toPath(String(keys[1] ?? '')), hour, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'search_appearance') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { searchAppearance: String(keys[0] ?? ''), date, clicks, impressions, sum_position },
    }
  }

  // page_keywords
  const query = String(keys[1] ?? '')
  const date = String(keys[2] ?? '')
  const query_canonical = options.normalizeQuery?.(query) ?? null
  return {
    date,
    row: {
      url: toPath(String(keys[0] ?? '')),
      query,
      query_canonical,
      date,
      clicks,
      impressions,
      sum_position,
    },
  }
}

export interface RowAccumulator {
  /**
   * Push a batch of GSC API rows into the accumulator. Returns `false` if
   * the batch pushed total row count past `maxRows`; subsequent pushes
   * become no-ops until `drain()` is called.
   */
  push: (table: TableName, rows: readonly GscApiRow[]) => boolean
  /**
   * Consume accumulated rows, grouped by `table → date → rows`. Resets
   * internal state; subsequent pushes behave as on a fresh accumulator.
   */
  drain: () => Map<TableName, Map<string, Row[]>>
  /**
   * Drain only buckets for dates strictly older than the most-recent date
   * seen for each table. Requires `trackDateBoundary` to be enabled — without
   * it, returns an empty map. GSC's date-as-dimension queries return rows
   * sorted by date, so any date older than the latest seen is logically
   * complete within the current job slice and safe to flush mid-job.
   *
   * Returned buckets are removed from internal state and `totalRows` is
   * decremented accordingly. Latest-date buckets stay in place for the
   * eventual `drain()` at job end.
   */
  drainCompleted: () => Map<TableName, Map<string, Row[]>>
  /** Total row count across all tables/dates since last drain. */
  readonly totalRows: number
  /** Whether the accumulator has overflowed since last drain. */
  readonly overflowed: boolean
}

export interface RowAccumulatorOptions extends IngestOptions {
  /**
   * Soft cap on total accumulated rows before `push` starts returning
   * `false` and dropping rows. Defaults to 500_000 — matches the
   * ~128 MB CF Workers isolate budget at ~200 bytes/row with headroom.
   */
  maxRows?: number
  /**
   * Track the most-recent date seen per table so `drainCompleted()` can
   * return older-date buckets mid-job. Off by default — callers that don't
   * stream-flush pay zero overhead for the bookkeeping.
   *
   * Caller contract: only safe when GSC dimensions include `date` so the
   * API returns rows in date-ascending order; without that ordering,
   * "older than latest" doesn't mean "complete" and partial buckets would
   * be flushed prematurely.
   */
  trackDateBoundary?: boolean
}

const DEFAULT_MAX_ROWS = 500_000

export function createRowAccumulator(options: RowAccumulatorOptions = {}): RowAccumulator {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const trackDateBoundary = options.trackDateBoundary === true
  let buckets = new Map<TableName, Map<string, Row[]>>()
  const latestDate = new Map<TableName, string>()
  let total = 0
  let overflowed = false

  function bucketFor(table: TableName, date: string): Row[] {
    let byDate = buckets.get(table)
    if (!byDate) {
      byDate = new Map()
      buckets.set(table, byDate)
    }
    let rows = byDate.get(date)
    if (!rows) {
      rows = []
      byDate.set(date, rows)
    }
    return rows
  }

  return {
    get totalRows() {
      return total
    },
    get overflowed() {
      return overflowed
    },
    push(table, rows) {
      if (overflowed)
        return false
      for (const r of rows) {
        const t = transformGscRow(table, r, options)
        if (!t || !t.date)
          continue
        bucketFor(table, t.date).push(t.row)
        total++
        if (trackDateBoundary) {
          const prev = latestDate.get(table)
          if (!prev || t.date > prev)
            latestDate.set(table, t.date)
        }
        if (total > maxRows) {
          overflowed = true
          return false
        }
      }
      return true
    },
    drain() {
      const out = buckets
      buckets = new Map()
      latestDate.clear()
      total = 0
      overflowed = false
      return out
    },
    drainCompleted() {
      const out = new Map<TableName, Map<string, Row[]>>()
      if (!trackDateBoundary)
        return out
      for (const [table, byDate] of buckets) {
        const latest = latestDate.get(table)
        if (!latest)
          continue
        let outBy: Map<string, Row[]> | undefined
        for (const [date, dateRows] of byDate) {
          if (date < latest) {
            if (!outBy) {
              outBy = new Map()
              out.set(table, outBy)
            }
            outBy.set(date, dateRows)
            total -= dateRows.length
          }
        }
        if (outBy) {
          for (const date of outBy.keys())
            byDate.delete(date)
        }
      }
      return out
    },
  }
}
