/**
 * `IcebergAppendSink` — prod `Sink`. Appends GSC fact rows directly to the
 * R2 Data Catalog Iceberg tables via `icebird` `icebergAppend()`.
 *
 * Replaced `PipelineSink` after the 2026-05-22 icebird ingest-writer spike
 * passed GO (design v6): the sync Worker commits Iceberg metadata itself —
 * no Cloudflare Pipelines, no Container, no PyIceberg. icebird is Workers-
 * first (Web Crypto SigV4, `fetch` I/O, no node builtins); the one WASM
 * blocker (`hyparquet-compressors`' eager snappy module) is removed by the
 * build-time `hysnappy` alias to a pure-JS shim.
 *
 * Ingest is 100% append-only (design v5): the 4-day stability cutoff means a
 * date is emitted exactly once, when finalized, and never revised. Cross-RUN
 * exactly-once is enforced upstream by the D1 `iceberg_ingested_days` ledger —
 * a later sync that re-emits a stabilized slice lands a fresh commit the sink
 * cannot see. WITHIN a commit, `dedupeByIdentity` collapses duplicate identity
 * tuples last-wins, so a retried/overlapping `emit` cannot double-count; reads
 * `SUM/GROUP BY` and never dedupe, so this commit boundary is the only guard.
 *
 * ## Buffer per table, one commit per `close()`
 *
 * `emit` does NOT write — it buffers rows per Iceberg table. `close()` flushes
 * each table with a single `icebergAppend()`. This is deliberate: R2 Data
 * Catalog rate-limits commits per table ("too many commits to this table"),
 * and a sync job emits one slice per `(site, searchType, date)` — dozens of
 * slices per table. One commit per table per job stays well inside the limit;
 * one commit per slice does not. icebird partitions the buffered rows across
 * `(site_id, search_type, month(date))` internally, so a single append still
 * lands every partition correctly. icebird retries the catalog commit on
 * 412/409 (optimistic concurrency) without re-uploading data files.
 *
 * The small-file fan-out (one parquet per partition per append) is expected
 * and handled by R2 Data Catalog managed compaction (unchanged from v5/v6).
 *
 * The 5 fact tables share one global Iceberg table each (`gsc.<table>`);
 * `site_id` + `search_type` are real Iceberg identity-partition columns,
 * injected here from `slice` — callers MUST NOT pre-populate them.
 */

import type { EngineError } from '../errors'
import type { IcebergAppendSinkOptions, Sink, SinkCloseResult, SinkSlice, SinkWriteResult } from '../sink'
import type { Row } from '../storage'
import type { IcebergConnection } from './catalog'
import type { IcebergTableName, PartitionKeyEncoding } from './schema'
import { engineErrors } from '../errors'
import { TABLE_METADATA } from '../schema'
import {
  connectIcebergCatalog,
  icebergAppendRetrying,
} from './catalog'
import { DEFAULT_PARTITION_KEY_ENCODING, ICEBERG_SCHEMAS, SEARCH_TYPE_INT } from './schema'

export type IcebergAppendSink = Sink

/**
 * An icebird append record — table data columns + injected partition identity
 * columns. The identity columns are STRING under `'string'` encoding and plain
 * `number` (site_id INT, search_type INT) under `'int'` — a small INT site_id is
 * ample (≪ 2.1B sites) and avoids the R2 SQL string-equality undercount, so no
 * LONG/BigInt is needed.
 */
type IcebergRecord = Record<string, unknown> & {
  site_id: string | number
  search_type: string | number
}

const DAY_MILLIS = 86_400_000
const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647

/**
 * Convert a row's `date` to the integer "days since the Unix epoch" the
 * Iceberg `date` type stores. icebird's `month(date)` partition transform
 * accepts the integer day-count just as it accepts a `Date`
 * (`dateAsMillis` multiplies a numeric `date` value by a day in ms).
 *
 * Why an integer, not a `Date`: hyparquet-writer 0.15.1 mis-encodes a
 * dictionary-encoded `date` column whose values are JS `Date` objects — the
 * dictionary page is written corrupt, so DuckDB / pyarrow read every `date`
 * back as NULL ("dictionary offset out of range"). Passing the pre-converted
 * integer keeps the column on hyparquet-writer's plain-number path, which
 * dictionary-dedupes and round-trips correctly. A `YYYY-MM-DD` string, an
 * existing `Date`, and an already-numeric day-count are all normalised here;
 * anything else passes through untouched.
 */
function toIcebergDate(value: unknown): unknown {
  if (typeof value === 'string') {
    const ms = Date.parse(`${value}T00:00:00Z`)
    // `Date.parse` yields NaN for an empty or malformed date. Writing NaN into
    // the Iceberg `date` column corrupts the parquet/partition silently, so
    // fail loudly instead.
    if (Number.isNaN(ms))
      throw new TypeError(`toIcebergDate: invalid date string '${value}'`)
    return Math.floor(ms / DAY_MILLIS)
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      throw new TypeError('toIcebergDate: invalid Date (NaN)')
    return Math.floor(ms / DAY_MILLIS)
  }
  return value
}

