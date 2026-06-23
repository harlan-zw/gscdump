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
import { readOptional } from './adapters/read-optional'

// The versioned query→canonical(+intent) dimension is an entity store; surface
// it on the same `@gscdump/engine/entities` subpath.
export * from './query-dim'

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

/**
 * Append-only history shard, one blob per `appendHistory` call.
 * Keyed by UUID under the month directory — retries write a new blob,
 * never RMW an existing one. Idempotent under job retries.
 */
export interface InspectionHistoryShard {
  version: 1
  /** Records persisted in this batch. */
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

// --- Append-only inspection-event store (the source-of-truth replacing the
// D1-fed `materialize` sidecar). Writes are immutable per-batch parquet under
// `events/<YYYY-MM>/<batchId>.parquet` carrying the FULL fidelity column set;
// `compactInspections` folds them into a `base.parquet` (latest-per-url,
// newest-wins by `inspectedAt`). Reads merge base + uncompacted events and
// dedup newest-wins at query time — mirrors the sitemap-urls delta/compaction
// shape, just keyed by `urlHash` instead of feedpath. ---

/** Directory prefix holding a tenant's immutable inspection-event parquets. */
export function inspectionEventsPrefix(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/events`
    : `u_${ctx.userId}/entities/inspections/events`
}

/**
 * Object key for one immutable inspection-event batch, partitioned by the
 * `YYYY-MM` of the records' `inspectedAt`. The `batchId` is caller-supplied so
 * a job retry re-writes the SAME key (idempotent whole-file overwrite).
 */
export function inspectionEventKey(ctx: TenantCtx, yearMonth: string, batchId: string): string {
  return `${inspectionEventsPrefix(ctx)}/${yearMonth}/${batchId}.parquet`
}

/** Compacted latest-per-url base produced by `compactInspections`. */
export function inspectionBaseKey(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/base.parquet`
    : `u_${ctx.userId}/entities/inspections/base.parquet`
}

const INSPECTION_EVENT_KEY_RE = /\/inspections\/events\/\d{4}-\d{2}\/[^/]+\.parquet$/

/**
 * Directory prefix for a month's history shards. Each shard is a UUID-keyed
 * blob under this prefix; `appendHistory` writes one per call, `loadHistory`
 * lists + concatenates.
 */
export function inspectionHistoryPrefix(ctx: TenantCtx, yearMonth: string): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/entities/inspections/history/${yearMonth}`
    : `u_${ctx.userId}/entities/inspections/history/${yearMonth}`
}

export function inspectionHistoryShardKey(ctx: TenantCtx, yearMonth: string, batchId: string): string {
  return `${inspectionHistoryPrefix(ctx, yearMonth)}/${batchId}.json`
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

/**
 * Row shape for the inspections parquet sidecar. Caller-side schema for
 * `materialize` — D1 is the source of truth in the 2026-05-19 redesign, so
 * consumers stream rows from `url_indexing_status` and pass them in. The
 * parquet sidecar exists for DuckDB JOIN seams; readers go through
 * `parquetUri`.
 */
export interface InspectionParquetRow {
  // Explicit index signature keeps the shape assignable to `Row`
  // (`Record<string, unknown>`) for `encodeRowsToParquetFlex`.
  [column: string]: string | number | null
  urlHash: string
  url: string
  inspectedAt: string
  indexStatus: string | null
  lastCrawlTime: string | null
  googleCanonical: string | null
  userCanonical: string | null
  coverageState: string | null
  robotsTxtState: string | null
  indexingState: string | null
  pageFetchState: string | null
  mobileUsabilityVerdict: string | null
  richResultsVerdict: string | null
  scheduleNextAt: number | null
  scheduleConsecutiveUnchanged: number | null
  schedulePolicyVersion: number | null
}

/**
 * Row shape for the append-only inspection-event store. Superset of
 * {@link InspectionParquetRow}: carries the full-fidelity columns the lossy
 * `materialize` parquet dropped (`crawlingUserAgent`, `richResultsItems`,
 * `sitemaps`, `referringUrls`, `mobileIssues`, `inspectionResultLink`,
 * `firstCheckedAt`, `checkCount`). Object/array fields are persisted as JSON
 * strings — read paths unpack them with DuckDB's JSON functions.
 *
 * `firstCheckedAt` / `checkCount` are caller-managed: the writer carries the
 * earliest-seen timestamp + running observation count forward. Compaction
 * preserves the EARLIEST `firstCheckedAt` per url (mirrors the sitemap store's
 * `firstSeenAt` preservation); every other column is taken from the
 * newest-by-`inspectedAt` event.
 */
export interface InspectionEventRow extends InspectionParquetRow {
  crawlingUserAgent: string | null
  /** JSON-encoded `RichResultsItem[]`. */
  richResultsItems: string | null
  /** JSON-encoded list of sitemap URLs referencing this page. */
  sitemaps: string | null
  /** JSON-encoded list of referring URLs. */
  referringUrls: string | null
  /** JSON-encoded mobile-usability issues. */
  mobileIssues: string | null
  inspectionResultLink: string | null
  /** ISO-8601 timestamp of the first inspection we ever recorded for this url. */
  firstCheckedAt: string | null
  /** Total number of inspections recorded for this url. */
  checkCount: number | null
  /**
   * Stored next-recheck unix-seconds + priority as computed AT INSPECT TIME.
   * Carried verbatim (NOT recomputed at read) because the scheduling policy can
   * change over time — `__gsc/inspections` must replay the historical value to
   * keep its frozen wire shape byte-stable.
   */
  nextCheckAfter: number | null
  nextCheckPriority: string | null
}

/**
 * Hard cap on a single `appendHistory` shard payload. Encoded bytes >
 * this threshold throws — the caller logs and moves on (D1 is
 * authoritative, R2 history is a sidecar). At `URLS_PER_JOB=3` a real
 * batch encodes to ~10 KB so the cap is purely defensive against future
 * batch-size bumps.
 */
export const INSPECTION_HISTORY_MAX_BYTES = 5 * 1024 * 1024

export interface InspectionStore {
  /**
   * Append a batch of fresh inspection results as an immutable per-batch
   * shard under `history/<YYYY-MM>/<batchId>.json`. Idempotent under job
   * retry (caller-supplied UUID per logical batch), no read-before-write,
   * one PUT per month-group within the batch.
   *
   * Throws if the encoded payload exceeds {@link INSPECTION_HISTORY_MAX_BYTES}.
   */
  appendHistory: (ctx: TenantCtx, records: readonly InspectionRecord[], opts?: { batchId?: string }) => Promise<void>
  /**
   * Read every shard in a month directory and concatenate. Best-effort:
   * shards that fail to decode are skipped (logged via console). Returns
   * `undefined` if the month has no shards.
   */
  loadHistory: (ctx: TenantCtx, yearMonth: string) => Promise<InspectionHistoryShard | undefined>
  /**
   * Encode caller-provided rows into the inspections parquet sidecar at
   * `entities/inspections/index.parquet`. Sorted by `urlHash` so DuckDB
   * row-group stats can prune URL-keyed JOINs efficiently. One PUT.
   *
   * D1 is the source of truth in the 2026-05-19 redesign; this rebuilds
   * the parquet from D1 rows the caller streams in (engine has no D1
   * access). Triggered by `indexing/complete` post-hook.
   *
   * Returns the parquet object key (matches {@link parquetUri} after write).
   */
  materialize: (ctx: TenantCtx, rows: Iterable<InspectionParquetRow>) => Promise<{ key: string, rowCount: number, bytes: number }>
  /**
   * Append a batch of inspection results as an immutable per-batch parquet
   * under `events/<YYYY-MM>/<batchId>.parquet`, partitioned by the `YYYY-MM`
   * of each row's `inspectedAt` (a batch spanning a month boundary writes one
   * file per month). No read-before-write; idempotent under job retry (same
   * `batchId` → same key → whole-file overwrite). Rows carry the FULL column
   * set ({@link INSPECTION_EVENT_COLUMNS}); this is the append-only
   * source-of-truth that supersedes {@link InspectionStore.materialize}.
   *
   * Returns the keys written + total row count. Empty input is a no-op.
   */
  appendInspectionEvents: (
    ctx: TenantCtx,
    rows: readonly InspectionEventRow[],
    opts?: { batchId?: string },
  ) => Promise<{ keys: string[], rowCount: number }>
  /**
   * Fold every outstanding event file into the `base.parquet`: latest-per-url
   * by max `inspectedAt` (newest-wins), preserving the earliest non-null
   * `firstCheckedAt` per url. Writes the new base then deletes the consumed
   * event files — file-level only, never row-level (ADR-0002). Idempotent +
   * re-runnable: a crash after the base write but before the delete just
   * re-folds the same events (newest-wins makes that a no-op). A real read
   * failure on the existing base propagates rather than rebuilding from events
   * alone (which would drop URLs only the base held).
   *
   * No-op (no base rewrite) when there are zero outstanding events.
   */
  compactInspections: (ctx: TenantCtx) => Promise<{ baseRowCount: number, eventsFolded: number, eventFilesDeleted: number }>
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

/**
 * Column schema for the append-only inspection-event store + its compacted
 * base. Superset of {@link INSPECTION_PARQUET_COLUMNS}: the 16 promoted columns
 * plus the 8 full-fidelity ones the lossy `materialize` parquet dropped. The
 * event files and `base.parquet` share this schema so DuckDB
 * `read_parquet([...], union_by_name = true)` merges base + events cleanly.
 */
export const INSPECTION_EVENT_COLUMNS: readonly ColumnDef[] = [
  ...INSPECTION_PARQUET_COLUMNS,
  { name: 'crawlingUserAgent', type: 'VARCHAR', nullable: true },
  { name: 'richResultsItems', type: 'VARCHAR', nullable: true },
  { name: 'sitemaps', type: 'VARCHAR', nullable: true },
  { name: 'referringUrls', type: 'VARCHAR', nullable: true },
  { name: 'mobileIssues', type: 'VARCHAR', nullable: true },
  { name: 'inspectionResultLink', type: 'VARCHAR', nullable: true },
  { name: 'firstCheckedAt', type: 'VARCHAR', nullable: true },
  { name: 'checkCount', type: 'INTEGER', nullable: true },
  { name: 'nextCheckAfter', type: 'BIGINT', nullable: true },
  { name: 'nextCheckPriority', type: 'VARCHAR', nullable: true },
]

export function createInspectionStore(opts: CreateInspectionStoreOptions): InspectionStore {
  const ds = opts.dataSource

  function shardFor(record: InspectionRecord): string {
    // YYYY-MM derived from inspectedAt. Falls back to "unknown" if the
    // timestamp is malformed — keeps the writer side never throwing.
    const m = YEAR_MONTH_RE.exec(record.inspectedAt)
    return m ? `${m[1]}-${m[2]}` : 'unknown'
  }

  function randomBatchId(): string {
    return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  return {
    async appendHistory(ctx, records, options) {
      if (records.length === 0)
        return
      const batchId = options?.batchId ?? randomBatchId()
      const byMonth = new Map<string, InspectionRecord[]>()
      for (const r of records) {
        const month = shardFor(r)
        if (!byMonth.has(month))
          byMonth.set(month, [])
        byMonth.get(month)!.push(r)
      }
      for (const [yearMonth, batch] of byMonth) {
        const shard: InspectionHistoryShard = { version: 1, records: batch }
        const bytes = new TextEncoder().encode(JSON.stringify(shard))
        if (bytes.byteLength > INSPECTION_HISTORY_MAX_BYTES) {
          throw new Error(
            `inspection history shard exceeds ${INSPECTION_HISTORY_MAX_BYTES} bytes (got ${bytes.byteLength}); split the batch`,
          )
        }
        await ds.write(inspectionHistoryShardKey(ctx, yearMonth, batchId), bytes)
      }
    },

    async loadHistory(ctx, yearMonth) {
      const keys = await ds.list(inspectionHistoryPrefix(ctx, yearMonth))
      if (keys.length === 0)
        return undefined
      const out: InspectionRecord[] = []
      for (const key of keys) {
        // Absent shard (raced delete between list+read) → skip; a real read
        // failure propagates rather than silently dropping the shard's records.
        const bytes = await readOptional(ds, key)
        if (!bytes)
          continue
        const shard = await Promise.resolve()
          .then(() => JSON.parse(new TextDecoder().decode(bytes)) as InspectionHistoryShard)
          .catch((err: Error) => {
            console.warn('[inspection.loadHistory] failed to decode shard', { key, error: err.message })
            return undefined
          })
        if (shard?.records)
          out.push(...shard.records)
      }
      return { version: 1, records: out }
    },

    async materialize(ctx, rowIter) {
      const rows = Array.from(rowIter)
      // Sorted parquet — DuckDB row-group stats can prune URL-keyed JOINs.
      rows.sort((a, b) => (a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0))
      const bytes = encodeRowsToParquetFlex(rows, {
        columns: INSPECTION_PARQUET_COLUMNS,
        sortKey: ['urlHash'],
      })
      const key = inspectionParquetKey(ctx)
      await ds.write(key, bytes)
      return { key, rowCount: rows.length, bytes: bytes.byteLength }
    },

    async appendInspectionEvents(ctx, rows, options) {
      if (rows.length === 0)
        return { keys: [], rowCount: 0 }
      const batchId = options?.batchId ?? randomBatchId()
      // Partition the batch by the YYYY-MM of each row's inspectedAt so files
      // group naturally by month (mirrors the history-shard layout). Malformed
      // timestamps land in `unknown` rather than throwing the writer.
      const byMonth = new Map<string, InspectionEventRow[]>()
      for (const r of rows) {
        const m = YEAR_MONTH_RE.exec(r.inspectedAt)
        const month = m ? `${m[1]}-${m[2]}` : 'unknown'
        const bucket = byMonth.get(month) ?? []
        bucket.push(r)
        byMonth.set(month, bucket)
      }
      const keys: string[] = []
      for (const [month, batch] of byMonth) {
        const bytes = encodeRowsToParquetFlex(batch as Row[], {
          columns: INSPECTION_EVENT_COLUMNS,
          sortKey: ['urlHash'],
        })
        const key = inspectionEventKey(ctx, month, batchId)
        await ds.write(key, bytes)
        keys.push(key)
      }
      return { keys, rowCount: rows.length }
    },

    async compactInspections(ctx) {
      const eventKeys = (await ds.list(`${inspectionEventsPrefix(ctx)}/`))
        .filter(k => INSPECTION_EVENT_KEY_RE.test(k))
      // Nothing outstanding → leave the base untouched (no needless rewrite).
      if (eventKeys.length === 0)
        return { baseRowCount: 0, eventsFolded: 0, eventFilesDeleted: 0 }

      const baseKey = inspectionBaseKey(ctx)
      // Highest-risk swallow: a real read failure on an existing base must NOT
      // read as absent — that would rebuild the base from events alone and drop
      // every URL only the base held. readOptional keeps a genuinely-absent base
      // as `undefined` (first compaction) but propagates a real failure.
      const baseBytes = await readOptional(ds, baseKey)
      const baseRows = baseBytes ? await decodeParquetToRows(baseBytes) : []

      // Newest-wins per urlHash by inspectedAt (ISO strings sort chronologically),
      // tracking the earliest firstCheckedAt seen so compaction never loses it.
      const latest = new Map<string, Row>()
      const earliestChecked = new Map<string, string>()
      const consider = (row: Row): void => {
        const h = String(row.urlHash)
        const prev = latest.get(h)
        if (!prev || String(row.inspectedAt ?? '') > String(prev.inspectedAt ?? ''))
          latest.set(h, row)
        const fc = row.firstCheckedAt
        if (fc != null) {
          const fcStr = String(fc)
          const cur = earliestChecked.get(h)
          if (cur === undefined || fcStr < cur)
            earliestChecked.set(h, fcStr)
        }
      }
      for (const row of baseRows) consider(row)

      let eventsFolded = 0
      const consumed: string[] = []
      for (const key of eventKeys.sort()) {
        const bytes = await readOptional(ds, key)
        if (!bytes)
          continue
        consumed.push(key)
        const rows = await decodeParquetToRows(bytes)
        for (const row of rows) {
          consider(row)
          eventsFolded++
        }
      }

      const merged: Row[] = []
      for (const [h, row] of latest) {
        const fc = earliestChecked.get(h)
        if (fc !== undefined)
          row.firstCheckedAt = fc
        merged.push(row)
      }
      const bytes = encodeRowsToParquetFlex(merged, {
        columns: INSPECTION_EVENT_COLUMNS,
        sortKey: ['urlHash'],
      })
      await ds.write(baseKey, bytes)
      if (consumed.length > 0)
        await ds.delete(consumed)
      return { baseRowCount: merged.length, eventsFolded, eventFilesDeleted: consumed.length }
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

// Compacted URL state is partitioned by feedpath: one small `index.parquet`
// per sitemap, not one tenant-wide blob. Every sitemap operation (sync, diff,
// compaction) is scoped to a single feedpath, so storage is keyed the same
// way — peak memory is bounded by one sitemap's URL count, never the whole
// site's. The change history lives in the per-feedpath `deltas/` files, which
// this layout leaves untouched.
export function sitemapUrlsIndexPrefix(ctx: TenantCtx): string {
  return `${sitemapUrlsPrefix(ctx)}/by-feed`
}

export function sitemapUrlsIndexKey(ctx: TenantCtx, feedpathHash: string): string {
  return `${sitemapUrlsIndexPrefix(ctx)}/${feedpathHash}/index.parquet`
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

export interface ReconcileResult {
  /** Feedpaths that were absent from the live set and had their live URLs pruned. */
  feedpathsPruned: number
  /** Total URL rows transitioned live → removed across pruned feedpaths. */
  urlsRemoved: number
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
   * Fold accumulated deltas into the prior index, one feedpath at a time:
   * rewrites each touched feedpath's `by-feed/<hash>/index.parquet` and deletes
   * the consumed delta files. Bounded per feedpath, so it stays within memory
   * regardless of total site URL count.
   */
  compactUrls: (ctx: TenantCtx) => Promise<void>
  /**
   * Site-wide convergence: mark every still-live URL whose owning feedpath is
   * absent from `liveFeedpaths` as removed. `compactUrls`/`snapshotUrls` only
   * prune URLs *inside* a feedpath that was re-observed; a whole feed dropped
   * from the sitemap list (no `snapshotUrls` call) leaves its URLs frozen-live
   * forever. This is the sidecar mirror of the D1 generation sweep: it rewrites
   * each dropped feedpath's `by-feed/<hash>/index.parquet` with `removedAt` set
   * and deletes its outstanding deltas (write-new-base + delete-deltas,
   * ADR-0002). Bounded per feedpath, so memory stays flat regardless of site
   * size. Live feedpaths are never touched.
   */
  reconcile: (
    ctx: TenantCtx,
    opts: { liveFeedpaths: readonly string[], at?: number },
  ) => Promise<ReconcileResult>
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
    // Absent object → undefined (first-run no-op). A real read failure or a
    // JSON parse error propagates: both are genuine failures the caller must
    // not mistake for "this key has never been written".
    const bytes = await readOptional(ds, key)
    if (bytes === undefined)
      return undefined
    return JSON.parse(new TextDecoder().decode(bytes)) as T
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
      // Per-feedpath index: the whole file is this sitemap's URLs, so the read
      // is bounded by one sitemap's size regardless of how large the site is.
      const indexBytes = await readOptional(ds, sitemapUrlsIndexKey(ctx, fpHash))
      const indexRows = indexBytes ? await decodeParquetToRows(indexBytes) : []
      // Apply any deltas not yet folded into the index. Fold in chronological
      // order (the delta filename embeds an ISO date prefix → lexical sort).
      const deltaKeys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)).sort()
      const live = new Map<string, SitemapUrlRecord>()
      const removedMap = new Map<string, SitemapUrlRecord>()
      for (const row of indexRows) {
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
        const dBytes = await readOptional(ds, key)
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
        const bytes = await readOptional(ds, key)
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
      const deltaKeys = await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)
      // Group outstanding deltas by feedpath. Only feedpaths with new deltas
      // need recompaction; every other per-feedpath index is already current.
      const deltasByFeed = new Map<string, string[]>()
      for (const key of deltaKeys) {
        const m = SITEMAP_URLS_DELTA_PREFIX_RE.exec(key)
        if (!m)
          continue
        const list = deltasByFeed.get(m[2]) ?? []
        list.push(key)
        deltasByFeed.set(m[2], list)
      }

      // Compact one feedpath at a time. Peak memory is bounded by a single
      // sitemap's URL count plus its deltas — never the whole site's index.
      for (const [fpHash, feedDeltaKeys] of deltasByFeed) {
        const indexKey = sitemapUrlsIndexKey(ctx, fpHash)
        // Highest-risk swallow: if this prior-index read fails for real and we
        // treat it as absent, we'd rewrite the index from deltas alone and drop
        // every URL the index held. `readOptional` keeps a genuinely-absent
        // index as `undefined` (first compaction) but propagates a real failure.
        const indexBytes = await readOptional(ds, indexKey)
        const indexRows = indexBytes ? await decodeParquetToRows(indexBytes) : []
        const live = new Map<string, SitemapUrlRecord>()
        const removed = new Map<string, SitemapUrlRecord>()
        for (const row of indexRows) {
          const rec = rowToUrlRecord(row)
          if (rec.removedAt != null)
            removed.set(rec.urlHash, rec)
          else
            live.set(rec.urlHash, rec)
        }
        // Fold chronologically — the delta filename embeds an ISO date prefix.
        const consumed: string[] = []
        for (const key of feedDeltaKeys.sort()) {
          const bytes = await readOptional(ds, key)
          if (!bytes)
            continue
          consumed.push(key)
          const rows = await decodeParquetToRows(bytes)
          for (const r of rows) {
            const urlHash = String(r.url_hash)
            const at = Number(r.at)
            const op = String(r.op)
            if (op === 'added') {
              const prev = live.get(urlHash) ?? removed.get(urlHash)
              removed.delete(urlHash)
              live.set(urlHash, {
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
              const prev = live.get(urlHash)
              live.delete(urlHash)
              if (prev)
                removed.set(urlHash, { ...prev, removedAt: at })
            }
          }
        }
        const merged: SitemapUrlRecord[] = [...live.values(), ...removed.values()]
        merged.sort((a, b) => (a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0))
        const bytes = encodeRowsToParquetFlex(merged.map(urlRecordToRow), {
          columns: URLS_INDEX_COLUMNS,
          sortKey: ['feedpath_hash', 'url_hash'],
        })
        await ds.write(indexKey, bytes)
        if (consumed.length > 0)
          await ds.delete(consumed)
      }
    },

    async reconcile(ctx, { liveFeedpaths, at: atOpt }) {
      const at = atOpt ?? now()
      const liveHashes = new Set(liveFeedpaths.map(fp => hash(fp)))

      // Every feedpath with persisted state: compacted by-feed index files +
      // any outstanding (uncompacted) delta files. A feedpath the live set no
      // longer contains is a dropped feed; its live URLs must be removed.
      const present = new Set<string>()
      for (const key of await ds.list(`${sitemapUrlsIndexPrefix(ctx)}/`)) {
        const m = /\/by-feed\/([0-9a-f]+)\/index\.parquet$/.exec(key)
        if (m)
          present.add(m[1]!)
      }
      const deltasByFeed = new Map<string, string[]>()
      for (const key of await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)) {
        const m = SITEMAP_URLS_DELTA_PREFIX_RE.exec(key)
        if (!m)
          continue
        present.add(m[2]!)
        const list = deltasByFeed.get(m[2]!) ?? []
        list.push(key)
        deltasByFeed.set(m[2]!, list)
      }

      let feedpathsPruned = 0
      let urlsRemoved = 0
      for (const fpHash of present) {
        if (liveHashes.has(fpHash))
          continue
        // Fold the dropped feed's index + deltas into a final live/removed
        // state, then transition everything still live to removed. Identical
        // fold to compactUrls but scoped to one (now-dead) feedpath.
        const indexKey = sitemapUrlsIndexKey(ctx, fpHash)
        const indexBytes = await readOptional(ds, indexKey)
        const indexRows = indexBytes ? await decodeParquetToRows(indexBytes) : []
        const live = new Map<string, SitemapUrlRecord>()
        const removed = new Map<string, SitemapUrlRecord>()
        for (const row of indexRows) {
          const r = rowToUrlRecord(row)
          if (r.removedAt != null)
            removed.set(r.urlHash, r)
          else
            live.set(r.urlHash, r)
        }
        const consumed: string[] = []
        for (const key of (deltasByFeed.get(fpHash) ?? []).sort()) {
          const bytes = await readOptional(ds, key)
          if (!bytes)
            continue
          consumed.push(key)
          const rows = await decodeParquetToRows(bytes)
          for (const r of rows) {
            const urlHash = String(r.url_hash)
            const dat = Number(r.at)
            if (String(r.op) === 'added') {
              const prev = live.get(urlHash) ?? removed.get(urlHash)
              removed.delete(urlHash)
              live.set(urlHash, {
                feedpath: String(r.feedpath),
                feedpathHash: fpHash,
                urlHash,
                loc: String(r.loc),
                lastmod: r.lastmod == null ? undefined : String(r.lastmod),
                firstSeenAt: prev?.firstSeenAt ?? dat,
                lastSeenAt: dat,
              })
            }
            else if (String(r.op) === 'removed') {
              const prev = live.get(urlHash)
              live.delete(urlHash)
              if (prev)
                removed.set(urlHash, { ...prev, removedAt: dat })
            }
          }
        }

        const hadLive = live.size > 0
        if (!hadLive && consumed.length === 0)
          continue // already fully removed + nothing to compact
        for (const [urlHash, r] of live) {
          removed.set(urlHash, { ...r, removedAt: at })
          urlsRemoved++
        }
        const merged = [...removed.values()]
        merged.sort((a, b) => (a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0))
        const bytes = encodeRowsToParquetFlex(merged.map(urlRecordToRow), {
          columns: URLS_INDEX_COLUMNS,
          sortKey: ['feedpath_hash', 'url_hash'],
        })
        await ds.write(indexKey, bytes)
        if (consumed.length > 0)
          await ds.delete(consumed)
        if (hadLive)
          feedpathsPruned++
      }
      return { feedpathsPruned, urlsRemoved }
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
    // Absent index → the empty default (first-run no-op). A real read failure or
    // a parse error propagates rather than masquerading as a fresh empty index,
    // which would clobber real state on the next `writeBatch`.
    const bytes = await readOptional(ds, key)
    if (bytes === undefined)
      return { version: 1, records: {} }
    return JSON.parse(new TextDecoder().decode(bytes)) as IndexingMetadataIndex
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
    // Absent doc → the empty default (first-run no-op). A real read failure or a
    // parse error propagates rather than reading as "no empty types", which
    // would re-probe every searchType on the next sync or lose markers on write.
    const bytes = await readOptional(ds, key)
    if (bytes === undefined)
      return { version: 1, emptyTypes: [], markedAt: {} }
    return JSON.parse(new TextDecoder().decode(bytes)) as EmptyTypesDoc
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
