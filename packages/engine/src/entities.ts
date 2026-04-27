// Per-site entity stores for slow-changing GSC state (URL inspection,
// sitemap snapshots, indexing-metadata events). Distinct family from the
// time-series fact tables — entities are point-lookup-by-id, not scanned.
//
// JSON-backed v1: a single index document per site at
//   `u_<u>/<s>/entities/inspections/index.json`
// keyed by URL hash, holding the latest inspection per URL. Append-only
// monthly history shards live alongside for state-over-time queries.
//
// SQLite-per-site is the planned upgrade once URL counts justify indexed
// queries; the interface here is shaped so that swap is a backend change,
// not a contract change.

import type { TenantCtx } from 'gscdump/contracts'
import type { DataSource } from './storage'

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
   */
  raw?: unknown
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
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed InspectionStore
// ---------------------------------------------------------------------------
//
// Same InspectionStore contract, persisted to a per-site SQLite file in the
// DataSource at `.../entities/inspections/inspections.db`. Dependency-free:
// the caller supplies an `openDriver` that wraps better-sqlite3 (node) or
// wa-sqlite (browser/worker). The driver surface is the minimum we need
// (exec / run / all / serialize / close) so we don't couple to a specific
// SQLite binding.
//
// Drop-in drivers ship as subpath exports to keep edge bundles slim:
//   - `@gscdump/engine/inspection-sqlite-node` → `createBetterSqliteDriver`
//   - `@gscdump/engine/inspection-sqlite-browser` → `createWaSqliteDriver`

export interface InspectionSqlDriver {
  exec: (sql: string) => void | Promise<void>
  run: (sql: string, params: unknown[]) => void | Promise<void>
  all: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>
  serialize: () => Uint8Array | Promise<Uint8Array>
  close: () => void | Promise<void>
}

export interface CreateInspectionStoreSqliteOptions {
  dataSource: DataSource
  openDriver: (bytes: Uint8Array | undefined) => InspectionSqlDriver | Promise<InspectionSqlDriver>
  hash?: (url: string) => string
}

export function inspectionSqliteKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/inspections.db`
    : `u_${ctx.userId}/entities/inspections/inspections.db`
}

const INSPECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inspections (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  inspected_at TEXT NOT NULL,
  index_status TEXT,
  last_crawl_time TEXT,
  google_canonical TEXT,
  user_canonical TEXT,
  coverage_state TEXT,
  robots_txt_state TEXT,
  indexing_state TEXT,
  page_fetch_state TEXT,
  mobile_usability_verdict TEXT,
  rich_results_verdict TEXT,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS inspection_history (
  year_month TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  inspected_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (year_month, url_hash, inspected_at)
);
CREATE INDEX IF NOT EXISTS inspection_history_by_month ON inspection_history(year_month);
`

interface InspectionRow {
  url_hash: string
  url: string
  inspected_at: string
  index_status: string | null
  last_crawl_time: string | null
  google_canonical: string | null
  user_canonical: string | null
  coverage_state: string | null
  robots_txt_state: string | null
  indexing_state: string | null
  page_fetch_state: string | null
  mobile_usability_verdict: string | null
  rich_results_verdict: string | null
  raw: string | null
}

interface InspectionHistoryRow {
  year_month: string
  url_hash: string
  url: string
  inspected_at: string
  payload: string
}

function rowToRecord(r: InspectionRow): InspectionRecord {
  const out: InspectionRecord = {
    url: r.url,
    inspectedAt: r.inspected_at,
  }
  if (r.index_status != null)
    out.indexStatus = r.index_status
  if (r.last_crawl_time != null)
    out.lastCrawlTime = r.last_crawl_time
  if (r.google_canonical != null)
    out.googleCanonical = r.google_canonical
  if (r.user_canonical != null)
    out.userCanonical = r.user_canonical
  if (r.coverage_state != null)
    out.coverageState = r.coverage_state
  if (r.robots_txt_state != null)
    out.robotsTxtState = r.robots_txt_state
  if (r.indexing_state != null)
    out.indexingState = r.indexing_state
  if (r.page_fetch_state != null)
    out.pageFetchState = r.page_fetch_state
  if (r.mobile_usability_verdict != null)
    out.mobileUsabilityVerdict = r.mobile_usability_verdict
  if (r.rich_results_verdict != null)
    out.richResultsVerdict = r.rich_results_verdict
  if (r.raw != null)
    out.raw = JSON.parse(r.raw)
  return out
}

