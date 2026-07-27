import type { ColumnDef, Row, TenantCtx } from '@gscdump/contracts'
import type { ScheduleState } from '../schedule'
import type { DataSource } from '../storage'
import { decodeParquetToRows } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import { mapEntityIo } from './io'
// ---------------------------------------------------------------------------
// Sitemap snapshots
// ---------------------------------------------------------------------------
//
// GSC sitemap state is low-cardinality (typically <100 feeds per site) but
// time-varying: lastDownloaded, errors, warnings, per-content-type counts
// change as Google re-crawls. We snapshot it per site with the same
// index-plus-history pattern as inspections, just keyed by feedpath instead
// of URL.

/** GSC sitemap record we persist. Matches `Schema$WmxSitemap` but as plain JSON. */
export interface SitemapRecord {
  /** The sitemap URL (feedpath) as returned by GSC. */
  path: string
  /** ISO-8601 timestamp of the snapshot run that captured this record. */
  capturedAt: string
  /** Last time Google downloaded this sitemap (RFC 3339, from the API). */
  lastDownloaded?: string
  /** Last time the sitemap was submitted. */
  lastSubmitted?: string
  type?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  errors?: string
  warnings?: string
  /** Per-content-type counts (web, image, video, news). */
  contents?: Array<{
    type?: string
    submitted?: string
    indexed?: string
  }>
  /** Raw payload for fields we don't promote to first-class columns. */
  raw?: unknown
  /** Number of URLs observed in this feedpath at last snapshot. */
  urlCount?: number
  /** Stable hash of the sorted normalized loc list at last snapshot. */
  contentHash?: string
  /** Adaptive cadence state owned by `sitemapPolicy`. */
  schedule?: ScheduleState
}

export interface SitemapIndex {
  version: 1
  /** Map of feedpathHash → latest SitemapRecord. */
  records: Record<string, SitemapRecord>
}

export interface SitemapHistoryDoc {
  version: 1
  path: string
  capturedAt: string
  record: SitemapRecord
}

// Compacted URL state is partitioned by feedpath: one small `index.parquet`
// per sitemap, not one tenant-wide blob. Every sitemap operation (sync, diff,
// compaction) is scoped to a single feedpath, so storage is keyed the same
// way — peak memory is bounded by one sitemap's URL count, never the whole
// site's. Disposable state deltas compact into this index; immutable membership
// events remain available for historical analytics.
export const SITEMAP_URLS_EVENT_PREFIX_RE = /\/urls\/events\/(\d{4}-\d{2}-\d{2})__[0-9a-f]+__\d+__[0-9a-f]+\.parquet$/
export const SITEMAP_URLS_PENDING_GENERATION_RE = /\/urls\/generations\/pending\/([0-9a-f]+)\.json$/

/** Parsed URL entry from a sitemap XML. */
export interface ParsedUrl {
  loc: string
  /** ISO-8601 lastmod from the sitemap, if present. */
  lastmod?: string
}

/** A single URL row in the urls/index.parquet partition. */
export interface SitemapUrlRecord {
  feedpath: string
  feedpathHash: string
  urlHash: string
  loc: string
  lastmod?: string
  firstSeenAt: number
  lastSeenAt: number
  /** Set when the URL has been removed. Null/undefined = currently live. */
  removedAt?: number
}

export interface SnapshotUrlsResult {
  added: number
  removed: number
  kept: number
  contentHash: string
  /** True when current membership did not change. Initial history seeding may write. */
  unchanged: boolean
}

export interface CompleteSitemapGeneration {
  _tag: 'complete'
  id: string
  /** Unix epoch milliseconds. */
  observedAt: number
}

export interface ReconcileResult {
  /** Feedpaths that were absent from the live set and had their live URLs pruned. */
  feedpathsPruned: number
  /** Total URL rows transitioned live → removed across pruned feedpaths. */
  urlsRemoved: number
}

/**
 * Bounds on a single `compactUrls` call. `compactUrls` is memory-bounded (one
 * feedpath at a time) but was previously unbounded in TIME: a tenant with a
 * large accumulated delta backlog could run past a caller's execution budget.
 * Both bounds are checked BETWEEN feedpaths and only after at least one has
 * been compacted, so a call always makes forward progress.
 */
export interface CompactUrlsOptions {
  /** Stop before starting another feedpath once this many ms have elapsed. */
  deadlineMs?: number
  /** Stop after compacting this many feedpaths. */
  maxFeedpaths?: number
}

export interface CompactUrlsResult {
  /** Feedpaths whose active deltas were folded and retired by this call. */
  compactedFeedpaths: number
  /**
   * Feedpaths that still hold outstanding deltas. Call `compactUrls` again to
   * continue. No cursor is needed because the projection watermark excludes a
   * compacted feedpath's grace-retained deltas from the next call.
   */
  remainingFeedpaths: number
}

