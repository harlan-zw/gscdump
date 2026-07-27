import type { TenantCtx } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { DataSource, FileSetRef, Row, TableName } from '../contracts'
import type {
  ParquetRollupPointer,
  RollupDef,
  RollupEngine,
  RollupEnvelope,
} from './core'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { createQueryDimStore } from '../entities'
import { rollupKey, rollupParquetKey } from './core'
import {
  DAILY_MAX_WINDOW_DAYS,
  planRollupWindows,
  ROLLUP_PAGE_ROWS_DAILY,
  ROLLUP_PAGE_ROWS_WIDE,
  runWindowed,
} from './windows'

/**
 * Materialises canonical-query variant grouping so the read path
 * (`buildExtrasQueries` in `resolver/compile.ts`) becomes a passthrough scan
 * instead of two window passes (`ROW_NUMBER`/`COUNT` over `PARTITION BY
 * query_canonical`) plus a `GROUP_CONCAT` over the whole `queries` table on
 * every request — work that is single-threaded under DuckDB-WASM/Workers and
 * scales with table size. See ADR-0017.
 *
 * One row per `query_canonical` group, columns named 1:1 with the live query's
 * output (`joinKey`, `variantCount`, `canonicalName`, `variants`) so
 * `mergeExtras` consumes either source unchanged. `variants` packs the top-10
 * variants as `query:::clicks:::impressions:::position` joined by `||`,
 * identical to the live composer.
 *
 * Full history (`windowDays: null`), not a trailing window: grouping metadata
 * is global (which variant is canonical, how many variants exist) and stays
 * stable across requests rather than shifting with each query's date range.
 * Reflects the last sync/compaction, not the live tail — readers that need the
 * tail can layer a recent-overlay later (the envelope carries `builtAt`).
 */
interface CanonicalVariant {
  query: string
  clicks: number
  impressions: number
  sumPos: number
}

interface CanonicalVariantBucket {
  count: number
  top: CanonicalVariant[]
}

const CANONICAL_VARIANT_LIMIT = 10

function retainCanonicalVariant(
  bucket: CanonicalVariantBucket,
  query: string,
  clicks: number,
  impressions: number,
  sumPos: number,
): void {
  bucket.count++
  let insertAt = 0
  while (insertAt < bucket.top.length) {
    const existing = bucket.top[insertAt]!
    if (clicks > existing.clicks || (clicks === existing.clicks && query.localeCompare(existing.query) < 0))
      break
    insertAt++
  }
  if (insertAt >= CANONICAL_VARIANT_LIMIT)
    return
  bucket.top.splice(insertAt, 0, { query, clicks, impressions, sumPos })
  if (bucket.top.length > CANONICAL_VARIANT_LIMIT)
    bucket.top.pop()
}

