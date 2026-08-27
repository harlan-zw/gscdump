/**
 * CONTRACT — file-resolution endpoint (Wave-2, frozen).
 *
 * The repurposed `analysis-sources` endpoint. It answers: "site X, range Y,
 * archetype Z → either the compacted Iceberg parquet files the browser should
 * download into OPFS, OR a server-tail directive."
 *
 * Replaces the old `AnalysisSourcesResponse` (`{ tables, manifestVersion,
 * coveragePlan }`) — the `coveragePlan` gap machinery is deleted under the
 * Iceberg model (a complete local snapshot has no gaps).
 *
 * The decision is per `(site, table)`: browser-eligible iff the compacted
 * Iceberg data for that pair is under the byte, row, and file-count ceilings.
 * Above any axis → server tail.
 *
 * TYPES ONLY.
 */

import type { GscSearchType } from './search-types'

/** The 6 Iceberg fact tables — string-typed here to avoid an engine dep. */
export type FileResolutionTable
  = 'pages' | 'queries' | 'countries' | 'page_queries' | 'dates' | 'search_appearance' | 'search_appearance_pages' | 'search_appearance_queries' | 'search_appearance_page_queries'

/** Request query params for `GET /api/sites/[siteId]/analysis-sources`. */
export interface FileResolutionRequest {
  /** `YYYY-MM-DD` inclusive. Required — no date range = no resolution. */
  start: string
  /** `YYYY-MM-DD` inclusive. */
  end: string
  searchType?: GscSearchType
  /**
   * Restrict resolution to these tables. Omitted = all 5. The archetype the
   * caller intends determines which tables it needs.
   */
  tables?: FileResolutionTable[]
  /** Client-derived browser attachment byte ceiling. */
  maxBytes?: number
  /** Client-derived browser attachment row ceiling. */
  maxRows?: number
  /** Client-derived per-table parquet file-count ceiling. */
  maxFiles?: number
  /**
   * The archetype the caller will run. Lets the endpoint route the 2
   * window-function archetypes straight to the server tail even when the
   * data would be browser-eligible by size.
   */
  archetype?: string
}

/**
 * One compacted Iceberg parquet data file the browser should fetch into OPFS.
 */
export interface ResolvedParquetFile {
  /**
   * Same-origin URL (`/api/r2-data/<key>?...`) carrying a signed size hint
   * and a short-lived exact-key access token. Stable for the file's lifetime
   * (content-addressed).
   */
  url: string
  /** Byte size — drives the browser-eligibility sum and OPFS quota planning. */
  bytes: number
  /**
   * Opaque content-stable identifier for this parquet file. Two requests for
   * the same bytes MUST return the same `contentHash`; any change in bytes
   * MUST yield a different one. The OPFS cache uses this as the file's
   * address (encoded into the cache filename) — it is NOT required to be a
   * SHA-256.
   *
   * In practice the server returns the Iceberg `data_file.file_path` object
   * key, which is UUID-derived and content-addressed by convention.
   */
  contentHash: string
  /** Row count, for eligibility accounting + diagnostics. */
  rowCount: number
}

/** Per-table resolution result. */
export interface ResolvedTable {
  table: FileResolutionTable
  /**
   * `'browser'` — `files` is populated; the browser downloads + attaches.
   * `'server'`  — this `(site, table)` exceeds the eligibility ceiling;
   *               `files` is empty and queries route to the server tail.
   */
  mode: 'browser' | 'server'
  /** Compacted Iceberg data files. Empty when `mode === 'server'`. */
  files: ResolvedParquetFile[]
  /**
   * Recent-window overlay parquet — the non-stable tail (the freshest days the
   * ingest stability cutoff excludes from the lake), materialized out-of-band at
   * `_recent_overlay/{site}/{searchType}/{table}.parquet`. When present, the
   * browser unions it with an anti-join dedup (the lake wins on any shared day;
   * the overlay supplies only days the lake lacks) so the freshest days serve
   * from the overlay instead of returning 0. Absent (`undefined`) when no
   * overlay exists for this `(site, searchType, table)` or for `mode: 'server'`.
   *
   * The overlay is OVERWRITTEN in place each sync, so its `contentHash` MUST
   * change whenever the bytes change (the server derives it from the R2 object
   * etag) — otherwise the OPFS cache would serve a stale overlay. The enclosing
   * `FileResolutionResponse.snapshotVersion` folds the overlay hash in for the
   * same reason (it gates browser re-attach).
   */
  overlay?: ResolvedParquetFile
  /** Total bytes across `files` — compared against the ceiling. */
  totalBytes: number
  /** Total rows across `files`. */
  totalRows: number
}

/** Server-tail directive — how an ineligible `(site, table)` is queried. */
export interface ServerTailDirective {
  /**
   * `'r2-sql'`  — server runs the query via R2 SQL over the Iceberg table.
   * `'duckdb'`  — server runs DuckDB-over-Iceberg-files (caller-supplied SQL,
   * or a query R2 SQL still can't run — see `dispatcher.ts` for the current
   * escalation rules, re-verified against real R2 SQL 2026-07-03; R2 SQL now
   * supports window functions, `COUNT(DISTINCT)`, JOINs and CTEs, so the split
   * is no longer a fixed "window functions → duckdb" rule).
   */
  engine: 'r2-sql' | 'duckdb'
  /** Endpoint the consumer POSTs the archetype query to. */
  endpoint: string
}

/** Response body of the file-resolution endpoint. */
export interface FileResolutionResponse {
  siteId: string
  searchType: GscSearchType
  range: { start: string, end: string }
  /**
   * Stable hash over the resolved file set. The browser re-attaches only when
   * this changes (new compaction landed). Replaces the old `manifestVersion`.
   */
  snapshotVersion: string
  generatedAt: string
  /** Per-table resolution. */
  tables: ResolvedTable[]
  /**
   * Present iff at least one table resolved to `mode: 'server'`. Tells the
   * consumer how to route the server-tail queries for those tables.
   */
  serverTail?: ServerTailDirective
  /**
   * The per-(site,table) browser-eligibility ceiling in effect, echoed so the
   * consumer can show "X is too large for local analysis" UX without
   * hard-coding the threshold.
   */
  eligibilityCeiling: { maxBytes: number, maxRows: number, maxFiles: number }
}

/** One canonical query-dimension sidecar object for browser attachment. */
export interface QueryDimSourceFile {
  url: string
  bytes: number
  contentHash: string
}

/** Response from the versioned query-dimension sidecar resolver. */
export interface QueryDimSourceResponse {
  file: QueryDimSourceFile | null
}

/** Multi-site file-resolution response. Inaccessible sites are omitted. */
export interface BulkFileResolutionResponse {
  generatedAt: string
  siteCount: number
  maxSites: number
  results: Record<string, FileResolutionResponse>
}

/** Request query for the multi-site file resolver. */
export interface BulkFileResolutionRequest extends FileResolutionRequest {
  /** Public site ids to resolve. Partner callers must supply this list. */
  siteIds?: string[]
}
