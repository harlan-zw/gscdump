/**
 * `IcebergAppendSink` — prod `Sink`. Appends GSC fact rows directly to the
 * R2 Data Catalog Iceberg tables via `icebird` `icebergAppend()`.
 *
 * The 2026-05-22 icebird ingest-writer spike replaced the superseded
 * Cloudflare Pipelines design: the sync Worker commits Iceberg metadata itself —
 * no Cloudflare Pipelines, no Container, no PyIceberg. icebird is Workers-
 * first (Web Crypto SigV4, `fetch` I/O, no node builtins); the one WASM
 * blocker (`hyparquet-compressors`' eager snappy module) is removed by the
 * build-time `hysnappy` alias to a pure-JS shim.
 *
 * Ingest is 100% append-only (design v5): the 4-day stability cutoff means a
 * date is emitted exactly once, when finalized, and never revised. Cross-RUN
 * exactly-once is enforced upstream by the D1 `iceberg_ingested_days` ledger —
 * a later sync that re-emits a stabilized slice lands a fresh commit the sink
 * cannot see. WITHIN a commit, `clusterAndDedupe` collapses duplicate identity
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
 *
 * ADR-0021 R2-FIXES C5 (amendment 10): this sink is a THIN ADAPTER over the
 * `gsc.*` `IcebergDataset` registry instances (`./schema.ts`'s `gscDataset`,
 * built on `@gscdump/lakehouse`'s `defineIcebergDataset`) — the dedupe key
 * and the physical pre-sort (both in `clusterAndDedupe`) read
 * `tableSpec.identityColumns`/`.clusterKey` from the dataset def instead of
 * the frozen `ICEBERG_SCHEMAS`/`TABLE_METADATA` constants (those constants
 * are themselves now def-derived — see `./schema.ts` — so this is a direct,
 * not transitive, read). The `search_type` partition-value mapping also
 * reads through the def's `dims.search_type.toPartitionValue` rather than a
 * second inline `SEARCH_TYPE_INT` lookup.
 *
 * Deliberately NOT routed through the dataset's `prepareRows`/`appendSink`
 * guard-and-buffer pipeline: that pipeline SILENTLY DROPS a row whose
 * required identity value is missing/out-of-range (the behavior nuxtseo's
 * newer single-table `crawl.*`/`lighthouse.*`/`dataforseo.*` writers adopt).
 * GSC's `Sink` contract instead THROWS synchronously on an invalid `'int'`
 * `site_id` (see `toIntPartitionSiteId`) and, for legacy `'string'` encoding,
 * writes an empty `site_id` through rather than dropping the row — both are
 * pre-existing, test-pinned behaviors this port preserves byte-for-byte
 * rather than silently swapping in the drop-on-invalid-identity semantics.
 */

import type { EngineError } from '../errors'
import type { IcebergAppendSinkOptions, Sink, SinkCloseResult, SinkSlice, SinkWriteResult } from '../sink'
import type { Row } from '../storage'
import type { IcebergConnection } from './catalog'
import type { IcebergTableName, PartitionKeyEncoding } from './schema'
import { engineErrors } from '../errors'
import {
  connectIcebergCatalog,
  icebergAppendRetrying,
} from './catalog'
import { DEFAULT_PARTITION_KEY_ENCODING, gscDataset } from './schema'

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
 * Compare two identity values the way the pre-2026-09 string-keyed dedupe
 * did: `null`/`undefined` equal `''`, numbers order numerically, anything else
 * orders by its string form. Two values compare equal exactly when their
 * `${v ?? ''}` forms match, so a collapse here is the same collapse the old
 * `Map<string, …>` key produced.
 */
function compareIdentityValue(av: unknown, bv: unknown): number {
  if (av === bv)
    return 0
  if (typeof av === 'number' && typeof bv === 'number')
    return av - bv
  const as = `${av ?? ''}`
  const bs = `${bv ?? ''}`
  if (as === bs)
    return 0
  return as < bs ? -1 : 1
}

