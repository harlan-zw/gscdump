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
 * date is emitted exactly once, when finalized, and never revised. Exactly-once
 * is enforced upstream by the D1 `iceberg_ingested_days` ledger — re-emitting a
 * slice would append duplicate rows.
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

import type { IcebergConnection } from '../iceberg-catalog'
import type { IcebergTableName } from '../iceberg-schema'
import type { IcebergAppendSinkOptions, Sink, SinkCloseResult, SinkSlice, SinkWriteResult } from '../sink'
import type { Row } from '../storage'
import {
  connectIcebergCatalog,
  icebergAppendRetrying,
} from '../iceberg-catalog'

export type IcebergAppendSink = Sink

/** An icebird append record — table data columns + injected partition identity columns. */
type IcebergRecord = Record<string, unknown> & {
  site_id: string
  search_type: string
}

const DAY_MILLIS = 86_400_000

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
  if (typeof value === 'string')
    return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MILLIS)
  if (value instanceof Date)
    return Math.floor(value.getTime() / DAY_MILLIS)
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

/** Build the icebird append records for a slice — inject identity columns, encode `date`. */
function toRecords(slice: SinkSlice, rows: readonly Row[]): IcebergRecord[] {
  const siteId = slice.ctx.siteId ?? ''
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const k in row) out[k] = coerceJsonSafe((row as Record<string, unknown>)[k])
    out.date = toIcebergDate(out.date)
    out.site_id = siteId
    out.search_type = slice.searchType
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
      const records = toRecords(slice, rows)
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
      const failed: { table: IcebergTableName, error: string }[] = []
      if (buffers.size === 0)
        return { flushed, failed }

      // Resolving the catalog connection can itself fail (network, auth). If
      // it does, NO table flushed — report them all as failed so none of
      // their slices are ledger-recorded.
      const conn = await connect().then(
        (c): IcebergConnection | { error: string } => c,
        (err: unknown) => {
          // Drop the cached rejected promise so a retry re-connects cleanly.
          connection = undefined
          return { error: String(err) }
        },
      )
      if ('error' in conn) {
        for (const [table, records] of buffers) {
          if (records.length > 0)
            failed.push({ table, error: conn.error })
        }
        buffers.clear()
        return { flushed, failed }
      }

      for (const [table, records] of buffers) {
        if (records.length === 0)
          continue
        await icebergAppendRetrying(
          {
            catalog: conn.catalog,
            namespace: conn.namespace,
            table,
            resolver: conn.resolver,
            records,
          },
          options.commitRetry,
        ).then(
          () => { flushed.push(table) },
          (err: unknown) => { failed.push({ table, error: String(err) }) },
        )
      }
      buffers.clear()
      return { flushed, failed }
    },
  }
}
