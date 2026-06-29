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
//   queries        → keys = [query, date]
//   countries      → keys = [country, date]
//   page_queries   → keys = [page, query, date]
//   search_appearance → keys = [searchAppearance] + options.date
//   search_appearance_pages → keys = [page, date] + options.searchAppearance
//   search_appearance_queries → keys = [query, date] + options.searchAppearance
//   search_appearance_page_queries → keys = [page, query, date] + options.searchAppearance
//   dates          → bespoke: two GSC queries (`['date']` + `['date','device']`)
//                    assembled by `assembleDatesRow` (see below), NOT
//                    `transformGscRow`.

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
  queries: ['query', 'date'],
  countries: ['country', 'date'],
  // `dates` is assembled from a GSC `['date']` query (true site totals) plus a
  // `['date','device']` query (device pivot); see `assembleDatesRow`. The
  // `['date']` form is listed here as the primary fetch dimension set.
  dates: ['date'],
  page_queries: ['page', 'query', 'date'],
  search_appearance: ['searchAppearance', 'date'],
  search_appearance_pages: ['page', 'date'],
  search_appearance_queries: ['query', 'date'],
  search_appearance_page_queries: ['page', 'query', 'date'],
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
  /** @deprecated Canonical query data is built through query_dim, not fact rows. */
  normalizeQuery?: (query: string) => string | null | undefined
  /** Date for one-day `searchAppearance` total queries, whose keys omit date. */
  date?: string
  /** Search appearance filter used for contextual second-step rows. */
  searchAppearance?: string
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
  // Clamp position to ≥1: GSC reports position ≥ 1.0, but a missing/0 position
  // (the `apiRow.position || 0` callers) would otherwise store a NEGATIVE
  // sum_position ((0-1)*impr), which skews the SUM(sum_position)/SUM(impr)+1
  // average recovery. position=1 → 0 contribution, the correct neutral default.
  const position = apiPosition >= 1 ? apiPosition : 1
  return (position - 1) * Math.max(impressions, 1)
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

  if (table === 'queries') {
    const query = String(keys[0] ?? '')
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { query, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'countries') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { country: String(keys[0] ?? ''), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'hourly_pages') {
    // GSC `hourly_all` emits hour as ISO with PT offset
    // (e.g. `2026-05-17T15:00:00-07:00`). Calendar date = leading 10 chars;
    // hour-of-day (PT) = chars 11-12 as an INT (stored as INTEGER, not the
    // 25-char timestamp — `date` already carries the day + offset is fixed PT).
    const hourStamp = String(keys[0] ?? '')
    const date = hourStamp.slice(0, 10)
    const hour = Number.parseInt(hourStamp.slice(11, 13), 10)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
      throw new Error(`hourly_pages: cannot derive hour-of-day from '${hourStamp}'`)
    return {
      date,
      row: { url: toPath(String(keys[1] ?? '')), hour, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'search_appearance') {
    const date = String(keys[1] ?? options.date ?? '')
    return {
      date,
      row: { searchAppearance: String(keys[0] ?? ''), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'search_appearance_pages') {
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { searchAppearance: String(options.searchAppearance ?? ''), url: toPath(String(keys[0] ?? '')), date, clicks, impressions, sum_position },
    }
  }

  if (table === 'search_appearance_queries') {
    const query = String(keys[0] ?? '')
    const date = String(keys[1] ?? '')
    return {
      date,
      row: { searchAppearance: String(options.searchAppearance ?? ''), query, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'search_appearance_page_queries') {
    const query = String(keys[1] ?? '')
    const date = String(keys[2] ?? '')
    return {
      date,
      row: { searchAppearance: String(options.searchAppearance ?? ''), url: toPath(String(keys[0] ?? '')), query, date, clicks, impressions, sum_position },
    }
  }

  if (table === 'dates') {
    // `dates` is never produced by transformGscRow — it is assembled from two
    // separate GSC queries by `assembleDatesRow`. Reject to fail loudly if a
    // caller mis-routes a single-query slice to this table.
    throw new Error('`dates` rows must be built via assembleDatesRow, not transformGscRow')
  }

  // page_queries
  const query = String(keys[1] ?? '')
  const date = String(keys[2] ?? '')
  return {
    date,
    row: {
      url: toPath(String(keys[0] ?? '')),
      query,
      date,
      clicks,
      impressions,
      sum_position,
    },
  }
}

/** Canonical GSC device key → `dates` pivot-column suffix. */
const DEVICE_SUFFIX: Record<string, 'desktop' | 'mobile' | 'tablet'> = {
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  TABLET: 'tablet',
}

/**
 * Assemble one `dates` row for a single `date` from the two GSC queries that
 * back the table:
 *
 * - `totalsRow` — the GSC `['date']` query result: the TRUE site totals
 *   (clicks/impressions/position), including anonymized impressions.
 * - `deviceRows` — the GSC `['date','device']` query results for that date:
 *   one row per device, pivoted into the 9 `*_{device}` columns.
 * - `queryGrainedImpressions` — total impressions summed from the
 *   `['query','date']` (or `['page','query','date']`) query for the same date,
 *   used to derive `anonymized_impressions_pct`.
 *
 * `anonymized_impressions_pct = 1 - query_grained_impressions /
 * page_grained_impressions`, where the page/date totals come from `totalsRow`.
 * Mirrors the legacy `dailyTotalsRollup` formula. Clamped to `[0, 1]`.
 */
export function assembleDatesRow(
  date: string,
  totalsRow: GscApiRow,
  deviceRows: readonly GscApiRow[],
  queryGrainedImpressions: number,
): { date: string, row: Row } {
  const clicks = totalsRow.clicks || 0
  const impressions = totalsRow.impressions || 0
  const sum_position = toSumPosition(totalsRow.position || 0, impressions)

  const row: Record<string, unknown> = {
    date,
    clicks,
    impressions,
    sum_position,
    anonymized_impressions_pct: impressions > 0
      ? Math.min(1, Math.max(0, 1 - queryGrainedImpressions / impressions))
      : 0,
    clicks_desktop: 0,
    clicks_mobile: 0,
    clicks_tablet: 0,
    impressions_desktop: 0,
    impressions_mobile: 0,
    impressions_tablet: 0,
    sum_position_desktop: 0,
    sum_position_mobile: 0,
    sum_position_tablet: 0,
  }

  for (const dr of deviceRows) {
    const deviceKey = String(dr.keys?.[1] ?? dr.keys?.[0] ?? '').toUpperCase()
    const suffix = DEVICE_SUFFIX[deviceKey]
    if (!suffix)
      continue
    const dImpr = dr.impressions || 0
    row[`clicks_${suffix}`] = dr.clicks || 0
    row[`impressions_${suffix}`] = dImpr
    row[`sum_position_${suffix}`] = toSumPosition(dr.position || 0, dImpr)
  }

  return { date, row }
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
