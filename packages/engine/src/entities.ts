// Per-site entity stores for slow-changing GSC state (URL inspection,
// sitemap snapshots, indexing-metadata events). Distinct family from the
// time-series fact tables — entities are point-lookup-by-id, not scanned.
//
// JSON-backed: a single index document per site at
//   `u_<u>/<s>/entities/inspections/index.json`
// keyed by URL hash, holding the latest inspection per URL. Append-only
// monthly history shards live alongside for state-over-time queries.

import type { ColumnDef, Row, TenantCtx } from '@gscdump/contracts'
import type { ScheduleState } from './schedule'
import type { DataSource } from './storage'
import { decodeParquetToRows, encodeRowsToParquetFlex } from './adapters/hyparquet'

/**
 * GSC URL inspection result fields we persist. Mirrors the
 *  `searchconsole_v1.Schema$UrlInspectionResult` shape but as plain JSON
 *  so storage doesn't depend on the googleapis type tree.
 */
export interface InspectionRecord {
  url: string
  /** ISO-8601 timestamp of when we ran the inspection. */
  inspectedAt: string
  /** PASS / NEUTRAL / FAIL — the headline verdict from indexStatusResult. */
  indexStatus?: string
  /** Last-crawl timestamp the API reports (ISO-8601). */
  lastCrawlTime?: string
  /** Canonical URL Google selected. */
  googleCanonical?: string
  /** Canonical URL the page declares. */
  userCanonical?: string
  /** Crawl/index/serving disposition strings as the API returns them. */
  coverageState?: string
  robotsTxtState?: string
  indexingState?: string
  pageFetchState?: string
  mobileUsabilityVerdict?: string
  richResultsVerdict?: string
  /**
   * Free-form payload for fields we don't promote to first-class columns
   *  (e.g. `referringUrls`, `crawledAs`). Keeps the wire format forward-compat
   *  without bumping the schema for every API addition.
   *
   *  Recognised keys:
   *  - `schedule`: optional `ScheduleState` from {@link inspectionPolicy}
   *    governing when this URL is next due for re-inspection. Undefined on
   *    pre-§0 records — readers must tolerate the missing field and fall
   *    back to default policy on first observe.
   */
  raw?: {
    schedule?: ScheduleState
    [key: string]: unknown
  }
}

/** Wire shape persisted to disk/R2. */
export interface InspectionIndex {
  version: 1
  /** Map of urlHash → InspectionRecord (latest only). */
  records: Record<string, InspectionRecord>
}

interface InspectionHistoryShard {
  version: 1
  /** Append-only list of inspection records for the YYYY-MM bucket. */
  records: InspectionRecord[]
}

const YEAR_MONTH_RE = /^(\d{4})-(\d{2})-/

export function inspectionIndexKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/index.json`
    : `u_${ctx.userId}/entities/inspections/index.json`
}

export function emptyTypesKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/empty-types.json`
    : `u_${ctx.userId}/entities/empty-types.json`
}

export function inspectionParquetKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/index.parquet`
    : `u_${ctx.userId}/entities/inspections/index.parquet`
}

export function inspectionHistoryKey(ctx: TenantCtx, yearMonth: string): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/history/${yearMonth}.json`
    : `u_${ctx.userId}/entities/inspections/history/${yearMonth}.json`
}

/**
 * Stable URL hash used as the index key. Short, URL-safe, deterministic.
 * Uses a 64-bit FNV-1a; collisions vanishingly unlikely at the scales we
 * care about (≤100k URLs/site).
 */