export const queryCanonicalVariantsRollup: RollupDef = {
  id: 'query_canonical_variants',
  windowDays: null,
  format: 'parquet',
  parquetColumns: [
    { name: 'joinKey', type: 'VARCHAR', nullable: false },
    { name: 'variantCount', type: 'BIGINT', nullable: false },
    { name: 'canonicalName', type: 'VARCHAR', nullable: true },
    { name: 'variants', type: 'VARCHAR', nullable: true },
  ],
  parquetSortKey: ['joinKey'],
  async build({ engine, ctx, dataSource, searchType }) {
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    if (parts.length === 0)
      return []
    const partitions = parts.map(p => p.partition)
    // Per-VARIANT (one row per distinct `query`) clicks/impressions/sum_pos over
    // full history, KEYSET-paged by `query`. `query` is the table's physical
    // clusterKey (TABLE_METADATA.queries.clusterKey = ['query','date']), so
    // `query > cursor` lets DuckDB PRUNE every row group whose max(query) <= cursor
    // → each page scans only its query slice → ~one pass total. The OLD shape ran a
    // full-table `PARTITION BY canonical` window aggregation re-executed per OFFSET
    // page (N× full scans), which blew the 300s job reservation on high-cardinality
    // sites (plan §8; 60dbadbb). Paging by the RAW query (not the derived canonical
    // joinKey) is SAFE because we emit per-variant rows and regroup by canonical in
    // JS below — a canonical whose variants straddle a page boundary is reassembled.
    const byCanonical = new Map<string, CanonicalVariantBucket>()
    const dimStore = createQueryDimStore({ dataSource })
    const useDim = (await dimStore.loadMeta(ctx)) !== null
    const canonExpr = useDim ? 'COALESCE(qd.query_canonical, q.query)' : 'q.query'
    let cursor: string | null = null
    for (;;) {
      const after = cursor === null ? '' : `AND q.query > '${cursor.replace(/'/g, '\'\'')}'`
      const fileSets: Record<string, FileSetRef> = { FILES: { table: 'queries', partitions } }
      if (useDim)
        fileSets.QUERY_DIM = { table: 'queries', keys: [dimStore.parquetKey(ctx)] }
      const { rows } = await engine.runSQL({
        ctx,
        table: 'queries',
        ...(searchType !== undefined ? { searchType } : {}),
        fileSets,
        sql: `
          SELECT
            ${canonExpr} AS joinKey,
            q.query AS query,
            SUM(q.clicks) AS clicks,
            SUM(q.impressions) AS impressions,
            SUM(q.sum_position) AS sum_pos
          FROM read_parquet({{FILES}}, union_by_name = true) q
          ${useDim ? 'LEFT JOIN read_parquet({{QUERY_DIM}}, union_by_name = true) qd ON q.query = qd.query' : ''}
          WHERE q.query IS NOT NULL ${after}
          GROUP BY ${canonExpr}, q.query
          ORDER BY q.query
          LIMIT ${ROLLUP_PAGE_ROWS_WIDE}
        `,
      })
      for (const r of rows) {
        const joinKey = String(r.joinKey)
        let bucket = byCanonical.get(joinKey)
        if (!bucket) {
          bucket = { count: 0, top: [] }
          byCanonical.set(joinKey, bucket)
        }
        retainCanonicalVariant(
          bucket,
          String(r.query),
          Number(r.clicks),
          Number(r.impressions),
          Number(r.sum_pos),
        )
      }
      if (rows.length < ROLLUP_PAGE_ROWS_WIDE)
        break
      cursor = String(rows[rows.length - 1]!.query)
    }

    // Final per-canonical format (in JS over the merged variants). Each bucket
    // retained only its ranked top ten while streaming, but `count` still covers
    // every variant. This bounds memory by canonical count instead of raw query
    // cardinality and avoids sorting every variant at the end.
    const out: Array<{ joinKey: string, variantCount: bigint, canonicalName: string | null, variants: string | null }> = []
    for (const [joinKey, bucket] of byCanonical) {
      const canonicalName = bucket.top[0]?.query ?? null
      const top = bucket.top.filter(v => v.impressions > 0)
      const variantsStr = top.length === 0
        ? null
        : top.map(v => `${v.query}:::${v.clicks}:::${v.impressions}:::${(v.sumPos / v.impressions + 1).toFixed(1)}`).join('||')
      out.push({ joinKey, variantCount: BigInt(bucket.count), canonicalName, variants: variantsStr })
    }
    return out
  },
}

const CANONICAL_DAILY_ROLLUP_FINAL_ID = 'query_canonical_daily'
const CANONICAL_DAILY_PART_STEM = 'query_canonical_daily__part'

/**
 * Canonical-grained fact aggregate (ADR-0018 Gap 2): pre-sums the raw
 * `(query × date)` query rows to `(query_canonical × date)`, so canonical-
 * primary top/gaining/losing reads a small pre-aggregated table instead of
 * re-collapsing variants on every request. Metrics are additive, so summing
 * these per-date sums over a window is exact — identical to aggregating the raw
 * rows.
 *
 * Null-free by construction: groups by the versioned query dimension when it
 * exists, with raw query as the fallback, so the rollup never carries a NULL/''
 * canonical bucket and the read path can treat the rollup's `query_canonical`
 * column as already-derived.
 *
 * Date-grained full history (`windowDays: null`): one rollup serves every date
 * range (reads filter by `date`) and both windows of a comparison. Opt-in (not
 * in `DEFAULT_ROLLUPS`); the host points the main query's file set at it for
 * queries the rollup covers (see `canonicalRollupCovers` /
 * `RunOptimizedQueryOptions.canonicalSource`).
 */