/**
 * Coerce a column value to a JSON-serializable form. BigInt values flow in
 * from D1 backfills (D1 returns INTEGER columns as bigint when the value
 * exceeds Number.MAX_SAFE_INTEGER, and sometimes even when it doesn't) and
 * fail JSON.stringify inside icebird's commit path with "Do not know how to
 * serialize a BigInt". Iceberg LONG columns fit Number's 2^53 precision for
 * any plausible GSC metric, so the lossy coercion is safe; values past 2^53
 * would already have been clamped at the GSC API boundary.
 */
function coerceJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint')
    return Number(value)
  return value
}

function toIntPartitionSiteId(value: unknown): number {
  if (value == null || (typeof value === 'string' && value.trim() === ''))
    throw new TypeError('toRecords: slice.ctx.siteId is required for int partition encoding')
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    throw new TypeError(`toRecords: int partition site_id must be a safe integer, got '${String(value)}'`)

  const siteId = Number(value)
  if (!Number.isSafeInteger(siteId))
    throw new TypeError(`toRecords: int partition site_id must be a safe integer, got '${String(value)}'`)
  if (siteId < INT32_MIN || siteId > INT32_MAX)
    throw new TypeError(`toRecords: int partition site_id must fit Iceberg INT, got '${String(value)}'`)
  return siteId
}

/**
 * Collapse buffered records that share an Iceberg identity tuple
 * (`site_id` + `search_type` + the table's natural key) to one survivor,
 * last-wins.
 *
 * The append commit is the ONLY dedup boundary in the Iceberg model: reads
 * `SUM(metric) GROUP BY <dimensions>` (never by the natural key), so two rows
 * with the same identity tuple double-count their metrics with no downstream
 * correction — the exact class the 2026-04 compaction corruption produced.
 *
 * Scope is the single commit. This guards the intra-commit case: a retried or
 * overlapping `emit` within one sink lifecycle, and byte-identical re-fetches.
 * Cross-RUN exactly-once is still the ingest ledger's job — a later sync that
 * re-emits a stabilized slice lands a fresh `icebergAppend` this function never
 * sees, so retiring that ledger requires a read-before-append (or equivalent),
 * not just this guard. Last-wins so a revised metric supersedes a stale one
 * when both are buffered.
 *
 * Keyed on `identityColumns` (which includes `site_id`/`search_type`), NOT the
 * bare table sortKey, so the same `(date, dimension)` across different sites or
 * search types is never collapsed.
 */
function dedupeByIdentity(table: IcebergTableName, records: IcebergRecord[]): IcebergRecord[] {
  if (records.length < 2)
    return records
  const key = ICEBERG_SCHEMAS[table].identityColumns
  const seen = new Map<string, IcebergRecord>()
  for (const rec of records) {
    const k = key.map(col => `${rec[col] ?? ''}`).join('\0')
    seen.set(k, rec)
  }
  // Fast path: no collisions, return the original array untouched.
  return seen.size === records.length ? records : [...seen.values()]
}

/**
 * Reorder a commit's records into `clusterKey` (dimension-first) order before
 * handing them to icebird.
 *
 * icebird splits the buffer into one parquet file per partition (site_id,
 * search_type, month(date)); clustering the buffer first means each of those
 * files lands dimension-sorted, so its row groups carry tight per-`url`/`query`
 * bounds (row-group skipping for `WHERE url = …`) and its repeated dimension
 * values form long dictionary/RLE runs instead of being interleaved across
 * appends. Same mechanism the DuckDB compaction `ORDER BY clusterKey` exploits,
 * where it measured ~28-42% smaller files and ~2.5x faster point lookups on
 * real data. Correctness-safe: reads aggregate `SUM(metric) GROUP BY <dims>`, so
 * physical row order never affects a result. A stable sort keeps the
 * last-wins dedup survivor intact for equal cluster keys.
 */
function sortByClusterKey(table: IcebergTableName, records: IcebergRecord[]): IcebergRecord[] {
  const cols = TABLE_METADATA[table].clusterKey
  if (cols.length === 0 || records.length < 2)
    return records
  return records.slice().sort((a, b) => {
    for (const col of cols) {
      const av = a[col]
      const bv = b[col]
      if (av === bv)
        continue
      if (av == null)
        return -1
      if (bv == null)
        return 1
      if (typeof av === 'number' && typeof bv === 'number')
        return av - bv
      const as = String(av)
      const bs = String(bv)
      if (as !== bs)
        return as < bs ? -1 : 1
    }
    return 0
  })
}

/**
 * Build the icebird append records for a slice — inject identity columns, encode
 * `date`. Under `'int'` encoding `site_id` is written as a plain `number` (INT —
 * the caller passes the numeric id in `ctx.siteId`) and `search_type` as its
 * {@link SEARCH_TYPE_INT} code (INT); int identity values are fixed-width so
 * R2 SQL prunes `WHERE site_id=<n>` correctly (no CONCAT workaround needed).
 * The probe (gscdump.com probe-int64-engine-e2e, 2026-06-19) confirmed the full
 * int-partition append + commit + read path round-trips on real R2.
 */