export function hashUrl(url: string): string {
  // FNV-1a 64-bit. We compute via two 32-bit halves to stay portable across
  // JS runtimes that don't expose BigInt fast paths.
  let hi = 0x811C9DC5 // initial offset basis (low 32 bits of standard 64-bit)
  let lo = 0xCBF29CE4 // (canonical 64-bit basis = 0xCBF29CE484222325)
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    lo ^= c
    // Multiply (hi:lo) by 0x100000001b3 — implemented as 32-bit additions.
    const loMul = Math.imul(lo, 0x000001B3) >>> 0
    const carry = Math.floor((lo * 0x000001B3) / 0x100000000)
    const hiMul = (Math.imul(hi, 0x000001B3) + Math.imul(lo, 0x00000001) + carry) >>> 0
    lo = loMul
    hi = hiMul
  }
  return ((hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0'))
}

export interface InspectionStore {
  /**
   * Persist a batch of fresh inspection results. Updates the index +
   *  appends to the per-month history shard.
   */
  writeBatch: (ctx: TenantCtx, records: readonly InspectionRecord[]) => Promise<void>
  /** Fetch the latest inspection record for a URL, or undefined. */
  getLatest: (ctx: TenantCtx, url: string) => Promise<InspectionRecord | undefined>
  /**
   * Read the full index for a site (latest record per URL). Cheap on
   *  Workers; on big tenants the dashboard reads this once per page load.
   */
  loadIndex: (ctx: TenantCtx) => Promise<InspectionIndex>
  /** Read the per-month history shard if it exists. */
  loadHistory: (ctx: TenantCtx, yearMonth: string) => Promise<InspectionHistoryShard | undefined>
  /**
   * Snapshot the current JSON index to a parquet sidecar at
   * `entities/inspections/index.parquet`. One PUT. Sorted by `urlHash` so
   * DuckDB row-group stats can prune URL-keyed JOINs efficiently.
   *
   * Internal seam: callers don't choose JSON-vs-parquet — the store materialises
   * the parquet at end-of-batch (e.g. after `indexing/complete`) and readers
   * pick the format that matches their access pattern (parquet for JOINs,
   * JSON for full-index scans / point lookups).
   *
   * Returns the parquet object key (matches {@link parquetUri} after write).
   */
  materialize: (ctx: TenantCtx) => Promise<{ key: string, rowCount: number, bytes: number }>
  /**
   * DuckDB-resolvable URI for the materialised parquet sidecar, or
   * `undefined` if the underlying `DataSource` has no native URI shape
   * (in-memory tests). When defined, read paths can `read_parquet(<uri>)`
   * directly without staging bytes through JS.
   *
   * Does not check existence — caller is responsible for ensuring
   * `materialize` has run at least once. Returning a URI for a missing key
   * is safe; DuckDB will surface a 404 / not-found at query time.
   */
  parquetUri: (ctx: TenantCtx) => string | undefined
}

export interface CreateInspectionStoreOptions {
  dataSource: DataSource
  /**
   * Override the FNV hash with a callable (test seam, or to swap in
   *  SHA-256 if hash collisions become a concern at extreme scale).
   */
  hash?: (url: string) => string
  now?: () => number
}

/**
 * Column schema for the inspections parquet sidecar. Stable shape — DuckDB
 * `read_parquet({{INSPECTIONS}})` JOINs in §C consumers depend on these
 * names. New fields go in `raw.*` first; promote here only when a JOIN
 * needs them.
 */
const INSPECTION_PARQUET_COLUMNS: readonly ColumnDef[] = [
  { name: 'urlHash', type: 'VARCHAR', nullable: false },
  { name: 'url', type: 'VARCHAR', nullable: false },
  { name: 'inspectedAt', type: 'VARCHAR', nullable: false },
  { name: 'indexStatus', type: 'VARCHAR', nullable: true },
  { name: 'lastCrawlTime', type: 'VARCHAR', nullable: true },
  { name: 'googleCanonical', type: 'VARCHAR', nullable: true },
  { name: 'userCanonical', type: 'VARCHAR', nullable: true },
  { name: 'coverageState', type: 'VARCHAR', nullable: true },
  { name: 'robotsTxtState', type: 'VARCHAR', nullable: true },
  { name: 'indexingState', type: 'VARCHAR', nullable: true },
  { name: 'pageFetchState', type: 'VARCHAR', nullable: true },
  { name: 'mobileUsabilityVerdict', type: 'VARCHAR', nullable: true },
  { name: 'richResultsVerdict', type: 'VARCHAR', nullable: true },
  { name: 'scheduleNextAt', type: 'BIGINT', nullable: true },
  { name: 'scheduleConsecutiveUnchanged', type: 'INTEGER', nullable: true },
  { name: 'schedulePolicyVersion', type: 'INTEGER', nullable: true },
]

export function createInspectionStore(opts: CreateInspectionStoreOptions): InspectionStore {
  const hash = opts.hash ?? hashUrl
  const ds = opts.dataSource

  async function readJson<T>(key: string): Promise<T | undefined> {
    return await ds.read(key).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as T,
      () => undefined,
    )
  }

  async function writeJson(key: string, value: unknown): Promise<void> {
    await ds.write(key, new TextEncoder().encode(JSON.stringify(value)))
  }

  function emptyIndex(): InspectionIndex {
    return { version: 1, records: {} }
  }

  function emptyShard(): InspectionHistoryShard {
    return { version: 1, records: [] }
  }

  function shardFor(record: InspectionRecord): string {
    // YYYY-MM derived from inspectedAt. Falls back to "unknown" if the
    // timestamp is malformed — keeps the writer side never throwing.
    const m = YEAR_MONTH_RE.exec(record.inspectedAt)
    return m ? `${m[1]}-${m[2]}` : 'unknown'
  }

  return {
    async writeBatch(ctx, records) {
      if (records.length === 0)
        return
      const indexKey = inspectionIndexKey(ctx)
      const index = (await readJson<InspectionIndex>(indexKey)) ?? emptyIndex()
      const byShard = new Map<string, InspectionRecord[]>()
      for (const r of records) {
        index.records[hash(r.url)] = r
        const shardKey = shardFor(r)
        if (!byShard.has(shardKey))
          byShard.set(shardKey, [])
        byShard.get(shardKey)!.push(r)
      }
      await writeJson(indexKey, index)
      for (const [yearMonth, batch] of byShard) {
        const histKey = inspectionHistoryKey(ctx, yearMonth)
        const existing = (await readJson<InspectionHistoryShard>(histKey)) ?? emptyShard()
        existing.records.push(...batch)
        await writeJson(histKey, existing)
      }
    },

    async getLatest(ctx, url) {
      const index = await readJson<InspectionIndex>(inspectionIndexKey(ctx))
      return index?.records[hash(url)]
    },

    async loadIndex(ctx) {
      return (await readJson<InspectionIndex>(inspectionIndexKey(ctx))) ?? emptyIndex()
    },

    async loadHistory(ctx, yearMonth) {
      return await readJson<InspectionHistoryShard>(inspectionHistoryKey(ctx, yearMonth))
    },

    async materialize(ctx) {
      const index = (await readJson<InspectionIndex>(inspectionIndexKey(ctx))) ?? emptyIndex()
      const rows = Object.entries(index.records).map(([urlHash, r]) => ({
        urlHash,
        url: r.url,
        inspectedAt: r.inspectedAt,
        indexStatus: r.indexStatus ?? null,
        lastCrawlTime: r.lastCrawlTime ?? null,
        googleCanonical: r.googleCanonical ?? null,
        userCanonical: r.userCanonical ?? null,
        coverageState: r.coverageState ?? null,
        robotsTxtState: r.robotsTxtState ?? null,
        indexingState: r.indexingState ?? null,
        pageFetchState: r.pageFetchState ?? null,
        mobileUsabilityVerdict: r.mobileUsabilityVerdict ?? null,
        richResultsVerdict: r.richResultsVerdict ?? null,
        scheduleNextAt: r.raw?.schedule?.nextAt ?? null,
        scheduleConsecutiveUnchanged: r.raw?.schedule?.consecutiveUnchanged ?? null,
        schedulePolicyVersion: r.raw?.schedule?.policyVersion ?? null,
      }))
      const bytes = encodeRowsToParquetFlex(rows, {
        columns: INSPECTION_PARQUET_COLUMNS,
        sortKey: ['urlHash'],
      })
      const key = inspectionParquetKey(ctx)
      await ds.write(key, bytes)
      return { key, rowCount: rows.length, bytes: bytes.byteLength }
    },

    parquetUri(ctx) {
      return ds.uri?.(inspectionParquetKey(ctx))
    },
  }
}

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

