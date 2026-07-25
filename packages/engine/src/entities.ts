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
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { decodeParquetToRows, encodeRowsToParquetFlex } from './adapters/hyparquet'
import { readOptional } from './adapters/read-optional'
import {
  emptyTypesKey,
  hashSortedUrlList,
  hashUrl,
  hashUrlList,
  indexingMetadataIndexKey,
  inspectionBaseKey,
  inspectionEventKey,
  inspectionEventsPrefix,
  inspectionHistoryPrefix,
  inspectionHistoryShardKey,
  inspectionParquetKey,
  inspectionTransitionsMonthKey,
  parseSitemapUrlsDeltaKey,
  sitemapHistoryKey,
  sitemapIndexKey,
  sitemapUrlsDeltaKey,
  sitemapUrlsEventKey,
  sitemapUrlsEventSeedKey,
  sitemapUrlsEventsPrefix,
  sitemapUrlsGenerationKey,
  sitemapUrlsIndexKey,
  sitemapUrlsIndexPrefix,
  sitemapUrlsPendingGenerationKey,
  sitemapUrlsPendingGenerationsPrefix,
  sitemapUrlsPrefix,
  sitemapUrlsProjectionManifestKey,
  sitemapUrlsReconcileGenerationKey,
} from './entity-keys'
import {
  decodeSitemapProjectionManifest,
  emptySitemapProjectionManifest,
  selectSitemapProjectionFiles,
  SITEMAP_PROJECTION_GRACE_MS,
  withSitemapProjectionFeed,
} from './sitemap-projection'

export * from './entity-keys'
// The versioned query→canonical(+intent) dimension is an entity store; surface
// it on the same `@gscdump/engine/entities` subpath.
export * from './query-dim'

export * from './sitemap-projection'

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
const ENTITY_IO_CONCURRENCY = 8

async function mapEntityIo<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0)
    return []
  const results = Array.from({ length: items.length }, () => undefined as R | undefined)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length)
        return
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(ENTITY_IO_CONCURRENCY, items.length) }, worker))
  return results as R[]
}

// --- Append-only inspection-event store (the source-of-truth replacing the
// D1-fed `materialize` sidecar). Writes are immutable per-batch parquet under
// `events/<YYYY-MM>/<batchId>.parquet` carrying the FULL fidelity column set;
// `compactInspections` folds them into a `base.parquet` (latest-per-url,
// newest-wins by `inspectedAt`). Reads merge base + uncompacted events and
// dedup newest-wins at query time — mirrors the sitemap-urls delta/compaction
// shape, just keyed by `urlHash` instead of feedpath. ---

const INSPECTION_EVENT_KEY_RE = /\/inspections\/events\/\d{4}-\d{2}\/[^/]+\.parquet$/

