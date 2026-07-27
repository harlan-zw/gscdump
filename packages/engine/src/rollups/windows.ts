import type { TenantCtx } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { FileSetRef, Row, TableName } from '../contracts'
import type { RollupEngine } from './core'
import { MS_PER_DAY } from 'gscdump/dates'

// ---------------------------------------------------------------------------
// Windowed rollup builds — chunk full-history scans so a single runSQL never
// ships an oversized Arrow IPC payload across the Workers RPC (32MiB cap).
// ---------------------------------------------------------------------------

/**
 * Per-window budget, measured in *parquet* bytes (manifest `bytes`), used by
 * `planRollupWindows` to chunk a full-history scan.
 *
 * The executor decodes a window's parquet and ships it as an Arrow IPC stream
 * over the service binding; that IPC is hard-guarded at 28MiB
 * (`IPC_PLACEHOLDER_BUDGET` in @gscdump/cloudflare). Parquet is compressed and
 * the IPC stream is not, so a window inflates on the wire — keep this
 * conservatively below the guard. Re-measure the parquet→IPC ratio against
 * production and raise if headroom allows.
 */
export const WINDOW_BYTE_BUDGET = 10 * 1024 * 1024

/**
 * Per-page OUTPUT row cap for key-paginated rollups (`runWindowed({ paginate })`
 * and `runPagedQuery`). `planRollupWindows` bounds the *input* parquet bytes a
 * window scans, which is a fine proxy for output size on fact aggregations whose
 * grain matches the input (one output row per input date). It is NOT a proxy for
 * aggregations that COLLAPSE to a smaller-cardinality grain whose row count is
 * driven by a high-cardinality GROUP key — `(query_canonical × date)` and
 * `(query_canonical)` — where output rows scale with distinct canonicals, not
 * input bytes. For those, each `runSQL` result (shipped as an Arrow IPC stream
 * over the Workers service-binding RPC; 28MiB guard in `@gscdump/cloudflare`,
 * duckdb-worker `assertResultBudget` at 24MiB / 100k rows) must be bounded by
 * paging the OUTPUT, independent of how the input is windowed.
 *
 * Narrow rows — `(canonical, date, 3 metrics)` — page at 50k (≈16MiB at the
 * worker's `cols×64` heuristic, well under both guards). WIDE rows carry a
 * `GROUP_CONCAT` variants string (up to ~10 variants × ~60 chars) the heuristic
 * under-counts, so they page smaller to keep the real IPC payload bounded.
 */
export const ROLLUP_PAGE_ROWS = 50_000
export const ROLLUP_PAGE_ROWS_WIDE = 20_000
// Daily canonical rollup: `(query_canonical, date, clicks, impressions,
// sum_position)` = 5 columns. The duckdb-worker result guard rejects a page whose
// estimate `rows × cols × 64` exceeds its 24MiB service-binding budget — and that
// estimate is intentionally PESSIMISTIC (64B/col regardless of real width), NOT
// the ~50B real row size. So the ceiling is 24MiB / (5 × 64) ≈ 78,643 rows; 90k
// (5 × 64 × 90k = 28.8MB) tripped it on a high-cardinality site whose window
// filled a full page (comparaja.pt). Page at 70k (≈21.4MiB estimate) with margin.
export const ROLLUP_PAGE_ROWS_DAILY = 70_000
// Day-span cap for the daily rollup's windows: keeps each window's
// `(query_canonical × date)` output under one page on a high-cardinality site so
// the build is single-pass (no OFFSET re-aggregation). The per-window pager is the
// safety net for any window that still over-produces.
export const DAILY_MAX_WINDOW_DAYS = 7