export function sitemapIndexKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/sitemaps/index.json`
    : `u_${ctx.userId}/entities/sitemaps/index.json`
}

export function sitemapHistoryKey(ctx: TenantCtx, feedpathHash: string, capturedAtMs: number): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/sitemaps/history/${feedpathHash}__${capturedAtMs}.json`
    : `u_${ctx.userId}/entities/sitemaps/history/${feedpathHash}__${capturedAtMs}.json`
}

function sitemapUrlsPrefix(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/sitemaps/urls`
    : `u_${ctx.userId}/entities/sitemaps/urls`
}

export function sitemapUrlsIndexKey(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/index.parquet`
}

export function sitemapUrlsDeltaKey(
  ctx: TenantCtx,
  feedpathHash: string,
  date: string,
): string {
  return `${sitemapUrlsPrefix(ctx)}/deltas/${date}__${feedpathHash}.parquet`
}

const SITEMAP_URLS_DELTA_PREFIX_RE = /\/urls\/deltas\/(\d{4}-\d{2}-\d{2})__([0-9a-f]+)\.parquet$/

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
  /** True when contentHash matched prior; the call performed zero writes. */
  unchanged: boolean
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

export interface DateRange {
  /** YYYY-MM-DD inclusive. */
  from?: string
  /** YYYY-MM-DD inclusive. */
  to?: string
}