function toRecords(slice: SinkSlice, rows: readonly Row[], encoding: PartitionKeyEncoding): IcebergRecord[] {
  // 'int': site_id is a small INT (the app's user_sites.int_id), search_type its
  // INT enum code — both plain numbers (INT columns), no BigInt.
  const siteVal: string | number = encoding === 'int'
    ? toIntPartitionSiteId(slice.ctx.siteId)
    : slice.ctx.siteId ?? ''
  const searchVal: string | number = encoding === 'int' ? SEARCH_TYPE_INT[slice.searchType] : slice.searchType
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const k in row) out[k] = coerceJsonSafe((row as Record<string, unknown>)[k])
    out.date = toIcebergDate(out.date)
    out.site_id = siteVal
    out.search_type = searchVal
    return out as IcebergRecord
  })
}

/**
 * Create an `IcebergAppendSink` over the R2 Data Catalog.
 *
 * `emit` buffers; `close()` commits one `icebergAppend()` per table touched.
 * The catalog connection (REST context + signed S3 resolver) is established
 * lazily on the first flush and reused — a sink that is opened and closed
 * with no rows never touches the network.
 */
export function createIcebergAppendSink(options: IcebergAppendSinkOptions): IcebergAppendSink {
  let connection: Promise<IcebergConnection> | undefined
  const encoding: PartitionKeyEncoding = options.encoding ?? DEFAULT_PARTITION_KEY_ENCODING
  // Per-table row buffer, drained by `close()`.
  const buffers = new Map<IcebergTableName, IcebergRecord[]>()

  function connect(): Promise<IcebergConnection> {
    connection ??= connectIcebergCatalog(options.catalog)
    return connection
  }

  return {
    capabilities: { appendOnly: true },

    async emit(slice: SinkSlice, rows: readonly Row[]): Promise<SinkWriteResult> {
      if (rows.length === 0)
        return { rowCount: 0 }
      const records = toRecords(slice, rows, encoding)
      const buffer = buffers.get(slice.table)
      // NB: never spread `records` into `push`/an array literal — a whale
      // slice is hundreds of thousands of rows, and `push(...records)` passes
      // every record as a function argument, overflowing the call stack
      // (`RangeError: Maximum call stack size exceeded`) past ~125k rows. A
      // bounded loop appends in O(n) with constant stack depth.
      if (buffer) {
        for (let i = 0; i < records.length; i++)
          buffer.push(records[i])
      }
      else {
        buffers.set(slice.table, records)
      }
      // Rows are accepted into the buffer; the durable commit happens in close().
      return { rowCount: records.length }
    },

    /**
     * Flush every buffered table — one `icebergAppend()` commit each, with
     * 429 retry. Per-table failures are CAPTURED, not thrown: a table whose
     * commit fails lands in `failed` while the others still commit and land
     * in `flushed`, so `sinkAsIngestEngine` can ledger-record only the slices
     * that actually reached Iceberg. The ledger never runs ahead of Iceberg.
     *
     * Idempotent: after a flush the buffers are empty, so a second `close()`
     * reports empty `flushed`/`failed`.
     */
    async close(): Promise<SinkCloseResult> {
      const flushed: IcebergTableName[] = []
      const failed: { table: IcebergTableName, error: EngineError }[] = []
      if (buffers.size === 0)
        return { flushed, failed }

      // Resolving the catalog connection can itself fail (network, auth). If
      // it does, NO table flushed — report them all as failed so none of
      // their slices are ledger-recorded. `connectError` is the original cause
      // shared across every table's typed flush error.
      const conn = await connect().then(
        (c): IcebergConnection | { connectError: unknown } => c,
        (cause: unknown) => {
          // Drop the cached rejected promise so a retry re-connects cleanly.
          connection = undefined
          return { connectError: cause }
        },
      )
      if ('connectError' in conn) {
        for (const [table, records] of buffers) {
          if (records.length > 0)
            failed.push({ table, error: engineErrors.sinkTableFlushFailed(table, conn.connectError) })
        }
        buffers.clear()
        return { flushed, failed }
      }

      for (const [table, records] of buffers) {
        if (records.length === 0)
          continue
        // Dedup at the commit boundary — the only dedup point in the append
        // model (reads SUM/GROUP BY, never by natural key). See dedupeByIdentity.
        const deduped = sortByClusterKey(table, dedupeByIdentity(table, records))
        await icebergAppendRetrying(
          {
            catalog: conn.catalog,
            namespace: conn.namespace,
            table,
            resolver: conn.resolver,
            records: deduped,
          },
          options.commitRetry,
        ).then(
          () => { flushed.push(table) },
          (cause: unknown) => { failed.push({ table, error: engineErrors.sinkTableFlushFailed(table, cause) }) },
        )
      }
      buffers.clear()
      return { flushed, failed }
    },
  }
}