/**
 * Sort a commit's records into `clusterKey` (dimension-first) order, then
 * collapse records that share an Iceberg identity tuple (`site_id` +
 * `search_type` + the table's natural key) to one survivor, last-wins. Works
 * IN PLACE on `records` and returns it truncated to the survivors.
 *
 * Why sort-then-collapse and not a `Map<identity, record>`: a whale job
 * buffers hundreds of thousands of records in a 128 MB isolate. A string
 * identity key per record costs about as much as the record itself, and the
 * old path held the buffer, the keyed map and a sorted copy at once. Sorting
 * by `clusterKey` and then by the remaining identity columns makes duplicates
 * adjacent, so one linear pass removes them with no extra allocation.
 *
 * Clustering: icebird splits the buffer into one parquet file per partition
 * (site_id, search_type, month(date)); clustering first means each of those
 * files lands dimension-sorted, so its row groups carry tight per-`url`/`query`
 * bounds and its repeated dimension values form long dictionary/RLE runs.
 * Same mechanism the DuckDB compaction `ORDER BY clusterKey` exploits (~28-42%
 * smaller files, ~2.5x faster point lookups on real data). Correctness-safe:
 * reads aggregate `SUM(metric) GROUP BY <dims>`, so physical order never
 * affects a result.
 *
 * Dedupe: the append commit is the ONLY dedup boundary in the Iceberg model.
 * Reads `SUM(metric) GROUP BY <dimensions>` (never by the natural key), so two
 * rows with the same identity tuple double-count with no downstream correction
 * (the 2026-04 compaction corruption class). Scope is the single commit: a
 * retried or overlapping `emit` within one sink lifecycle. Cross-RUN
 * exactly-once is still the ingest ledger's job. `Array.prototype.sort` is
 * stable, so within a run of equal identities the last element is the last
 * one emitted: a revised metric supersedes a stale one. Keyed on
 * `identityColumns` (which include `site_id`/`search_type`), so the same
 * `(date, dimension)` across sites or search types never collapses.
 */
function clusterAndDedupe(table: IcebergTableName, records: IcebergRecord[]): IcebergRecord[] {
  if (records.length < 2)
    return records
  // Column names are encoding-independent, so `'int'` is an arbitrary fixed
  // choice (ADR-0021 amendment 3: read from the dataset def).
  const spec = gscDataset(table, 'int').tableSpec
  const cluster = spec.clusterKey ?? []
  const order = [...cluster, ...spec.identityColumns.filter(col => !cluster.includes(col))]
  const compare = (a: IcebergRecord, b: IcebergRecord): number => {
    for (const col of order) {
      const c = compareIdentityValue(a[col], b[col])
      if (c !== 0)
        return c
    }
    return 0
  }
  records.sort(compare)
  let write = 0
  for (let read = 0; read < records.length; read++) {
    const rec = records[read]!
    // A following record with the same identity supersedes this one.
    if (read + 1 < records.length && compare(rec, records[read + 1]!) === 0)
      continue
    records[write++] = rec
  }
  records.length = write
  return records
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
  // search_type's partition-value mapping is read from the dataset def's
  // `dims` declaration (ADR-0021 amendment 5) instead of a second inline
  // `SEARCH_TYPE_INT` lookup — one definition of the mapping, not two.
  const searchVal: string | number = gscDataset(slice.table, encoding).def.dims!.search_type.toPartitionValue(slice.searchType)
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
 * with no rows never touches the network. `options.connect` is forwarded so
 * Worker callers can share the `/v1/config` context through a durable cache;
 * without it every fresh sink/isolate must probe the catalog again.
 */
export function createIcebergAppendSink(options: IcebergAppendSinkOptions): IcebergAppendSink {
  let connection: Promise<IcebergConnection> | undefined
  const encoding: PartitionKeyEncoding = options.encoding ?? DEFAULT_PARTITION_KEY_ENCODING
  // Per-table row buffer, drained by `close()`.
  const buffers = new Map<IcebergTableName, IcebergRecord[]>()

  function connect(): Promise<IcebergConnection> {
    connection ??= connectIcebergCatalog(options.catalog, options.connect)
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
        // Dedup at the commit boundary, the only dedup point in the append
        // model (reads SUM/GROUP BY, never by natural key). In place: the
        // buffer is private and cleared below. See clusterAndDedupe.
        const deduped = clusterAndDedupe(table, records)
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