export interface LoadUrlsOptions {
  includeRemoved?: boolean
}

const URLS_INDEX_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'first_seen_at', type: 'BIGINT', nullable: false },
  { name: 'last_seen_at', type: 'BIGINT', nullable: false },
  { name: 'removed_at', type: 'BIGINT', nullable: true },
]

const URLS_DELTA_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'op', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'at', type: 'BIGINT', nullable: false },
]

function rowToUrlRecord(row: Row): SitemapUrlRecord {
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

function urlRecordToRow(r: SitemapUrlRecord): Row {
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

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Hash a URL list for change detection. Sorts then folds via FNV-1a so it's
 * deterministic, locale-free, and cheap on Workers.
 */
export function hashUrlList(urls: readonly ParsedUrl[]): string {
  const locs = urls.map(u => u.loc).sort()
  return hashUrl(locs.join('\n'))
}

export interface SitemapStore {
  /**
   * Persist a snapshot run. Updates the index + writes one immutable
   * history doc per record under `history/<feedpathHash>__<capturedAtMs>.json`.
   */
  writeSnapshot: (ctx: TenantCtx, records: readonly SitemapRecord[]) => Promise<void>
  /** Load the full site index (latest record per feedpath). */
  loadIndex: (ctx: TenantCtx) => Promise<SitemapIndex>
  /** Fetch the latest snapshot for a feedpath, or undefined. */
  getLatest: (ctx: TenantCtx, path: string) => Promise<SitemapRecord | undefined>
  /**
   * Diff incoming URLs against the prior `urls/index.parquet` partition for
   * `feedpath`; on change, writes a single delta parquet under
   * `urls/deltas/YYYY-MM-DD__{feedpathHash}.parquet`. Skipped (0 PUTs) when
   * `contentHash` matches prior.
   */
  snapshotUrls: (
    ctx: TenantCtx,
    feedpath: string,
    urls: readonly ParsedUrl[],
  ) => Promise<SnapshotUrlsResult>
  /** Stream live (and optionally removed) URL rows for a feedpath. */
  loadUrls: (
    ctx: TenantCtx,
    feedpath: string,
    opts?: LoadUrlsOptions,
  ) => AsyncIterable<SitemapUrlRecord>
  /** Stream all delta entries within `[from, to]` (YYYY-MM-DD inclusive). */
  loadDeltas: (ctx: TenantCtx, dateRange?: DateRange) => AsyncIterable<DeltaEntry>
  /**
   * Fold every accumulated delta into the prior index; writes a fresh
   * `urls/index.parquet` and deletes the consumed delta files.
   */
  compactUrls: (ctx: TenantCtx) => Promise<void>
  /** DuckDB-resolvable URI for the URLs index; `undefined` if backend lacks one. */
  urlsParquetUri: (ctx: TenantCtx) => string | undefined
}

export interface CreateSitemapStoreOptions {
  dataSource: DataSource
  /** Override the feedpath hash (test seam). */
  hash?: (path: string) => string
  now?: () => number
}

export function createSitemapStore(opts: CreateSitemapStoreOptions): SitemapStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl
  const now = opts.now ?? (() => Date.now())

  async function readJson<T>(key: string): Promise<T | undefined> {
    return await ds.read(key).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as T,
      () => undefined,
    )
  }

  async function writeJson(key: string, value: unknown): Promise<void> {
    await ds.write(key, new TextEncoder().encode(JSON.stringify(value)))
  }

  return {
    async writeSnapshot(ctx, records) {
      if (records.length === 0)
        return
      const indexKey = sitemapIndexKey(ctx)
      const index = (await readJson<SitemapIndex>(indexKey)) ?? { version: 1, records: {} }
      const stamp = now()
      for (const r of records) {
        const h = hash(r.path)
        index.records[h] = r
        const histKey = sitemapHistoryKey(ctx, h, stamp)
        const doc: SitemapHistoryDoc = {
          version: 1,
          path: r.path,
          capturedAt: r.capturedAt,
          record: r,
        }
        await writeJson(histKey, doc)
      }
      await writeJson(indexKey, index)
    },

    async loadIndex(ctx) {
      return (await readJson<SitemapIndex>(sitemapIndexKey(ctx))) ?? { version: 1, records: {} }
    },

    async getLatest(ctx, path) {
      const index = await readJson<SitemapIndex>(sitemapIndexKey(ctx))
      return index?.records[hash(path)]
    },

    async snapshotUrls(ctx, feedpath, urls) {
      const fpHash = hash(feedpath)
      const contentHash = hashUrlList(urls)
      const at = now()
      // Load effective prior state for this feedpath: index.parquet + any
      // outstanding deltas folded in chronologically. Diff is against what the
      // reader sees today, not the (possibly stale) compacted index alone.
      const priorByHash = new Map<string, SitemapUrlRecord>()
      for await (const rec of this.loadUrls(ctx, feedpath, { includeRemoved: true }))
        priorByHash.set(rec.urlHash, rec)
      const livePrior = Array.from(priorByHash.values()).filter(r => r.removedAt == null)
      // Short-circuit on unchanged hash: skip the PUT entirely.
      // Compare only when the prior set was non-empty; first-run always writes.
      if (livePrior.length > 0) {
        const priorLocs = livePrior.map(r => String(r.loc)).sort()
        const priorContentHash = hashUrl(priorLocs.join('\n'))
        if (priorContentHash === contentHash) {
          return {
            added: 0,
            removed: 0,
            kept: livePrior.length,
            contentHash,
            unchanged: true,
          }
        }
      }

      // Diff in CPU.
      const incomingByHash = new Map<string, ParsedUrl>()
      for (const u of urls) incomingByHash.set(hash(u.loc), u)

      const deltaRows: Row[] = []
      let added = 0
      let removed = 0
      let kept = 0
      const date = isoDate(at)

      for (const [urlHash, u] of incomingByHash) {
        const prev = priorByHash.get(urlHash)
        if (!prev || prev.removedAt != null) {
          added++
          deltaRows.push({
            feedpath,
            feedpath_hash: fpHash,
            url_hash: urlHash,
            op: 'added',
            loc: u.loc,
            lastmod: u.lastmod ?? null,
            at,
          })
        }
        else {
          kept++
        }
      }
      for (const [urlHash, prev] of priorByHash) {
        if (prev.removedAt != null)
          continue
        if (!incomingByHash.has(urlHash)) {
          removed++
          deltaRows.push({
            feedpath,
            feedpath_hash: fpHash,
            url_hash: urlHash,
            op: 'removed',
            loc: prev.loc,
            lastmod: prev.lastmod ?? null,
            at,
          })
        }
      }

      if (deltaRows.length > 0) {
        const bytes = encodeRowsToParquetFlex(deltaRows, {
          columns: URLS_DELTA_COLUMNS,
          sortKey: ['url_hash'],
        })
        await ds.write(sitemapUrlsDeltaKey(ctx, fpHash, date), bytes)
      }

      return { added, removed, kept, contentHash, unchanged: false }
    },

    async* loadUrls(ctx, feedpath, opts) {
      const fpHash = hash(feedpath)
      const includeRemoved = opts?.includeRemoved ?? false
      const indexBytes = await ds.read(sitemapUrlsIndexKey(ctx)).catch(() => undefined)
      const indexRows = indexBytes ? await decodeParquetToRows(indexBytes) : []
      // Apply any deltas not yet folded into the index. Fold in chronological
      // order (the delta filename embeds an ISO date prefix → lexical sort).
      const deltaKeys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)).sort()
      const live = new Map<string, SitemapUrlRecord>()
      const removedMap = new Map<string, SitemapUrlRecord>()
      for (const row of indexRows) {
        if (row.feedpath_hash !== fpHash)
          continue
        const rec = rowToUrlRecord(row)
        if (rec.removedAt != null)
          removedMap.set(rec.urlHash, rec)
        else
          live.set(rec.urlHash, rec)
      }
      for (const key of deltaKeys) {
        const m = SITEMAP_URLS_DELTA_PREFIX_RE.exec(key)
        if (!m || m[2] !== fpHash)
          continue
        const dBytes = await ds.read(key).catch(() => undefined)
        if (!dBytes)
          continue
        const dRows = await decodeParquetToRows(dBytes)
        for (const r of dRows) {
          const op = String(r.op)
          const urlHash = String(r.url_hash)
          const at = Number(r.at)
          if (op === 'added') {
            const prev = live.get(urlHash) ?? removedMap.get(urlHash)
            removedMap.delete(urlHash)
            live.set(urlHash, {
              feedpath,
              feedpathHash: fpHash,
              urlHash,
              loc: String(r.loc),
              lastmod: r.lastmod == null ? undefined : String(r.lastmod),
              firstSeenAt: prev?.firstSeenAt ?? at,
              lastSeenAt: at,
            })
          }
          else if (op === 'removed') {
            const prev = live.get(urlHash)
            live.delete(urlHash)
            if (prev) {
              removedMap.set(urlHash, { ...prev, removedAt: at })
            }
          }
        }
      }
      for (const rec of live.values()) yield rec
      if (includeRemoved) {
        for (const rec of removedMap.values()) yield rec
      }
    },

    async* loadDeltas(ctx, dateRange) {
      const from = dateRange?.from
      const to = dateRange?.to
      const keys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)).sort()
      for (const key of keys) {
        const m = SITEMAP_URLS_DELTA_PREFIX_RE.exec(key)
        if (!m)
          continue
        const date = m[1]
        if (from && date < from)
          continue
        if (to && date > to)
          continue
        const bytes = await ds.read(key).catch(() => undefined)
        if (!bytes)
          continue
        const rows = await decodeParquetToRows(bytes)
        for (const r of rows) {
          const op = String(r.op)
          if (op !== 'added' && op !== 'removed')
            continue
          yield {
            feedpath: String(r.feedpath),
            feedpathHash: String(r.feedpath_hash),
            urlHash: String(r.url_hash),
            op,
            loc: String(r.loc),
            lastmod: r.lastmod == null ? undefined : String(r.lastmod),
            at: Number(r.at),
          }
        }
      }
    },

    async compactUrls(ctx) {
      const indexKey = sitemapUrlsIndexKey(ctx)
      const indexBytes = await ds.read(indexKey).catch(() => undefined)
      const indexRows = indexBytes ? await decodeParquetToRows(indexBytes) : []
      // Map keyed by (feedpath_hash, url_hash) so we can merge per-URL state.
      const stateKey = (fp: string, u: string): string => `${fp}::${u}`
      const live = new Map<string, SitemapUrlRecord>()
      const removed = new Map<string, SitemapUrlRecord>()
      for (const row of indexRows) {
        const rec = rowToUrlRecord(row)
        const k = stateKey(rec.feedpathHash, rec.urlHash)
        if (rec.removedAt != null)
          removed.set(k, rec)
        else
          live.set(k, rec)
      }
      const deltaKeys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)).sort()
      const consumed: string[] = []
      for (const key of deltaKeys) {
        const m = SITEMAP_URLS_DELTA_PREFIX_RE.exec(key)
        if (!m)
          continue
        const fpHash = m[2]
        const bytes = await ds.read(key).catch(() => undefined)
        if (!bytes)
          continue
        consumed.push(key)
        const rows = await decodeParquetToRows(bytes)
        for (const r of rows) {
          const urlHash = String(r.url_hash)
          const at = Number(r.at)
          const k = stateKey(fpHash, urlHash)
          const op = String(r.op)
          if (op === 'added') {
            const prev = live.get(k) ?? removed.get(k)
            removed.delete(k)
            live.set(k, {
              feedpath: String(r.feedpath),
              feedpathHash: fpHash,
              urlHash,
              loc: String(r.loc),
              lastmod: r.lastmod == null ? undefined : String(r.lastmod),
              firstSeenAt: prev?.firstSeenAt ?? at,
              lastSeenAt: at,
            })
          }
          else if (op === 'removed') {
            const prev = live.get(k)
            live.delete(k)
            if (prev)
              removed.set(k, { ...prev, removedAt: at })
          }
        }
      }
      const merged: SitemapUrlRecord[] = [...live.values(), ...removed.values()]
      merged.sort((a, b) => {
        if (a.feedpathHash !== b.feedpathHash)
          return a.feedpathHash < b.feedpathHash ? -1 : 1
        if (a.urlHash !== b.urlHash)
          return a.urlHash < b.urlHash ? -1 : 1
        return 0
      })
      const bytes = encodeRowsToParquetFlex(merged.map(urlRecordToRow), {
        columns: URLS_INDEX_COLUMNS,
        sortKey: ['feedpath_hash', 'url_hash'],
      })
      await ds.write(indexKey, bytes)
      if (consumed.length > 0)
        await ds.delete(consumed)
    },

    urlsParquetUri(ctx) {
      const key = sitemapUrlsIndexKey(ctx)
      return ds.uri ? ds.uri(key) : undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Indexing-metadata snapshots
// ---------------------------------------------------------------------------
//
// Mirrors Google's Indexing API `UrlNotificationMetadata` resource — the
// last `URL_UPDATED` and `URL_REMOVED` notifications Google has on record
// for a given URL. We persist these per-URL so the dashboard can surface
// how stale Google's view of each page is and a rollup (below) can count
// publish events across time windows.

export interface IndexingMetadataRecord {
  url: string
  capturedAt: string
  /** ISO-8601 notifyTime of the latest `URL_UPDATED` notification we've seen. */
  latestUpdateAt?: string
  /** ISO-8601 notifyTime of the latest `URL_REMOVED` notification we've seen. */
  latestRemoveAt?: string
  raw?: unknown
}

export interface IndexingMetadataIndex {
  version: 1
  records: Record<string, IndexingMetadataRecord>
}

export function indexingMetadataIndexKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/indexing/index.json`
    : `u_${ctx.userId}/entities/indexing/index.json`
}

export interface IndexingMetadataStore {
  writeBatch: (ctx: TenantCtx, records: readonly IndexingMetadataRecord[]) => Promise<void>
  loadIndex: (ctx: TenantCtx) => Promise<IndexingMetadataIndex>
  getLatest: (ctx: TenantCtx, url: string) => Promise<IndexingMetadataRecord | undefined>
}

export interface CreateIndexingMetadataStoreOptions {
  dataSource: DataSource
  hash?: (url: string) => string
}

export function createIndexingMetadataStore(
  opts: CreateIndexingMetadataStoreOptions,
): IndexingMetadataStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl

  async function readIndex(key: string): Promise<IndexingMetadataIndex> {
    return await ds.read(key).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as IndexingMetadataIndex,
      () => ({ version: 1 as const, records: {} }),
    )
  }

  return {
    async writeBatch(ctx, records) {
      if (records.length === 0)
        return
      const key = indexingMetadataIndexKey(ctx)
      const index = await readIndex(key)
      for (const r of records) index.records[hash(r.url)] = r
      await ds.write(key, new TextEncoder().encode(JSON.stringify(index)))
    },

    async loadIndex(ctx) {
      return readIndex(indexingMetadataIndexKey(ctx))
    },

    async getLatest(ctx, url) {
      const index = await readIndex(indexingMetadataIndexKey(ctx))
      return index.records[hash(url)]
    },
  }
}

// ---------------------------------------------------------------------------
// Empty-type markers
// ---------------------------------------------------------------------------
//
// First time a site syncs a given GSC searchType, we probe a real week of
// data. If GSC returns zero impressions across the probe window the site
// almost certainly has no coverage for that surface (e.g. a non-news site
// has no `news` data). Recording that in `entities/empty-types.json` lets
// future syncs skip the type entirely — saving quota + wall-clock — until
// the user forces a re-probe with `--force-types`.

export interface EmptyTypesDoc {
  version: 1
  /** SearchType strings detected as empty for this (user, site). */
  emptyTypes: string[]
  /** When each type was last marked empty (unix ms). Helps debug stale skips. */
  markedAt: Record<string, number>
}

export interface EmptyTypesStore {
  load: (ctx: TenantCtx) => Promise<EmptyTypesDoc>
  /** Add types to the empty set, preserving existing markers. No-op if all already present. */
  mark: (ctx: TenantCtx, types: readonly string[], now?: number) => Promise<EmptyTypesDoc>
  /** Remove types from the empty set. Returns the updated doc. */
  clear: (ctx: TenantCtx, types: readonly string[]) => Promise<EmptyTypesDoc>
}

export interface CreateEmptyTypesStoreOptions {
  dataSource: DataSource
  now?: () => number
}

export function createEmptyTypesStore(opts: CreateEmptyTypesStoreOptions): EmptyTypesStore {
  const ds = opts.dataSource
  const now = opts.now ?? (() => Date.now())

  async function readDoc(key: string): Promise<EmptyTypesDoc> {
    return await ds.read(key).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as EmptyTypesDoc,
      () => ({ version: 1, emptyTypes: [], markedAt: {} }),
    )
  }

  async function writeDoc(key: string, doc: EmptyTypesDoc): Promise<void> {
    await ds.write(key, new TextEncoder().encode(JSON.stringify(doc)))
  }

  return {
    async load(ctx) {
      return readDoc(emptyTypesKey(ctx))
    },

    async mark(ctx, types, at) {
      if (types.length === 0)
        return readDoc(emptyTypesKey(ctx))
      const key = emptyTypesKey(ctx)
      const doc = await readDoc(key)
      const stamp = at ?? now()
      let changed = false
      for (const t of types) {
        if (!doc.emptyTypes.includes(t)) {
          doc.emptyTypes.push(t)
          changed = true
        }
        if (doc.markedAt[t] === undefined) {
          doc.markedAt[t] = stamp
          changed = true
        }
      }
      if (changed) {
        doc.emptyTypes.sort()
        await writeDoc(key, doc)
      }
      return doc
    },

    async clear(ctx, types) {
      if (types.length === 0)
        return readDoc(emptyTypesKey(ctx))
      const key = emptyTypesKey(ctx)
      const doc = await readDoc(key)
      const drop = new Set(types)
      const before = doc.emptyTypes.length
      doc.emptyTypes = doc.emptyTypes.filter(t => !drop.has(t))
      for (const t of drop) delete doc.markedAt[t]
      if (doc.emptyTypes.length !== before)
        await writeDoc(key, doc)
      return doc
    },
  }
}