function shardForRecord(record: InspectionRecord): string {
  const m = YEAR_MONTH_RE.exec(record.inspectedAt)
  return m ? `${m[1]}-${m[2]}` : 'unknown'
}

export function createInspectionStoreSqlite(
  opts: CreateInspectionStoreSqliteOptions,
): InspectionStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl

  async function withDriver<T>(ctx: TenantCtx, fn: (driver: InspectionSqlDriver) => Promise<T>, persist: boolean): Promise<T> {
    const key = inspectionSqliteKey(ctx)
    const bytes = await ds.read(key).catch(() => undefined)
    const driver = await opts.openDriver(bytes)
    await driver.exec(INSPECTION_SCHEMA_SQL)
    const result = await fn(driver)
    if (persist) {
      const out = await driver.serialize()
      await ds.write(key, out)
    }
    await driver.close()
    return result
  }

  return {
    async writeBatch(ctx, records) {
      if (records.length === 0)
        return
      await withDriver(ctx, async (driver) => {
        for (const r of records) {
          const h = hash(r.url)
          await driver.run(
            `INSERT INTO inspections (
              url_hash, url, inspected_at, index_status, last_crawl_time,
              google_canonical, user_canonical, coverage_state, robots_txt_state,
              indexing_state, page_fetch_state, mobile_usability_verdict,
              rich_results_verdict, raw
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(url_hash) DO UPDATE SET
              url = excluded.url,
              inspected_at = excluded.inspected_at,
              index_status = excluded.index_status,
              last_crawl_time = excluded.last_crawl_time,
              google_canonical = excluded.google_canonical,
              user_canonical = excluded.user_canonical,
              coverage_state = excluded.coverage_state,
              robots_txt_state = excluded.robots_txt_state,
              indexing_state = excluded.indexing_state,
              page_fetch_state = excluded.page_fetch_state,
              mobile_usability_verdict = excluded.mobile_usability_verdict,
              rich_results_verdict = excluded.rich_results_verdict,
              raw = excluded.raw`,
            [
              h,
              r.url,
              r.inspectedAt,
              r.indexStatus ?? null,
              r.lastCrawlTime ?? null,
              r.googleCanonical ?? null,
              r.userCanonical ?? null,
              r.coverageState ?? null,
              r.robotsTxtState ?? null,
              r.indexingState ?? null,
              r.pageFetchState ?? null,
              r.mobileUsabilityVerdict ?? null,
              r.richResultsVerdict ?? null,
              r.raw === undefined ? null : JSON.stringify(r.raw),
            ],
          )
          await driver.run(
            `INSERT OR REPLACE INTO inspection_history
               (year_month, url_hash, url, inspected_at, payload)
               VALUES (?,?,?,?,?)`,
            [shardForRecord(r), h, r.url, r.inspectedAt, JSON.stringify(r)],
          )
        }
      }, true)
    },

    async getLatest(ctx, url) {
      return await withDriver(ctx, async (driver) => {
        const rows = await driver.all(
          'SELECT * FROM inspections WHERE url_hash = ? LIMIT 1',
          [hash(url)],
        ) as InspectionRow[]
        return rows.length === 0 ? undefined : rowToRecord(rows[0]!)
      }, false)
    },

    async loadIndex(ctx) {
      return await withDriver(ctx, async (driver) => {
        const rows = await driver.all('SELECT * FROM inspections', []) as InspectionRow[]
        const records: Record<string, InspectionRecord> = {}
        for (const r of rows) records[r.url_hash] = rowToRecord(r)
        return { version: 1 as const, records }
      }, false)
    },

    async loadHistory(ctx, yearMonth) {
      return await withDriver(ctx, async (driver) => {
        const rows = await driver.all(
          'SELECT * FROM inspection_history WHERE year_month = ? ORDER BY inspected_at ASC',
          [yearMonth],
        ) as InspectionHistoryRow[]
        if (rows.length === 0)
          return undefined
        return {
          version: 1 as const,
          records: rows.map(r => JSON.parse(r.payload) as InspectionRecord),
        }
      }, false)
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
