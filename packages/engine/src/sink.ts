/**
 * CONTRACT — `Sink` interface (Wave-1, frozen).
 *
 * The write abstraction the GSC sync emits fact rows through. Replaces the
 * `engine.writeDay()` call at the ingest accumulator's flush boundary
 * (`server/utils/analytics/write-hook.ts`).
 *
 * Three implementations, all conforming to this interface:
 * - `IcebergAppendSink` — prod. Appends rows directly to the R2 Data Catalog
 *                      Iceberg table via `icebird` `icebergAppend()`, run
 *                      in-Worker. Append-only. (Replaced `PipelineSink` once
 *                      the icebird ingest-writer spike passed — design v6.)
 * - `LocalIcebergSink` — local tests. Writes to a real Iceberg table via a
 *                      PyIceberg / DuckDB Iceberg writer (the POC stack).
 * - `InMemorySink`   — unit tests. Collects emitted rows in memory.
 *
 * Design constraints baked into the shape:
 * - GSC fetch logic (`runGscSyncSlice`) is UNCHANGED — only the sink swaps.
 * - The unit of emission is one (table, site, searchType, date) slice — the
 *   exact granularity the sync produces.
 * - Ingest is 100% APPEND-ONLY (design v5, 2026-05-22). GSC restates data for
 *   weeks; rather than chase revisions with a partition-overwrite writer, a
 *   date is ingested only once it is `>= STABILITY_CUTOFF_DAYS` old and then
 *   treated as canonical forever. There is no overwrite path. Exactly-once is
 *   enforced upstream by the D1 ingested-days ledger.
 *
 * TYPES + INTERFACE ONLY — no emission logic.
 */

import type { IcebergTableName, SearchType } from './iceberg-schema'
import type { Row, TenantCtx } from './storage'

/**
 * Identifies one fact slice — the atomic unit a sink emits.
 * `(table, site, searchType, date)`. `userId` rides along on `ctx` for
 * tenant-scoped sinks (local/in-memory); the prod Iceberg table is global
 * and keys only on `siteId`.
 */
export interface SinkSlice {
  ctx: TenantCtx
  table: IcebergTableName
  /** GSC search-type partition. */
  searchType: SearchType
  /** Calendar day (PT), `YYYY-MM-DD`. The slice's `month(date)` partition. */
  date: string
}

/**
 * Outcome of a sink write. `rowCount` is the number of rows accepted;
 * `bytes` is best-effort — `IcebergAppendSink` does not report it (undefined there).
 */
export interface SinkWriteResult {
  rowCount: number
  bytes?: number
}

/**
 * Static description of a sink. All sinks are append-only under the v5
 * stability-cutoff model; `appendOnly` is therefore always `true` and kept
 * only as an explicit, self-documenting marker.
 */
export interface SinkCapabilities {
  /** Always `true` — re-emitting a slice accumulates duplicate rows. */
  appendOnly: true
}

/**
 * Outcome of `Sink.close()` — which tables' buffered rows reached durable
 * storage and which failed.
 *
 * `IcebergAppendSink.emit` only BUFFERS; the durable Iceberg commit happens
 * in `close()`, one `icebergAppend()` per table. The ingest ledger
 * (`sinkAsIngestEngine`) records a `(site, table, searchType, date)` slice
 * ONLY after the table holding it appears in `flushed` — a table in `failed`
 * leaves its slices un-recorded so the next sync re-emits them. This is what
 * keeps the D1 ledger from ever running ahead of Iceberg.
 */
export interface SinkCloseResult {
  /** Tables whose buffered rows committed durably. */
  flushed: IcebergTableName[]
  /** Tables whose flush failed — their slices must NOT be ledger-recorded. */
  failed: { table: IcebergTableName, error: string }[]
}

export interface Sink {
  readonly capabilities: SinkCapabilities

  /**
   * Emit the fact rows for one slice. Append semantics — for `IcebergAppendSink`
   * this commits one Iceberg snapshot. Re-emitting the same slice produces
   * DUPLICATE rows; exactly-once is enforced upstream by the D1 ingested-days
   * ledger, which only calls `emit` for a slice once.
   *
   * `rows` carry the table's data columns; the sink injects the partition
   * identity columns (`site_id`, `search_type`) from `slice` — callers MUST
   * NOT pre-populate them.
   */
  emit: (slice: SinkSlice, rows: readonly Row[]) => Promise<SinkWriteResult>

  /**
   * Flush any buffered rows and release resources, returning which tables
   * reached durable storage. Idempotent — a second `close()` after a flush
   * reports empty `flushed`/`failed` (nothing left buffered).
   *
   * `IcebergAppendSink` buffers in `emit` and commits one `icebergAppend()`
   * per table HERE; `flushed`/`failed` reflect those per-table commits.
   * In-memory / local sinks write durably in `emit`, so they report every
   * table they received rows for as `flushed`.
   */
  close: () => Promise<SinkCloseResult>
}

/** Construction options shared by all sink implementations. */
export interface SinkOptions {
  now?: () => number
}

/**
 * `IcebergAppendSink`-specific options — the R2 Data Catalog coordinates the
 * sink appends to via `icebird`. The catalog config shape (`IcebergCatalogConfig`)
 * is type-only here so this contract file stays implementation-free.
 */
export interface IcebergAppendSinkOptions extends SinkOptions {
  /** R2 Data Catalog connection config (catalog URI, warehouse, namespace, token, S3 creds). */
  catalog: import('./iceberg-catalog').IcebergCatalogConfig
  /**
   * Retry policy for the per-table `icebergAppend()` commit, applied on R2
   * Data Catalog 429 ("too many commits") rate-limits. Optional — production
   * uses the defaults; tests inject a synchronous `sleep`.
   */
  commitRetry?: import('./iceberg-catalog').CommitRetryOptions
}

/** `LocalIcebergSink` options — points at the local Iceberg REST catalog. */
export interface LocalIcebergSinkOptions extends SinkOptions {
  /** Iceberg REST catalog URI (POC: `apache/iceberg-rest-fixture`). */
  catalogUri: string
  /** Catalog namespace the 5 tables live under. */
  namespace: string
  /** S3-compatible warehouse location (POC: MinIO). */
  warehouse: string
}