export const queryCanonicalDailyRollup: RollupDef = {
  id: 'query_canonical_daily',
  windowDays: null,
  format: 'parquet',
  parquetColumns: [
    { name: 'query_canonical', type: 'VARCHAR', nullable: false },
    { name: 'date', type: 'DATE', nullable: false },
    { name: 'clicks', type: 'BIGINT', nullable: false },
    { name: 'impressions', type: 'BIGINT', nullable: false },
    { name: 'sum_position', type: 'DOUBLE', nullable: false },
  ],
  parquetSortKey: ['date', 'query_canonical'],
  async build({ engine, ctx, dataSource, searchType }) {
    // Prefer the versioned query dimension when present: derive canonical from
    // it (JOIN on raw query) so the rollup reflects the CURRENT normalizer
    // version without re-ingesting facts — a rebuild of the small dimension is
    // enough. Falls back to raw query grouping when the dimension is absent.
    // See ADR-0019 / ADR-0020.
    const dimStore = createQueryDimStore({ dataSource })
    const useDim = (await dimStore.loadMeta(ctx)) !== null
    const canonExpr = useDim
      ? `COALESCE(qd.query_canonical, q.query)`
      : `query`

    // Byte-bounded date windows: `(query_canonical × date)` is unbounded for a
    // large site, so a single scan could exceed the Workers service-binding RPC
    // cap (32MiB Arrow). Each window date-filters and the grain is keyed by
    // date, so a date lands in exactly one window — the concat is exact.
    const rows = await runWindowed({
      engine,
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
      ...(useDim ? { extraFileSets: { QUERY_DIM: { table: 'queries', keys: [dimStore.parquetKey(ctx)] } } } : {}),
      // `(query_canonical × date)` row count scales with distinct canonicals, not
      // input bytes, so a byte-sized window can still over-produce on a high-
      // cardinality site (GSCDUMP-P: 20.5k rows tripped the old 10k cap). Page the
      // output by its unique (date, query_canonical) grain so each runSQL stays
      // bounded regardless of cardinality.
      paginate: { orderBy: 'date, query_canonical', pageRows: ROLLUP_PAGE_ROWS_DAILY },
      maxWindowDays: DAILY_MAX_WINDOW_DAYS,
      sqlFor: dailyWindowSqlFor(useDim, canonExpr),
    })
    return rows.map(mapDailyRow)
  },
}

// Shared between the one-shot `queryCanonicalDailyRollup.build` and the resumable
// `rebuildCanonicalDailyResumable` builder so the two can't drift.
function canonicalDailyShardPredicate(queryExpr: string, shardIndex: number, shardCount: number): string {
  return shardCount <= 1
    ? ''
    : ` AND (hash(${queryExpr}) % ${shardCount}) = ${shardIndex}`
}

function dailyWindowSqlFor(useDim: boolean, canonExpr: string): (w: { start: string, end: string }, shard?: { index: number, count: number }) => string {
  return useDim
    ? (w, shard) => `
        SELECT
          ${canonExpr} AS query_canonical,
          CAST(q.date AS VARCHAR) AS date,
          SUM(q.clicks)::BIGINT AS clicks,
          SUM(q.impressions)::BIGINT AS impressions,
          SUM(q.sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true) q
        LEFT JOIN read_parquet({{QUERY_DIM}}, union_by_name = true) qd ON q.query = qd.query
        WHERE q.date >= '${w.start}' AND q.date <= '${w.end}'${canonicalDailyShardPredicate('q.query', shard?.index ?? 0, shard?.count ?? 1)}
        GROUP BY ${canonExpr}, q.date
      `
    : (w, shard) => `
        SELECT
          ${canonExpr} AS query_canonical,
          CAST(q.date AS VARCHAR) AS date,
          SUM(q.clicks)::BIGINT AS clicks,
          SUM(q.impressions)::BIGINT AS impressions,
          SUM(q.sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true) q
        WHERE q.date >= '${w.start}' AND q.date <= '${w.end}'${canonicalDailyShardPredicate('q.query', shard?.index ?? 0, shard?.count ?? 1)}
        GROUP BY ${canonExpr}, q.date
      `
}