export interface DeltaEntry {
  feedpath: string
  feedpathHash: string
  urlHash: string
  op: 'added' | 'removed'
  loc: string
  lastmod?: string
  at: number
}

export interface SitemapMembershipEvent {
  feedpath: string
  feedpathHash: string
  urlHash: string
  op: 'added' | 'removed'
  loc: string
  lastmod?: string
  generationId: string
  /** Unix epoch milliseconds. */
  observedAt: number
  /** Stable ordering within one generation. */
  sequence: number
  /** Whether this row also mutates the disposable current-state projection. */
  projectsState: boolean
}

export interface DateRange {
  /** YYYY-MM-DD inclusive. */
  from?: string
  /** YYYY-MM-DD inclusive. */
  to?: string
}

export interface LoadUrlsOptions {
  includeRemoved?: boolean
}

export const URLS_INDEX_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'first_seen_at', type: 'BIGINT', nullable: false },
  { name: 'last_seen_at', type: 'BIGINT', nullable: false },
  { name: 'removed_at', type: 'BIGINT', nullable: true },
]

export const URLS_DELTA_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'op', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'at', type: 'BIGINT', nullable: false },
  { name: 'generation_id', type: 'VARCHAR', nullable: true },
]

export const URLS_EVENT_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'op', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'generation_id', type: 'VARCHAR', nullable: false },
  { name: 'observed_at', type: 'BIGINT', nullable: false },
  { name: 'sequence', type: 'INTEGER', nullable: false },
  { name: 'projects_state', type: 'INTEGER', nullable: false },
  { name: 'seed_generation', type: 'INTEGER', nullable: false },
  { name: 'generation_kind', type: 'VARCHAR', nullable: false },
  { name: 'content_hash', type: 'VARCHAR', nullable: true },
  { name: 'input_count', type: 'INTEGER', nullable: true },
]

export function rowToUrlRecord(row: Row): SitemapUrlRecord {
  return {
    feedpath: String(row.feedpath),
    feedpathHash: String(row.feedpath_hash),
    urlHash: String(row.url_hash),
    loc: String(row.loc),
    lastmod: row.lastmod == null ? undefined : String(row.lastmod),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    removedAt: row.removed_at == null ? undefined : Number(row.removed_at),
  }
}

export function urlRecordToRow(r: SitemapUrlRecord): Row {
  return {
    feedpath: r.feedpath,
    feedpath_hash: r.feedpathHash,
    url_hash: r.urlHash,
    loc: r.loc,
    lastmod: r.lastmod ?? null,
    first_seen_at: r.firstSeenAt,
    last_seen_at: r.lastSeenAt,
    removed_at: r.removedAt ?? null,
  }
}

export interface SitemapEventSeed {
  version: 1
  generationId: string
  observedAt: number
}

export interface SitemapSnapshotGenerationCheckpoint {
  _tag: 'snapshot'
  version: 1
  generationId: string
  observedAt: number
  eventDigest: string
  result: SnapshotUrlsResult
}

export interface SitemapReconcileGenerationCheckpoint {
  _tag: 'reconcile'
  version: 1
  generationId: string
  observedAt: number
  eventDigest: string
}

export type SitemapGenerationCheckpoint
  = | SitemapSnapshotGenerationCheckpoint
    | SitemapReconcileGenerationCheckpoint

export interface SitemapSiteGenerationCheckpoint {
  version: 1
  generationId: string
  observedAt: number
  inputDigest: string
}

export interface SitemapPendingGeneration {
  version: 1
  generationId: string
  observedAt: number
  eventKey: string
  eventDigest: string
}

export interface SitemapReadStore {
  /** Load the full site index (latest record per feedpath). */
  loadIndex: (ctx: TenantCtx) => Promise<SitemapIndex>
  /** Fetch the latest snapshot for a feedpath, or undefined. */
  getLatest: (ctx: TenantCtx, path: string) => Promise<SitemapRecord | undefined>
  /** Stream live (and optionally removed) URL rows for a feedpath. */
  loadUrls: (
    ctx: TenantCtx,
    feedpath: string,
    opts?: LoadUrlsOptions,
  ) => AsyncIterable<SitemapUrlRecord>
  /** Stream all delta entries within `[from, to]` (YYYY-MM-DD inclusive). */
  loadDeltas: (ctx: TenantCtx, dateRange?: DateRange) => AsyncIterable<DeltaEntry>
  /** Stream immutable membership events within `[from, to]`. */
  loadEvents: (ctx: TenantCtx, dateRange?: DateRange) => AsyncIterable<SitemapMembershipEvent>
}