/**
 * Directory prefix for a month's history shards. Each shard is a UUID-keyed
 * blob under this prefix; `appendHistory` writes one per call, `loadHistory`
 * lists + concatenates.
 */
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
  compactInspections: (
    ctx: TenantCtx,
    opts?: {
      /**
       * Also record state changes into the durable transitions sidecar.
       * Default OFF so publishing this is inert until a canary opts in.
       */
      transitions?: boolean
    },
  ) => Promise<{ baseRowCount: number, eventsFolded: number, eventFilesDeleted: number, transitionsWritten: number }>
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
const INSPECTION_EVENT_COLUMNS: readonly ColumnDef[] = [
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

/**
 * Fields whose change constitutes a TRANSITION.
 *
 * `lastCrawlTime` is deliberately absent: Google re-crawls far more often than
 * it changes its mind, so keying on it would make nearly every observation a
 * transition and collapse the compaction ratio the storage budget depends on.
 */
const TRANSITION_STATE_FIELDS = [
  'indexStatus',
  'coverageState',
  'robotsTxtState',
  'indexingState',
  'pageFetchState',
  'googleCanonical',
] as const

/**
 * Columns of the append-only transitions sidecar.
 *
 * There is NO `changedAt`, by construction. The change happened somewhere in
 * `[changedAfter, changedBefore)` — the sampler observes on a 7-120 day
 * backoff, so a point estimate would assert a precision the data cannot carry.
 * Making it unrepresentable stops a consumer inventing one.
 */
const INSPECTION_TRANSITION_COLUMNS: readonly ColumnDef[] = [
  { name: 'urlHash', type: 'VARCHAR', nullable: false },
  { name: 'url', type: 'VARCHAR', nullable: false },
  /** `inspectedAt` of the last observation still showing the OLD state. */
  { name: 'changedAfter', type: 'VARCHAR', nullable: false },
  /** `inspectedAt` of the first observation showing the NEW state. */
  { name: 'changedBefore', type: 'VARCHAR', nullable: false },
  ...TRANSITION_STATE_FIELDS.flatMap((field): ColumnDef[] => {
    const capped = field[0]!.toUpperCase() + field.slice(1)
    return [
      { name: `from${capped}`, type: 'VARCHAR', nullable: true },
      { name: `to${capped}`, type: 'VARCHAR', nullable: true },
    ]
  }),
]

/** True when the two observations differ on any transition-defining field. */
function isStateTransition(before: Row, after: Row): boolean {
  return TRANSITION_STATE_FIELDS.some(field => (before[field] ?? null) !== (after[field] ?? null))
}

function buildTransitionRow(before: Row, after: Row): Row {
  const row: Row = {
    urlHash: String(after.urlHash),
    url: String(after.url ?? before.url ?? ''),
    changedAfter: String(before.inspectedAt ?? ''),
    changedBefore: String(after.inspectedAt ?? ''),
  }
  for (const field of TRANSITION_STATE_FIELDS) {
    const capped = field[0]!.toUpperCase() + field.slice(1)
    row[`from${capped}`] = (before[field] ?? null) as string | null
    row[`to${capped}`] = (after[field] ?? null) as string | null
  }
  return row
}

/**
 * Merge new transitions into their month files (read-modify-write).
 *
 * Deduped on `(urlHash, changedBefore)`, which is unique per transition: a
 * replayed batch or a compaction re-run after a crash re-derives the same rows
 * and converges instead of double-counting a regression.
 *
 * Whole-file writes only, per ADR-0002.
 */
async function appendTransitions(
  ds: DataSource,
  ctx: TenantCtx,
  rows: readonly Row[],
): Promise<number> {
  if (rows.length === 0)
    return 0

  const byMonth = new Map<string, Row[]>()
  for (const row of rows) {
    const month = transitionMonth(row)
    const bucket = byMonth.get(month)
    if (bucket)
      bucket.push(row)
    else
      byMonth.set(month, [row])
  }

  let written = 0
  for (const [month, monthRows] of byMonth) {
    const key = inspectionTransitionsMonthKey(ctx, month)
    const existingBytes = await readOptional(ds, key)
    const existing = existingBytes ? await decodeParquetToRows(existingBytes) : []

    const seen = new Set(existing.map(r => `${String(r.urlHash)}\u0000${String(r.changedBefore)}`))
    const fresh = monthRows.filter((r) => {
      const id = `${String(r.urlHash)}\u0000${String(r.changedBefore)}`
      if (seen.has(id))
        return false
      seen.add(id)
      return true
    })
    if (fresh.length === 0)
      continue

    const merged = [...existing, ...fresh]
    await ds.write(key, encodeRowsToParquetFlex(merged, {
      columns: INSPECTION_TRANSITION_COLUMNS,
      // Same sort key as the base so a per-URL history lookup prunes row groups.
      sortKey: ['urlHash'],
    }))
    written += fresh.length
  }
  return written
}

/** `YYYY-MM` partition for a transition, taken from when it was OBSERVED. */
function transitionMonth(row: Row): string {
  return String(row.changedBefore ?? '').slice(0, 7) || 'unknown'
}

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
      const shards = [...byMonth].map(([yearMonth, batch]) => {
        const shard: InspectionHistoryShard = { version: 1, records: batch }
        const bytes = encodeJsonBigintSafe(shard)
        if (bytes.byteLength > INSPECTION_HISTORY_MAX_BYTES) {
          throw new Error(
            `inspection history shard exceeds ${INSPECTION_HISTORY_MAX_BYTES} bytes (got ${bytes.byteLength}); split the batch`,
          )
        }
        return { key: inspectionHistoryShardKey(ctx, yearMonth, batchId), bytes }
      })
      await mapEntityIo(shards, shard => ds.write(shard.key, shard.bytes))
    },

    async loadHistory(ctx, yearMonth) {
      const keys = await ds.list(inspectionHistoryPrefix(ctx, yearMonth))
      if (keys.length === 0)
        return undefined
      const records = await mapEntityIo(keys, async (key): Promise<InspectionRecord[]> => {
        // Absent shard (raced delete between list+read) → skip; a real read
        // failure propagates rather than silently dropping the shard's records.
        const bytes = await readOptional(ds, key)
        if (!bytes)
          return []
        const shard = await Promise.resolve()
          .then(() => JSON.parse(new TextDecoder().decode(bytes)) as InspectionHistoryShard)
          .catch((err: Error) => {
            console.warn('[inspection.loadHistory] failed to decode shard', { key, error: err.message })
            return undefined
          })
        return shard?.records ?? []
      })
      return { version: 1, records: records.flat() }
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
      const files = [...byMonth].map(([month, batch]) => {
        const bytes = encodeRowsToParquetFlex(batch as Row[], {
          columns: INSPECTION_EVENT_COLUMNS,
          sortKey: ['urlHash'],
        })
        const key = inspectionEventKey(ctx, month, batchId)
        return { key, bytes }
      })
      await mapEntityIo(files, file => ds.write(file.key, file.bytes))
      return { keys: files.map(file => file.key), rowCount: rows.length }
    },

    async compactInspections(ctx, opts) {
      const eventKeys = (await ds.list(`${inspectionEventsPrefix(ctx)}/`))
        .filter(k => INSPECTION_EVENT_KEY_RE.test(k))
      // Nothing outstanding → leave the base untouched (no needless rewrite).
      if (eventKeys.length === 0)
        return { baseRowCount: 0, eventsFolded: 0, eventFilesDeleted: 0, transitionsWritten: 0 }

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
      // Compaction already holds BOTH rows a transition needs: the prior state
      // (the base row, which is the previous newest-wins observation) and the
      // incoming one. Detecting the change here costs one comparison; it does
      // not need history reconstruction, because the pair is right there.
      const transitions: Row[] = []
      const consider = (row: Row): void => {
        const h = String(row.urlHash)
        const prev = latest.get(h)
        const isNewer = !prev || String(row.inspectedAt ?? '') > String(prev.inspectedAt ?? '')
        if (isNewer) {
          if (opts?.transitions && prev && isStateTransition(prev, row))
            transitions.push(buildTransitionRow(prev, row))
          latest.set(h, row)
        }
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
      const eventRows: Row[] = []
      const eventFiles = await mapEntityIo(eventKeys.sort(), async (key) => {
        const bytes = await readOptional(ds, key)
        if (!bytes)
          return undefined
        return { key, rows: await decodeParquetToRows(bytes) }
      })
      for (const file of eventFiles) {
        if (!file)
          continue
        const { key, rows } = file
        consumed.push(key)
        eventRows.push(...rows)
        eventsFolded += rows.length
      }
      // Batch IDs are random, so object-key order says nothing about
      // observation order. Process each URL's outstanding observations
      // chronologically or a newer lexical batch can hide intermediate changes.
      eventRows.sort((a, b) =>
        String(a.urlHash).localeCompare(String(b.urlHash))
        || String(a.inspectedAt ?? '').localeCompare(String(b.inspectedAt ?? '')),
      )
      for (const row of eventRows)
        consider(row)

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

      // Written BEFORE the event delete: if this throws, the events survive and
      // the next compaction re-derives the same transitions. Writing after the
      // delete would lose them permanently on failure — which is precisely how
      // this data has already been lost three times.
      const transitionsWritten = opts?.transitions
        ? await appendTransitions(ds, ctx, transitions)
        : 0

      if (consumed.length > 0)
        await ds.delete(consumed)
      return { baseRowCount: merged.length, eventsFolded, eventFilesDeleted: consumed.length, transitionsWritten }
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

// Compacted URL state is partitioned by feedpath: one small `index.parquet`
// per sitemap, not one tenant-wide blob. Every sitemap operation (sync, diff,
// compaction) is scoped to a single feedpath, so storage is keyed the same
// way — peak memory is bounded by one sitemap's URL count, never the whole
// site's. Disposable state deltas compact into this index; immutable membership
// events remain available for historical analytics.
const SITEMAP_URLS_EVENT_PREFIX_RE = /\/urls\/events\/(\d{4}-\d{2}-\d{2})__[0-9a-f]+__\d+__[0-9a-f]+\.parquet$/
const SITEMAP_URLS_PENDING_GENERATION_RE = /\/urls\/generations\/pending\/([0-9a-f]+)\.json$/

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
  { name: 'generation_id', type: 'VARCHAR', nullable: true },
]

const URLS_EVENT_COLUMNS: readonly ColumnDef[] = [
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

interface SitemapEventSeed {
  version: 1
  generationId: string
  observedAt: number
}

interface SitemapSnapshotGenerationCheckpoint {
  _tag: 'snapshot'
  version: 1
  generationId: string
  observedAt: number
  eventDigest: string
  result: SnapshotUrlsResult
}

interface SitemapReconcileGenerationCheckpoint {
  _tag: 'reconcile'
  version: 1
  generationId: string
  observedAt: number
  eventDigest: string
}

type SitemapGenerationCheckpoint
  = | SitemapSnapshotGenerationCheckpoint
    | SitemapReconcileGenerationCheckpoint

interface SitemapSiteGenerationCheckpoint {
  version: 1
  generationId: string
  observedAt: number
  inputDigest: string
}

interface SitemapPendingGeneration {
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

interface SitemapUrlState {
  live: Map<string, SitemapUrlRecord>
  removed: Map<string, SitemapUrlRecord>
}

interface SitemapDeltaFile {
  key: string
  rows: Row[]
}

function createSitemapUrlState(indexRows: readonly Row[]): SitemapUrlState {
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

function applySitemapDeltaRows(state: SitemapUrlState, rows: readonly Row[]): void {
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

function applySitemapDeltaFiles(state: SitemapUrlState, files: readonly SitemapDeltaFile[]): void {
  for (const file of files)
    applySitemapDeltaRows(state, file.rows)
}

function sortSitemapDeltaFiles(files: SitemapDeltaFile[]): SitemapDeltaFile[] {
  return files.sort((a, b) => a.key.localeCompare(b.key))
}

async function readSitemapDeltaFiles(ds: DataSource, keys: readonly string[]): Promise<SitemapDeltaFile[]> {
  const files = await mapEntityIo(keys, async (key) => {
    const bytes = await readOptional(ds, key)
    return bytes ? { key, rows: await decodeParquetToRows(bytes) } : undefined
  })
  return sortSitemapDeltaFiles(files.filter((file): file is SitemapDeltaFile => file !== undefined))
}

function dateInRange(date: string, range?: DateRange): boolean {
  return (!range?.from || date >= range.from) && (!range?.to || date <= range.to)
}

export function createSitemapReadStore(opts: CreateSitemapReadStoreOptions): SitemapReadStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  return {
    async loadIndex(ctx) {
      return (await readJson<SitemapIndex>(sitemapIndexKey(ctx))) ?? { version: 1, records: {} }
    },

    async getLatest(ctx, path) {
      const index = await readJson<SitemapIndex>(sitemapIndexKey(ctx))
      return index?.records[hash(path)]
    },

    async* loadUrls(ctx, feedpath, loadOpts) {
      const feedpathHash = hash(feedpath)
      const listedDeltaKeys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`))
        .filter(key => parseSitemapUrlsDeltaKey(key)?.feedpathHash === feedpathHash)
      // Load listed delta bytes before reading the projection watermark. A
      // compactor may publish a newer base while this read is in flight; the
      // grace window keeps these bytes available until every pre-publish
      // reader has finished.
      const listedDeltaFiles = await readSitemapDeltaFiles(ds, listedDeltaKeys)
      const manifestBytes = await readOptional(ds, sitemapUrlsProjectionManifestKey(ctx))
      const manifest = manifestBytes
        ? decodeSitemapProjectionManifest(new TextDecoder().decode(manifestBytes))
        : undefined
      // Base publication precedes the manifest watermark. Reading the base
      // after the manifest prevents the stale combination of old base plus new
      // watermark, which would filter the only delta carrying the new state.
      const indexRows = await readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash))
        .then(bytes => bytes ? decodeParquetToRows(bytes) : [])
      const currentDeltaKeys = new Set(
        selectSitemapProjectionFiles([], listedDeltaKeys, manifest).deltaKeys,
      )
      const state = createSitemapUrlState(indexRows)
      applySitemapDeltaFiles(
        state,
        listedDeltaFiles.filter(file => currentDeltaKeys.has(file.key)),
      )
      for (const record of state.live.values())
        yield record
      if (loadOpts?.includeRemoved) {
        for (const record of state.removed.values())
          yield record
      }
    },

    async* loadDeltas(ctx, dateRange) {
      const [listedKeys, manifestBytes] = await Promise.all([
        ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`),
        readOptional(ds, sitemapUrlsProjectionManifestKey(ctx)),
      ])
      const manifest = manifestBytes
        ? decodeSitemapProjectionManifest(new TextDecoder().decode(manifestBytes))
        : undefined
      const keys = selectSitemapProjectionFiles([], listedKeys, manifest).deltaKeys.filter((key) => {
        const parsed = parseSitemapUrlsDeltaKey(key)
        return Boolean(parsed && dateInRange(parsed.date, dateRange))
      })
      const files = await readSitemapDeltaFiles(ds, keys)
      for (const file of files) {
        for (const row of file.rows) {
          const op = String(row.op)
          if (op !== 'added' && op !== 'removed')
            continue
          yield {
            feedpath: String(row.feedpath),
            feedpathHash: String(row.feedpath_hash),
            urlHash: String(row.url_hash),
            op,
            loc: String(row.loc),
            lastmod: row.lastmod == null ? undefined : String(row.lastmod),
            at: Number(row.at),
          }
        }
      }
    },

    async* loadEvents(ctx, dateRange) {
      // List immutable events before pending descriptors. A concurrent writer
      // publishes its descriptor first, so any event visible in this listing is
      // either already committed or will be excluded by the later pending read.
      const listedEventKeys = await ds.list(`${sitemapUrlsEventsPrefix(ctx)}/`)
      const pendingKeys = await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)
      const pendingEvents = new Set(
        (await mapEntityIo(pendingKeys, key => readJson<SitemapPendingGeneration>(key)))
          .filter((pending): pending is SitemapPendingGeneration => pending !== undefined)
          .map(pending => pending.eventKey),
      )
      const keys = listedEventKeys
        .filter((key) => {
          const match = SITEMAP_URLS_EVENT_PREFIX_RE.exec(key)
          return !pendingEvents.has(key)
            && Boolean(match?.[1] && dateInRange(match[1], dateRange))
        })
        .sort()
      for (const key of keys) {
        const bytes = await readOptional(ds, key)
        if (!bytes)
          continue
        const rows = await decodeParquetToRows(bytes)
        rows.sort((a, b) =>
          Number(a.observed_at) - Number(b.observed_at)
          || Number(a.sequence) - Number(b.sequence)
          || String(a.url_hash).localeCompare(String(b.url_hash)),
        )
        for (const row of rows) {
          const op = String(row.op)
          if (op !== 'added' && op !== 'removed')
            continue
          yield {
            feedpath: String(row.feedpath),
            feedpathHash: String(row.feedpath_hash),
            urlHash: String(row.url_hash),
            op,
            loc: String(row.loc),
            lastmod: row.lastmod == null ? undefined : String(row.lastmod),
            generationId: String(row.generation_id),
            observedAt: Number(row.observed_at),
            sequence: Number(row.sequence),
            projectsState: Boolean(row.projects_state),
          }
        }
      }
    },
  }
}