function mapDailyRow(r: Row): Row {
  return {
    query_canonical: String(r.query_canonical),
    date: String(r.date),
    clicks: BigInt(r.clicks as bigint | number),
    impressions: BigInt(r.impressions as bigint | number),
    sum_position: Number(r.sum_position),
  }
}

/**
 * Resumable, cross-invocation build of `query_canonical_daily` for a high-
 * cardinality site whose full windowed build exceeds one job reservation (300s).
 *
 * Each call builds from `(windowOffset, pageOffset)` until `deadlineMs`, writes
 * that batch's rows to a PART parquet, and returns `{ done:false, nextWindowOffset,
 * nextPageOffset }` for the caller to re-enqueue. When the last window is fully
 * paged it publishes a multi-file envelope listing every part (parts are disjoint
 * by `(query_canonical, date)`, so the read path just unions them — no merge),
 * returning `{ done:true }`. `builtAt` MUST be stable across the continuation chain
 * (it versions both the part keys and the final rollup key).
 *
 * INTRA-WINDOW resumability: the deadline is checked between raw-query hash shards,
 * not just between date windows. A single high-cardinality day can spend a full
 * reservation inside one grouped/sorted aggregate before the deadline check gets
 * control back. `pageOffset` is the next shard index for the current window, so a
 * continuation resumes the SAME day at the next shard. Parts are keyed by
 * `(windowOffset, pageOffset)`; multiple parts may contain the same canonical/date
 * from different raw-query shards, and rollup reads sum over the union.
 */