const DAY_RE = /^daily\/(\d{4})-(\d{2})-(\d{2})$/
const WEEK_RE = /^weekly\/(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^monthly\/(\d{4})-(\d{2})$/
const QUARTER_RE = /^quarterly\/(\d{4})-Q([1-4])$/

function isoDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * UTC day-aligned [startMs, endMs] span a partition covers. Returns null for
 * `hourly/` partitions and anything unrecognised — those are excluded from
 * windowed planning.
 */
function partitionDaySpan(partition: string): { startMs: number, endMs: number } | null {
  const day = DAY_RE.exec(partition)
  if (day) {
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    return { startMs: ms, endMs: ms }
  }
  const week = WEEK_RE.exec(partition)
  if (week) {
    const ms = Date.UTC(Number(week[1]), Number(week[2]) - 1, Number(week[3]))
    return { startMs: ms, endMs: ms + 6 * MS_PER_DAY }
  }
  const month = MONTH_RE.exec(partition)
  if (month) {
    const y = Number(month[1])
    const m = Number(month[2]) - 1
    const startMs = Date.UTC(y, m, 1)
    const endMs = Date.UTC(y, m + 1, 1) - MS_PER_DAY
    return { startMs, endMs }
  }
  const quarter = QUARTER_RE.exec(partition)
  if (quarter) {
    const y = Number(quarter[1])
    const q = Number(quarter[2])
    const startMonth = (q - 1) * 3
    const startMs = Date.UTC(y, startMonth, 1)
    const endMs = Date.UTC(y, startMonth + 3, 1) - MS_PER_DAY
    return { startMs, endMs }
  }
  return null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Plan byte-bounded windows over a partition set. Each window names the
 * partitions whose span intersects it; a coarse tier file can land in two
 * windows, so every windowed SQL MUST also date-filter to the window bounds.
 */
export function planRollupWindows(
  parts: Array<{ partition: string, bytes: number }>,
  clampRange?: { start: string, end: string },
  // Hard upper bound on a window's day span, INDEPENDENT of the byte budget. The
  // byte budget bounds INPUT scan size, but a rollup whose OUTPUT row count scales
  // with cardinality × days (e.g. `query_canonical × date`) can over-produce per
  // window on a high-cardinality site even within a byte budget, forcing OFFSET
  // output-paging that RE-RUNS the aggregation per page (the canonical-daily
  // timeout). Capping the day span keeps each window's output under the page cap
  // → one page → single-pass, no re-aggregation. Smaller-but-more windows; the
  // total input scan is unchanged (windows are disjoint).
  maxWindowDays?: number,
): Array<{ start: string, end: string, partitions: string[] }> {
  const clampStartMs = clampRange ? Date.parse(`${clampRange.start}T00:00:00Z`) : undefined
  const clampEndMs = clampRange ? Date.parse(`${clampRange.end}T00:00:00Z`) : undefined
  const spans: Array<{ partition: string, bytes: number, startMs: number, endMs: number }> = []
  for (const p of parts) {
    const span = partitionDaySpan(p.partition)
    if (!span)
      continue
    if (clampStartMs !== undefined && clampEndMs !== undefined) {
      if (span.endMs < clampStartMs || span.startMs > clampEndMs)
        continue
    }
    spans.push({ partition: p.partition, bytes: p.bytes, startMs: span.startMs, endMs: span.endMs })
  }
  if (spans.length === 0)
    return []

  let rangeStartMs = Number.POSITIVE_INFINITY
  let rangeEndMs = Number.NEGATIVE_INFINITY
  let totalBytes = 0
  for (const span of spans) {
    if (span.startMs < rangeStartMs)
      rangeStartMs = span.startMs
    if (span.endMs > rangeEndMs)
      rangeEndMs = span.endMs
    totalBytes += span.bytes
  }
  if (clampStartMs !== undefined)
    rangeStartMs = Math.max(rangeStartMs, clampStartMs)
  if (clampEndMs !== undefined)
    rangeEndMs = Math.min(rangeEndMs, clampEndMs)

  const spanDays = Math.floor((rangeEndMs - rangeStartMs) / MS_PER_DAY) + 1
  const bytesPerDay = Math.max(1, totalBytes / spanDays)
  const byteWindowDays = clamp(Math.floor(WINDOW_BYTE_BUDGET / bytesPerDay), 7, 400)
  // Apply the output-cardinality cap on top of the byte budget (min wins). Floor
  // at 1 so a tiny cap still makes progress.
  const windowDays = maxWindowDays != null ? Math.max(1, Math.min(byteWindowDays, maxWindowDays)) : byteWindowDays
  if (!Number.isFinite(windowDays) || !Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs < rangeStartMs)
    return []

  // Assign spans directly to the windows they intersect. Scanning every span
  // for every window made this O(spans × windows); this is O(spans + emitted
  // intersections), the irreducible output size. Input-order traversal also
  // preserves the existing partition order within every window.
  const windowWidthMs = windowDays * MS_PER_DAY
  const windowCount = Math.floor((rangeEndMs - rangeStartMs) / windowWidthMs) + 1
  const partitionsByWindow: string[][] = Array.from({ length: windowCount }, () => [])
  for (const span of spans) {
    const overlapStartMs = Math.max(span.startMs, rangeStartMs)
    const overlapEndMs = Math.min(span.endMs, rangeEndMs)
    if (overlapStartMs > overlapEndMs)
      continue
    const firstWindow = Math.max(0, Math.ceil(
      (overlapStartMs - rangeStartMs - (windowDays - 1) * MS_PER_DAY) / windowWidthMs,
    ))
    const lastWindow = Math.min(windowCount - 1, Math.floor((overlapEndMs - rangeStartMs) / windowWidthMs))
    for (let index = firstWindow; index <= lastWindow; index++)
      partitionsByWindow[index]!.push(span.partition)
  }

  const windows: Array<{ start: string, end: string, partitions: string[] }> = []
  for (let index = 0; index < windowCount; index++) {
    const cursorMs = rangeStartMs + index * windowWidthMs
    const windowEndMs = Math.min(cursorMs + (windowDays - 1) * MS_PER_DAY, rangeEndMs)
    const partitions = partitionsByWindow[index]!
    if (partitions.length > 0)
      windows.push({ start: isoDate(cursorMs), end: isoDate(windowEndMs), partitions })
  }
  return windows
}

/** Partition strings whose span intersects the inclusive [start, end] date range. */
export function partitionsInRange(
  parts: Array<{ partition: string, bytes: number }>,
  start: string,
  end: string,
): string[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  const out: string[] = []
  for (const p of parts) {
    const span = partitionDaySpan(p.partition)
    if (!span)
      continue
    if (span.endMs >= startMs && span.startMs <= endMs)
      out.push(p.partition)
  }
  return out
}

/**
 * Run one aggregation over a FIXED file set, paging the OUTPUT by appending
 * `ORDER BY <orderBy> LIMIT <pageRows> OFFSET <n>` until a short page. Bounds
 * each `runSQL` result — and thus the Arrow IPC payload shipped over the Workers
 * service-binding RPC — regardless of GROUP cardinality (see `ROLLUP_PAGE_ROWS`).
 *
 * Contract: `coreSql` MUST be a complete `SELECT … GROUP BY …` with NO trailing
 * `ORDER BY`/`LIMIT` (they're appended here), and `orderBy` MUST be a TOTAL order
 * over the result (a superkey of the GROUP grain) so offset paging is
 * gap/overlap-free. OFFSET paging re-runs the aggregation per page; that's
 * acceptable for a post-sync background build, and the common case is a single
 * short page (no extra scans).
 */
async function runPagedQuery(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  table: TableName
  searchType?: SearchType
  fileSets: Record<string, FileSetRef>
  coreSql: string
  orderBy: string
  pageRows: number
}): Promise<Row[]> {
  const out: Row[] = []
  for (let offset = 0; ; offset += opts.pageRows) {
    const result = await opts.engine.runSQL({
      ctx: opts.ctx,
      table: opts.table,
      fileSets: opts.fileSets,
      sql: `${opts.coreSql}\nORDER BY ${opts.orderBy}\nLIMIT ${opts.pageRows} OFFSET ${offset}`,
      ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
    })
    out.push(...result.rows)
    if (result.rows.length < opts.pageRows)
      break
  }
  return out
}

/**
 * Run a full-history aggregation in byte-bounded windows and concat the rows.
 * Each window's SQL MUST date-filter to `[w.start, w.end]` (see `sqlFor`) so a
 * tier file spanning a window boundary doesn't double-count calendar dates.
 *
 * `paginate` additionally pages each window's OUTPUT (see `runPagedQuery`) so a
 * window whose GROUP cardinality is high — `(query_canonical × date)` on a large
 * site — can't ship an oversized result even though its input bytes fit a window.
 * Date-windowing bounds the per-query scan; output paging bounds the IPC payload.
 * The two are orthogonal and compose. When `paginate` is set, `sqlFor` MUST emit
 * no trailing `ORDER BY`/`LIMIT` and `paginate.orderBy` MUST be a total order.
 */
export async function runWindowed(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  table: TableName
  searchType?: SearchType
  sqlFor: (w: { start: string, end: string }) => string
  /**
   * Extra named file sets merged into every window's `runSQL` (alongside the
   * windowed `FILES`). Use to JOIN a non-windowed sidecar (e.g. the query
   * dimension parquet via `{ QUERY_DIM: { keys: [...] } }`) inside `sqlFor`.
   */
  extraFileSets?: Record<string, FileSetRef>
  /** Page each window's output by a total-order key. See `runPagedQuery`. */
  paginate?: { orderBy: string, pageRows: number }
  /** Cap each window's day span (output-cardinality bound). See `planRollupWindows`. */
  maxWindowDays?: number
}): Promise<Row[]> {
  const parts = await opts.engine.listPartitions({
    ctx: opts.ctx,
    table: opts.table,
    ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
  })
  const windows = planRollupWindows(parts, undefined, opts.maxWindowDays)
  const rows: Row[] = []
  for (const w of windows) {
    const fileSets = { FILES: { table: opts.table, partitions: w.partitions }, ...opts.extraFileSets }
    if (opts.paginate) {
      rows.push(...await runPagedQuery({
        engine: opts.engine,
        ctx: opts.ctx,
        table: opts.table,
        ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
        fileSets,
        coreSql: opts.sqlFor(w),
        orderBy: opts.paginate.orderBy,
        pageRows: opts.paginate.pageRows,
      }))
      continue
    }
    const result = await opts.engine.runSQL({
      ctx: opts.ctx,
      table: opts.table,
      fileSets,
      sql: opts.sqlFor(w),
      ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
    })
    rows.push(...result.rows)
  }
  return rows
}