export function createSitemapStore(opts: CreateSitemapStoreOptions): SitemapStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl
  const now = opts.now ?? (() => Date.now())
  const withMutation = opts.withMutation
  const readStore = createSitemapReadStore({ dataSource: ds, hash })

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  function writeJson(key: string, value: unknown): Promise<void> {
    return ds.write(key, encodeJsonBigintSafe(value))
  }

  async function readProjectionManifest(ctx: TenantCtx): Promise<ReturnType<typeof emptySitemapProjectionManifest>> {
    const bytes = await readOptional(ds, sitemapUrlsProjectionManifestKey(ctx))
    return bytes
      ? decodeSitemapProjectionManifest(new TextDecoder().decode(bytes))
      : emptySitemapProjectionManifest()
  }

  async function deleteExpiredProjectionDeltas(
    manifest: ReturnType<typeof emptySitemapProjectionManifest>,
    deltaKeys: readonly string[],
    currentTime: number,
  ): Promise<void> {
    const expired = deltaKeys.filter((key) => {
      const parsed = parseSitemapUrlsDeltaKey(key)
      const feed = parsed ? manifest.feeds[parsed.feedpathHash] : undefined
      return Boolean(
        feed
        && key <= feed.compactedThrough
        && currentTime - feed.publishedAt >= SITEMAP_PROJECTION_GRACE_MS,
      )
    })
    if (expired.length > 0)
      await ds.delete(expired)
  }

  async function publishCurrentProjection(
    ctx: TenantCtx,
    feedpathHash: string,
    rows: readonly SitemapUrlRecord[],
    consumedDeltas: readonly SitemapDeltaFile[],
    manifest: ReturnType<typeof emptySitemapProjectionManifest>,
    publishedAt: number,
  ): Promise<ReturnType<typeof emptySitemapProjectionManifest>> {
    const bytes = encodeRowsToParquetFlex(rows.map(urlRecordToRow), {
      columns: URLS_INDEX_COLUMNS,
      sortKey: ['feedpath_hash', 'url_hash'],
    })
    await ds.write(sitemapUrlsIndexKey(ctx, feedpathHash), bytes)
    const compactedThrough = consumedDeltas.at(-1)?.key
    if (!compactedThrough)
      return manifest
    const next = withSitemapProjectionFeed(manifest, feedpathHash, {
      compactedThrough,
      publishedAt,
    })
    await writeJson(sitemapUrlsProjectionManifestKey(ctx), next)
    return next
  }

  function normalizedEventRows(rows: readonly Row[]): unknown[] {
    return rows
      .map(row => ({
        feedpath: String(row.feedpath),
        feedpathHash: String(row.feedpath_hash),
        urlHash: String(row.url_hash),
        op: String(row.op),
        loc: String(row.loc),
        lastmod: row.lastmod == null ? null : String(row.lastmod),
        generationId: String(row.generation_id),
        observedAt: Number(row.observed_at),
        sequence: Number(row.sequence),
        projectsState: Boolean(row.projects_state),
        seedGeneration: Boolean(row.seed_generation),
        generationKind: String(row.generation_kind),
        contentHash: row.content_hash == null ? null : String(row.content_hash),
        inputCount: row.input_count == null ? null : Number(row.input_count),
      }))
      .sort((a, b) =>
        a.observedAt - b.observedAt
        || a.sequence - b.sequence
        || a.urlHash.localeCompare(b.urlHash)
        || a.op.localeCompare(b.op),
      )
  }

  function eventDigest(rows: readonly Row[]): string {
    return hashUrl(JSON.stringify(normalizedEventRows(rows)))
  }

  function assertGenerationAccepted(
    generation: CompleteSitemapGeneration,
    checkpoint: { generationId: string, observedAt: number } | undefined,
    scope: string,
  ): 'newer' | 'same' {
    if (!checkpoint)
      return 'newer'
    if (generation.id === checkpoint.generationId) {
      if (generation.observedAt === checkpoint.observedAt)
        return 'same'
      throw new Error(`sitemap generation conflict for ${scope}: generation ${generation.id} changed observedAt`)
    }
    if (generation.observedAt > checkpoint.observedAt)
      return 'newer'
    const reason = generation.observedAt === checkpoint.observedAt ? 'ambiguous timestamp' : 'stale generation'
    throw new Error(`sitemap generation conflict for ${scope}: ${reason}`)
  }

  async function ensureEvents(
    ctx: TenantCtx,
    feedpathHash: string,
    generation: CompleteSitemapGeneration,
    rows: readonly Row[],
  ): Promise<{ rows: Row[], digest: string }> {
    const expectedDigest = eventDigest(rows)
    if (rows.length === 0)
      return { rows: [], digest: expectedDigest }
    const key = sitemapUrlsEventKey(ctx, feedpathHash, generation)
    await writeJson(sitemapUrlsPendingGenerationKey(ctx, feedpathHash), {
      version: 1,
      generationId: generation.id,
      observedAt: generation.observedAt,
      eventKey: key,
      eventDigest: expectedDigest,
    } satisfies SitemapPendingGeneration)
    const existing = await readOptional(ds, key)
    if (existing) {
      const existingRows = await decodeParquetToRows(existing)
      const existingDigest = eventDigest(existingRows)
      if (existingDigest !== expectedDigest)
        throw new Error(`sitemap generation conflict for ${feedpathHash}: immutable event digest changed`)
      return { rows: existingRows, digest: existingDigest }
    }
    const bytes = encodeRowsToParquetFlex(rows, {
      columns: URLS_EVENT_COLUMNS,
      sortKey: ['sequence', 'url_hash'],
    })
    await ds.write(key, bytes)
    return { rows: [...rows], digest: expectedDigest }
  }

  function eventRow(
    generation: CompleteSitemapGeneration,
    row: Row,
    metadata: {
      sequence: number
      projectsState: boolean
      seedGeneration: boolean
      generationKind: 'snapshot' | 'reconcile'
      contentHash?: string
      inputCount?: number
    },
  ): Row {
    return {
      feedpath: row.feedpath,
      feedpath_hash: row.feedpath_hash,
      url_hash: row.url_hash,
      op: row.op,
      loc: row.loc,
      lastmod: row.lastmod,
      generation_id: generation.id,
      observed_at: generation.observedAt,
      sequence: metadata.sequence,
      projects_state: metadata.projectsState ? 1 : 0,
      seed_generation: metadata.seedGeneration ? 1 : 0,
      generation_kind: metadata.generationKind,
      content_hash: metadata.contentHash ?? null,
      input_count: metadata.inputCount ?? null,
    }
  }

  function stateRowsFromEvents(rows: readonly Row[]): Row[] {
    return rows
      .filter(row => Boolean(row.projects_state))
      .map((row): Row => ({
        feedpath: row.feedpath,
        feedpath_hash: row.feedpath_hash,
        url_hash: row.url_hash,
        op: row.op,
        loc: row.loc,
        lastmod: row.lastmod,
        at: row.observed_at,
        generation_id: row.generation_id,
      }))
  }

  function checkpointFromEvents(rows: readonly Row[], digest: string): SitemapGenerationCheckpoint {
    const first = rows[0]
    if (!first)
      throw new Error('cannot checkpoint an empty sitemap event file')
    const generationId = String(first.generation_id)
    const observedAt = Number(first.observed_at)
    for (const row of rows) {
      if (String(row.generation_id) !== generationId || Number(row.observed_at) !== observedAt)
        throw new Error('sitemap event file contains multiple generations')
    }
    if (String(first.generation_kind) === 'snapshot') {
      const contentHash = String(first.content_hash)
      const inputCount = Number(first.input_count)
      const stateRows = stateRowsFromEvents(rows)
      const added = stateRows.filter(row => String(row.op) === 'added').length
      const removed = stateRows.filter(row => String(row.op) === 'removed').length
      return {
        _tag: 'snapshot',
        version: 1,
        generationId,
        observedAt,
        eventDigest: digest,
        result: {
          added,
          removed,
          kept: Math.max(0, inputCount - added),
          contentHash,
          unchanged: stateRows.length === 0,
        },
      }
    }
    return {
      _tag: 'reconcile',
      version: 1,
      generationId,
      observedAt,
      eventDigest: digest,
    }
  }

  async function projectEvents(
    ctx: TenantCtx,
    feedpathHash: string,
    rows: readonly Row[],
    digest: string,
  ): Promise<SitemapGenerationCheckpoint> {
    const checkpoint = checkpointFromEvents(rows, digest)
    const generation = { id: checkpoint.generationId, observedAt: checkpoint.observedAt }
    const stateRows = stateRowsFromEvents(rows)
    if (stateRows.length > 0) {
      const bytes = encodeRowsToParquetFlex(stateRows, {
        columns: URLS_DELTA_COLUMNS,
        sortKey: ['url_hash'],
      })
      await ds.write(sitemapUrlsDeltaKey(ctx, feedpathHash, generation), bytes)
    }
    if (rows.some(row => Boolean(row.seed_generation))) {
      await writeJson(sitemapUrlsEventSeedKey(ctx, feedpathHash), {
        version: 1,
        generationId: checkpoint.generationId,
        observedAt: checkpoint.observedAt,
      } satisfies SitemapEventSeed)
    }
    await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), checkpoint)
    return checkpoint
  }

  async function repairFeedProjection(
    ctx: TenantCtx,
    feedpathHash: string,
  ): Promise<SitemapGenerationCheckpoint | undefined> {
    const pendingKey = sitemapUrlsPendingGenerationKey(ctx, feedpathHash)
    const [checkpoint, pending] = await Promise.all([
      readJson<SitemapGenerationCheckpoint>(sitemapUrlsGenerationKey(ctx, feedpathHash)),
      readJson<SitemapPendingGeneration>(pendingKey),
    ])
    if (!pending)
      return checkpoint
    const pendingGeneration: CompleteSitemapGeneration = {
      _tag: 'complete',
      id: pending.generationId,
      observedAt: pending.observedAt,
    }
    if (checkpoint?.generationId === pending.generationId && checkpoint.observedAt !== pending.observedAt)
      throw new Error(`sitemap generation conflict for ${feedpathHash}: generation ${pending.generationId} changed observedAt`)
    if (checkpoint && pending.observedAt < checkpoint.observedAt) {
      await ds.delete([pendingKey])
      return checkpoint
    }
    const position = assertGenerationAccepted(pendingGeneration, checkpoint, feedpathHash)
    const eventBytes = await readOptional(ds, pending.eventKey)
    if (!eventBytes) {
      await ds.delete([pendingKey])
      return checkpoint
    }
    const rows = await decodeParquetToRows(eventBytes)
    const digest = eventDigest(rows)
    if (digest !== pending.eventDigest)
      throw new Error(`sitemap generation conflict for ${feedpathHash}: pending event digest changed`)
    if (position === 'same') {
      if (checkpoint?.eventDigest !== digest)
        throw new Error(`sitemap generation conflict for ${feedpathHash}: checkpoint digest changed`)
      await ds.delete([pendingKey])
      return checkpoint
    }
    const repaired = await projectEvents(ctx, feedpathHash, rows, digest)
    await ds.delete([pendingKey])
    return repaired
  }

  return {
    ...readStore,

    writeSnapshot(ctx, records) {
      return withMutation(ctx, async () => {
        if (records.length === 0)
          return
        const indexKey = sitemapIndexKey(ctx)
        const index = (await readJson<SitemapIndex>(indexKey)) ?? { version: 1, records: {} }
        const stamp = now()
        const historyDocs = new Map<string, SitemapHistoryDoc>()
        for (const record of records) {
          const feedpathHash = hash(record.path)
          index.records[feedpathHash] = record
          historyDocs.set(sitemapHistoryKey(ctx, feedpathHash, stamp), {
            version: 1,
            path: record.path,
            capturedAt: record.capturedAt,
            record,
          })
        }
        await mapEntityIo([...historyDocs], ([key, doc]) => writeJson(key, doc))
        await writeJson(indexKey, index)
      })
    },

    snapshotUrls(ctx, generation, feedpath, urls) {
      return withMutation(ctx, async () => {
        const feedpathHash = hash(feedpath)
        const contentHash = hashUrlList(urls)
        const checkpoint = await repairFeedProjection(ctx, feedpathHash)
        const feedPosition = assertGenerationAccepted(generation, checkpoint, feedpathHash)
        if (feedPosition === 'same') {
          if (checkpoint?._tag !== 'snapshot' || checkpoint.result.contentHash !== contentHash)
            throw new Error(`sitemap generation conflict for ${feedpathHash}: snapshot input changed`)
          return checkpoint.result
        }
        const siteCheckpoint = await readJson<SitemapSiteGenerationCheckpoint>(sitemapUrlsReconcileGenerationKey(ctx))
        const sitePosition = assertGenerationAccepted(generation, siteCheckpoint, 'site reconciliation')
        if (sitePosition === 'same')
          throw new Error('sitemap generation conflict: site generation was already reconciled')
        const priorByHash = new Map<string, SitemapUrlRecord>()
        for await (const record of readStore.loadUrls(ctx, feedpath, { includeRemoved: true }))
          priorByHash.set(record.urlHash, record)
        const livePrior = [...priorByHash.values()].filter(record => record.removedAt == null)
        const incomingByHash = new Map<string, ParsedUrl>()
        for (const url of urls)
          incomingByHash.set(hash(url.loc), url)

        const deltaRows: Row[] = []
        let added = 0
        let removed = 0
        let kept = 0
        for (const [urlHash, url] of incomingByHash) {
          const previous = priorByHash.get(urlHash)
          if (!previous || previous.removedAt != null) {
            added++
            deltaRows.push({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: urlHash,
              op: 'added',
              loc: url.loc,
              lastmod: url.lastmod ?? null,
              at: generation.observedAt,
              generation_id: generation.id,
            })
          }
          else {
            kept++
          }
        }
        for (const [urlHash, previous] of priorByHash) {
          if (previous.removedAt == null && !incomingByHash.has(urlHash)) {
            removed++
            deltaRows.push({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: urlHash,
              op: 'removed',
              loc: previous.loc,
              lastmod: previous.lastmod ?? null,
              at: generation.observedAt,
              generation_id: generation.id,
            })
          }
        }

        const seedKey = sitemapUrlsEventSeedKey(ctx, feedpathHash)
        const seed = await readJson<SitemapEventSeed>(seedKey)
        const isSeedGeneration = seed === undefined || seed.generationId === generation.id
        const seedRows: Row[] = isSeedGeneration
          ? livePrior.map(record => ({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: record.urlHash,
              op: 'added',
              loc: record.loc,
              lastmod: record.lastmod ?? null,
            }))
          : []
        const actualSequence = seedRows.length > 0 ? 1 : 0
        const inputCount = incomingByHash.size
        const proposedEvents = [
          ...seedRows.map(row => eventRow(generation, row, {
            sequence: 0,
            projectsState: false,
            seedGeneration: isSeedGeneration,
            generationKind: 'snapshot',
            contentHash,
            inputCount,
          })),
          ...deltaRows.map(row => eventRow(generation, row, {
            sequence: actualSequence,
            projectsState: true,
            seedGeneration: isSeedGeneration,
            generationKind: 'snapshot',
            contentHash,
            inputCount,
          })),
        ]
        const persistedEvents = await ensureEvents(ctx, feedpathHash, generation, proposedEvents)
        const result: SnapshotUrlsResult = {
          added,
          removed,
          kept,
          contentHash,
          unchanged: deltaRows.length === 0,
        }
        if (persistedEvents.rows.length > 0) {
          const projected = await projectEvents(ctx, feedpathHash, persistedEvents.rows, persistedEvents.digest)
          if (projected._tag !== 'snapshot')
            throw new Error(`sitemap generation conflict for ${feedpathHash}: expected snapshot event`)
          await ds.delete([sitemapUrlsPendingGenerationKey(ctx, feedpathHash)])
        }
        else {
          if (isSeedGeneration) {
            await writeJson(seedKey, {
              version: 1,
              generationId: generation.id,
              observedAt: generation.observedAt,
            } satisfies SitemapEventSeed)
          }
          await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), {
            _tag: 'snapshot',
            version: 1,
            generationId: generation.id,
            observedAt: generation.observedAt,
            eventDigest: persistedEvents.digest,
            result,
          } satisfies SitemapSnapshotGenerationCheckpoint)
        }
        return result
      })
    },

    compactUrls(ctx, compactOpts = {}) {
      return withMutation(ctx, async () => {
        const startedAt = now()
        const deadlineMs = compactOpts.deadlineMs ?? Number.POSITIVE_INFINITY
        const maxFeedpaths = compactOpts.maxFeedpaths ?? Number.POSITIVE_INFINITY
        for (const key of await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)) {
          const feedpathHash = SITEMAP_URLS_PENDING_GENERATION_RE.exec(key)?.[1]
          if (feedpathHash)
            await repairFeedProjection(ctx, feedpathHash)
        }
        const deltaKeys = await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)
        let projectionManifest = await readProjectionManifest(ctx)
        await deleteExpiredProjectionDeltas(projectionManifest, deltaKeys, startedAt)
        const activeDeltaKeys = selectSitemapProjectionFiles([], deltaKeys, projectionManifest).deltaKeys
        const deltasByFeed = new Map<string, string[]>()
        for (const key of activeDeltaKeys) {
          const feedpathHash = parseSitemapUrlsDeltaKey(key)?.feedpathHash
          if (!feedpathHash)
            continue
          const keys = deltasByFeed.get(feedpathHash) ?? []
          keys.push(key)
          deltasByFeed.set(feedpathHash, keys)
        }

        const totalFeedpaths = deltasByFeed.size
        let compactedFeedpaths = 0
        for (const [feedpathHash, feedDeltaKeys] of deltasByFeed) {
          if (compactedFeedpaths > 0 && (compactedFeedpaths >= maxFeedpaths || now() - startedAt >= deadlineMs))
            break
          const [indexRows, deltaFiles] = await Promise.all([
            readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash)).then(bytes => bytes ? decodeParquetToRows(bytes) : []),
            readSitemapDeltaFiles(ds, feedDeltaKeys),
          ])
          const state = createSitemapUrlState(indexRows)
          applySitemapDeltaFiles(state, deltaFiles)
          const merged = [...state.live.values(), ...state.removed.values()]
            .sort((a, b) => a.urlHash.localeCompare(b.urlHash))
          projectionManifest = await publishCurrentProjection(
            ctx,
            feedpathHash,
            merged,
            deltaFiles,
            projectionManifest,
            now(),
          )
          compactedFeedpaths++
        }
        return { compactedFeedpaths, remainingFeedpaths: totalFeedpaths - compactedFeedpaths }
      })
    },

    reconcile(ctx, generation, { liveFeedpaths }) {
      return withMutation(ctx, async () => {
        const liveHashes = new Set(liveFeedpaths.map(feedpath => hash(feedpath)))
        const inputDigest = hashSortedUrlList([...liveHashes])
        const siteCheckpoint = await readJson<SitemapSiteGenerationCheckpoint>(sitemapUrlsReconcileGenerationKey(ctx))
        const sitePosition = assertGenerationAccepted(generation, siteCheckpoint, 'site reconciliation')
        if (sitePosition === 'same') {
          if (siteCheckpoint?.inputDigest !== inputDigest)
            throw new Error('sitemap generation conflict: reconcile input changed')
          return { feedpathsPruned: 0, urlsRemoved: 0 }
        }

        const pendingFeedHashes = new Set<string>()
        for (const key of await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)) {
          const feedpathHash = SITEMAP_URLS_PENDING_GENERATION_RE.exec(key)?.[1]
          if (feedpathHash)
            pendingFeedHashes.add(feedpathHash)
        }
        const repairedCheckpoints = new Map<string, SitemapGenerationCheckpoint | undefined>()
        for (const feedpathHash of pendingFeedHashes) {
          repairedCheckpoints.set(
            feedpathHash,
            await repairFeedProjection(ctx, feedpathHash),
          )
        }

        const present = new Set<string>()
        const [indexKeys, deltaKeys] = await Promise.all([
          ds.list(`${sitemapUrlsIndexPrefix(ctx)}/`),
          ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`),
        ])
        let projectionManifest = await readProjectionManifest(ctx)
        await deleteExpiredProjectionDeltas(projectionManifest, deltaKeys, now())
        for (const feedpathHash of Object.keys(projectionManifest.feeds))
          present.add(feedpathHash)
        for (const key of indexKeys) {
          const match = /\/by-feed\/([0-9a-f]+)\/index\.parquet$/.exec(key)
          if (match?.[1])
            present.add(match[1])
        }
        const deltasByFeed = new Map<string, string[]>()
        const activeDeltaKeys = selectSitemapProjectionFiles([], deltaKeys, projectionManifest).deltaKeys
        for (const key of activeDeltaKeys) {
          const feedpathHash = parseSitemapUrlsDeltaKey(key)?.feedpathHash
          if (!feedpathHash)
            continue
          present.add(feedpathHash)
          const keys = deltasByFeed.get(feedpathHash) ?? []
          keys.push(key)
          deltasByFeed.set(feedpathHash, keys)
        }

        let feedpathsPruned = 0
        let urlsRemoved = 0
        for (const feedpathHash of present) {
          if (liveHashes.has(feedpathHash))
            continue
          const checkpoint = repairedCheckpoints.has(feedpathHash)
            ? repairedCheckpoints.get(feedpathHash)
            : await repairFeedProjection(ctx, feedpathHash)
          const feedPosition = assertGenerationAccepted(generation, checkpoint, feedpathHash)
          if (feedPosition === 'same' && checkpoint?._tag !== 'reconcile')
            throw new Error(`sitemap generation conflict for ${feedpathHash}: expected reconcile event`)
          const [indexRows, deltaFiles] = await Promise.all([
            readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash)).then(bytes => bytes ? decodeParquetToRows(bytes) : []),
            readSitemapDeltaFiles(ds, deltasByFeed.get(feedpathHash) ?? []),
          ])
          const state = createSitemapUrlState(indexRows)
          applySitemapDeltaFiles(state, deltaFiles)
          const live = [...state.live.values()]
          const seedKey = sitemapUrlsEventSeedKey(ctx, feedpathHash)
          const seed = await readJson<SitemapEventSeed>(seedKey)
          const isSeedGeneration = seed === undefined || seed.generationId === generation.id
          const seedRows: Row[] = isSeedGeneration
            ? live.map(record => ({
                feedpath: record.feedpath,
                feedpath_hash: feedpathHash,
                url_hash: record.urlHash,
                op: 'added',
                loc: record.loc,
                lastmod: record.lastmod ?? null,
              }))
            : []
          const removalRows: Row[] = live.map(record => ({
            feedpath: record.feedpath,
            feedpath_hash: feedpathHash,
            url_hash: record.urlHash,
            op: 'removed',
            loc: record.loc,
            lastmod: record.lastmod ?? null,
          }))
          const proposedEvents = feedPosition === 'newer'
            ? [
                ...seedRows.map(row => eventRow(generation, row, {
                  sequence: 0,
                  projectsState: false,
                  seedGeneration: isSeedGeneration,
                  generationKind: 'reconcile',
                })),
                ...removalRows.map(row => eventRow(generation, row, {
                  sequence: seedRows.length > 0 ? 1 : 0,
                  projectsState: true,
                  seedGeneration: isSeedGeneration,
                  generationKind: 'reconcile',
                })),
              ]
            : []
          const persistedEvents = feedPosition === 'newer'
            ? await ensureEvents(ctx, feedpathHash, generation, proposedEvents)
            : { rows: [] as Row[], digest: checkpoint!.eventDigest }
          if (isSeedGeneration && feedPosition === 'newer') {
            await writeJson(seedKey, {
              version: 1,
              generationId: generation.id,
              observedAt: generation.observedAt,
            } satisfies SitemapEventSeed)
          }
          const removedHashes = new Set(
            persistedEvents.rows
              .filter(row => Boolean(row.projects_state) && String(row.op) === 'removed')
              .map(row => String(row.url_hash)),
          )
          const removedBeforeFeed = urlsRemoved
          for (const record of live.filter(record => removedHashes.has(record.urlHash))) {
            state.live.delete(record.urlHash)
            state.removed.set(record.urlHash, { ...record, removedAt: generation.observedAt })
            urlsRemoved++
          }
          if (live.length > 0 || deltaFiles.length > 0) {
            const merged = [...state.live.values(), ...state.removed.values()]
              .sort((a, b) => a.urlHash.localeCompare(b.urlHash))
            projectionManifest = await publishCurrentProjection(
              ctx,
              feedpathHash,
              merged,
              deltaFiles,
              projectionManifest,
              now(),
            )
          }
          if (feedPosition === 'newer') {
            const feedCheckpoint: SitemapReconcileGenerationCheckpoint = persistedEvents.rows.length > 0
              ? checkpointFromEvents(persistedEvents.rows, persistedEvents.digest) as SitemapReconcileGenerationCheckpoint
              : {
                  _tag: 'reconcile',
                  version: 1,
                  generationId: generation.id,
                  observedAt: generation.observedAt,
                  eventDigest: persistedEvents.digest,
                }
            await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), feedCheckpoint)
            if (persistedEvents.rows.length > 0)
              await ds.delete([sitemapUrlsPendingGenerationKey(ctx, feedpathHash)])
          }
          if (urlsRemoved > removedBeforeFeed)
            feedpathsPruned++
        }
        await writeJson(sitemapUrlsReconcileGenerationKey(ctx), {
          version: 1,
          generationId: generation.id,
          observedAt: generation.observedAt,
          inputDigest,
        } satisfies SitemapSiteGenerationCheckpoint)
        return { feedpathsPruned, urlsRemoved }
      })
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
      await ds.write(key, encodeJsonBigintSafe(index))
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
    await ds.write(key, encodeJsonBigintSafe(doc))
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