export async function rebuildCanonicalDailyResumable(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  dataSource: DataSource
  searchType?: SearchType
  builtAt: number
  windowOffset: number
  /** Resume the `windowOffset` window at this shard offset (0 = window start). */
  pageOffset?: number
  /** Output rows per page (default `ROLLUP_PAGE_ROWS_DAILY`). Injectable for tests. */
  pageRows?: number
  /** Cap each input window's day span (default `DAILY_MAX_WINDOW_DAYS`). */
  maxWindowDays?: number
  /** Split each date window by raw-query hash before grouping (1 = no sharding). */
  shardCount?: number
  deadlineMs: number
}): Promise<{ done: boolean, nextWindowOffset: number, nextPageOffset: number, windowsTotal: number, windowsBuilt: number, rowsWritten: number }> {
  const { engine, ctx, dataSource, searchType, builtAt, windowOffset, deadlineMs } = opts
  const sType = searchType !== undefined ? { searchType } : {}
  const startPageOffset = opts.pageOffset ?? 0
  const pageRows = opts.pageRows ?? ROLLUP_PAGE_ROWS_DAILY
  const maxWindowDays = opts.maxWindowDays ?? DAILY_MAX_WINDOW_DAYS
  const shardCount = Math.max(1, Math.floor(opts.shardCount ?? 1))

  const parts = await engine.listPartitions({ ctx, table: 'queries', ...sType })
  const windows = planRollupWindows(parts.map(p => ({ partition: p.partition, bytes: p.bytes })), undefined, maxWindowDays)
  const windowsTotal = windows.length

  const dimStore = createQueryDimStore({ dataSource })
  const useDim = (await dimStore.loadMeta(ctx)) !== null
  const canonExpr = useDim
    ? `COALESCE(qd.query_canonical, q.query)`
    : `query`
  const extraFileSets = useDim ? { QUERY_DIM: { table: 'queries' as TableName, keys: [dimStore.parquetKey(ctx)] } } : undefined
  const sqlFor = dailyWindowSqlFor(useDim, canonExpr)
  const cols = queryCanonicalDailyRollup.parquetColumns!
  const sortKey = queryCanonicalDailyRollup.parquetSortKey

  // Build from (windowOffset, startPageOffset), sharding each window's raw query
  // input until the deadline (or all windows done). Each shard is FLUSHED to its own
  // PART immediately, so orchestrator memory stays bounded to one shard. Parts are
  // keyed by (window, shard); the read path sums over the union, so duplicate
  // canonical/date keys across raw-query shards remain exact.
  let i = windowOffset
  // `page` is the FIRST window's shard cursor; every later window starts at 0.
  let page = startPageOffset
  // Resume coordinates when we stop early. Default to "all done".
  let nextWindowOffset = windowsTotal
  let nextPageOffset = 0
  let rowsWritten = 0
  let pausedMidWindow = false
  const flushPage = async (windowIdx: number, pageOffset: number, rows: Row[]): Promise<void> => {
    if (rows.length === 0)
      return
    const key = rollupParquetKey(ctx, `${CANONICAL_DAILY_PART_STEM}__w${windowIdx}_p${pageOffset}`, builtAt, searchType)
    await dataSource.write(key, encodeRowsToParquetFlex(rows, { columns: cols, sortKey }))
    rowsWritten += rows.length
  }
  for (; i < windowsTotal; i++) {
    const w = windows[i]!
    for (; page < shardCount;) {
      const coreSql = sqlFor(w, { index: page, count: shardCount })
      const result = await engine.runSQL({
        ctx,
        table: 'queries',
        ...sType,
        fileSets: { FILES: { table: 'queries', partitions: w.partitions }, ...extraFileSets },
        sql: `${coreSql}\nORDER BY date, query_canonical\nLIMIT ${pageRows}`,
      })
      if (result.rows.length >= pageRows) {
        throw new Error(
          `query_canonical_daily shard overflow: window=${i} shard=${page}/${shardCount} returned >= ${pageRows} rows; increase shardCount or pageRows`,
        )
      }
      await flushPage(i, page, result.rows.map(mapDailyRow))
      page += 1
      if (Date.now() > deadlineMs) {
        // Pause mid-window; the continuation resumes THIS window at `page`.
        nextWindowOffset = i
        nextPageOffset = page
        pausedMidWindow = true
        break
      }
    }
    if (pausedMidWindow)
      break
    page = 0 // next window starts fresh
    // Full window built. Honour the deadline before starting the next one.
    if (Date.now() > deadlineMs) {
      nextWindowOffset = i + 1
      nextPageOffset = 0
      break
    }
  }

  if (nextWindowOffset < windowsTotal || nextPageOffset > 0)
    return { done: false, nextWindowOffset, nextPageOffset, windowsTotal, windowsBuilt: nextWindowOffset - windowOffset, rowsWritten }

  // FINAL window built → publish a MULTI-FILE envelope listing every part for this
  // builtAt. The read path unions the parts (disjoint dates). No decode+re-encode
  // of the whole rollup (the scaling bottleneck that timed out the merge): the
  // build is now genuinely O(rows) across invocations with no quadratic finalize.
  // Old-builtAt parts are orphaned; a GC sweep can prune them — the read path only
  // follows the latest envelope's `parquetKeys`.
  const partPrefixDir = rollupParquetKey(ctx, CANONICAL_DAILY_PART_STEM, builtAt, searchType).replace(/[^/]*$/, '')
  const partKeys = (await dataSource.list(partPrefixDir))
    .filter(k => k.includes(`${CANONICAL_DAILY_PART_STEM}__w`) && k.endsWith(`__v${builtAt}.parquet`))
    .sort()
  // Per-page flush writes nothing for empty pages, so a slice with zero rows would
  // leave no parts. Guarantee ≥1 file so the envelope always has a valid pointer.
  if (partKeys.length === 0) {
    const emptyKey = rollupParquetKey(ctx, `${CANONICAL_DAILY_PART_STEM}__w0_p0`, builtAt, searchType)
    await dataSource.write(emptyKey, encodeRowsToParquetFlex([], { columns: cols, sortKey }))
    partKeys.push(emptyKey)
  }
  const envelope: RollupEnvelope<ParquetRollupPointer> = {
    version: 1,
    id: CANONICAL_DAILY_ROLLUP_FINAL_ID,
    builtAt,
    windowDays: queryCanonicalDailyRollup.windowDays,
    payload: { parquetKey: partKeys[0]!, parquetKeys: partKeys, rowCount: 0 },
  }
  await dataSource.write(rollupKey(ctx, CANONICAL_DAILY_ROLLUP_FINAL_ID, builtAt, searchType), encodeJsonBigintSafe(envelope))
  return { done: true, nextWindowOffset, nextPageOffset, windowsTotal, windowsBuilt: nextWindowOffset - windowOffset, rowsWritten }
}