export interface SitemapStore extends SitemapReadStore {
  /**
   * Persist a snapshot run. Updates the index + writes one immutable
   * history doc per record under `history/<feedpathHash>__<capturedAtMs>.json`.
   */
  writeSnapshot: (ctx: TenantCtx, records: readonly SitemapRecord[]) => Promise<void>
  /**
   * Diff a complete sitemap generation against current state. The immutable
   * membership event lands before its disposable state delta.
   */
  snapshotUrls: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    feedpath: string,
    urls: readonly ParsedUrl[],
  ) => Promise<SnapshotUrlsResult>
  /**
   * Fold accumulated deltas into the prior index, one feedpath at a time:
   * rewrites each touched feedpath's `by-feed/<hash>/index.parquet` and deletes
   * the consumed delta files. Bounded per feedpath, so it stays within memory
   * regardless of total site URL count.
   *
   * Optionally bounded in TIME too (`opts.deadlineMs` / `opts.maxFeedpaths`).
   * A bounded call is safe to stop mid-way: each rewritten feedpath advances
   * the projection watermark, so the remainder is simply what the next call
   * finds. Callers drive this from `remainingFeedpaths`, not a cursor.
   */
  compactUrls: (ctx: TenantCtx, opts?: CompactUrlsOptions) => Promise<CompactUrlsResult>
  /**
   * Site-wide convergence: mark every still-live URL whose owning feedpath is
   * absent from `liveFeedpaths` as removed. `compactUrls`/`snapshotUrls` only
   * prune URLs *inside* a feedpath that was re-observed; a whole feed dropped
   * from the sitemap list (no `snapshotUrls` call) leaves its URLs frozen-live
   * forever. This is the sidecar mirror of the D1 generation sweep: it rewrites
   * each dropped feedpath's `by-feed/<hash>/index.parquet` with `removedAt` set,
   * advances its projection watermark, and grace-retires outstanding deltas.
   * Bounded per feedpath, so memory stays flat regardless of site size. Live
   * feedpaths are never touched.
   */
  reconcile: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    opts: { liveFeedpaths: readonly string[] },
  ) => Promise<ReconcileResult>
}

export interface CreateSitemapReadStoreOptions {
  dataSource: DataSource
  /** Override the feedpath hash (test seam). */
  hash?: (path: string) => string
}

export type SitemapMutation = <T>(ctx: TenantCtx, fn: () => Promise<T>) => Promise<T>

export interface CreateSitemapStoreOptions extends CreateSitemapReadStoreOptions {
  withMutation: SitemapMutation
  now?: () => number
}

export interface SitemapUrlState {
  live: Map<string, SitemapUrlRecord>
  removed: Map<string, SitemapUrlRecord>
}

export interface SitemapDeltaFile {
  key: string
  rows: Row[]
}

export function createSitemapUrlState(indexRows: readonly Row[]): SitemapUrlState {
  const state: SitemapUrlState = { live: new Map(), removed: new Map() }
  for (const row of indexRows) {
    const record = rowToUrlRecord(row)
    if (record.removedAt == null)
      state.live.set(record.urlHash, record)
    else
      state.removed.set(record.urlHash, record)
  }
  return state
}

export function applySitemapDeltaRows(state: SitemapUrlState, rows: readonly Row[]): void {
  for (const row of rows) {
    const urlHash = String(row.url_hash)
    const observedAt = Number(row.at)
    const op = String(row.op)
    if (op === 'added') {
      const previous = state.live.get(urlHash) ?? state.removed.get(urlHash)
      state.removed.delete(urlHash)
      state.live.set(urlHash, {
        feedpath: String(row.feedpath),
        feedpathHash: String(row.feedpath_hash),
        urlHash,
        loc: String(row.loc),
        lastmod: row.lastmod == null ? undefined : String(row.lastmod),
        firstSeenAt: previous?.firstSeenAt ?? observedAt,
        lastSeenAt: observedAt,
      })
    }
    else if (op === 'removed') {
      const previous = state.live.get(urlHash)
      state.live.delete(urlHash)
      if (previous)
        state.removed.set(urlHash, { ...previous, removedAt: observedAt })
    }
  }
}

export function applySitemapDeltaFiles(state: SitemapUrlState, files: readonly SitemapDeltaFile[]): void {
  for (const file of files)
    applySitemapDeltaRows(state, file.rows)
}

export function sortSitemapDeltaFiles(files: SitemapDeltaFile[]): SitemapDeltaFile[] {
  return files.sort((a, b) => a.key.localeCompare(b.key))
}

export async function readSitemapDeltaFiles(ds: DataSource, keys: readonly string[]): Promise<SitemapDeltaFile[]> {
  const files = await mapEntityIo(keys, async (key) => {
    const bytes = await readOptional(ds, key)
    return bytes ? { key, rows: await decodeParquetToRows(bytes) } : undefined
  })
  return sortSitemapDeltaFiles(files.filter((file): file is SitemapDeltaFile => file !== undefined))
}

export function dateInRange(date: string, range?: DateRange): boolean {
  return (!range?.from || date >= range.from) && (!range?.to || date <= range.to)
}
