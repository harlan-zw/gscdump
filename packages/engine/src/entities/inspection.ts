// Per-site inspection store for slow-changing GSC state. Distinct family from the
// time-series fact tables — entities are point-lookup-by-id, not scanned.
//
// JSON-backed: a single index document per site at
//   `u_<u>/<s>/entities/inspections/index.json`
// keyed by URL hash, holding the latest inspection per URL. Append-only
// monthly history shards live alongside for state-over-time queries.

import type { ColumnDef, Row, TenantCtx } from '@gscdump/contracts'
import type { CanonicalDifferenceKind } from 'gscdump'
import type { ScheduleState } from '../schedule'
import type { DataSource } from '../storage'
import { GSCDUMP_INDEXING_TRANSITION_FIELDS } from '@gscdump/contracts'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { classifyCanonicalDifference } from 'gscdump'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import {
  inspectionBaseKey,
  inspectionEventKey,
  inspectionEventsPrefix,
  inspectionHistoryPrefix,
  inspectionHistoryShardKey,
  inspectionParquetKey,
  inspectionTransitionsMonthKey,
} from '../entity-keys'
import { mapEntityIo } from './io'

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
  /** Declared-vs-selected canonical classification, computed at inspection ingest. */
  canonicalMismatchKind: CanonicalDifferenceKind
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
   * Rewrite a legacy latest-only base with the canonical kind derived from the
   * canonical pair it already retains. Outstanding events must be compacted first.
   */
  backfillCanonicalMismatchKinds: (
    ctx: TenantCtx,
  ) => Promise<{ baseRowCount: number, rowsBackfilled: number, rewritten: boolean }>
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
  { name: 'canonicalMismatchKind', type: 'VARCHAR', nullable: false },
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

const CANONICAL_DIFFERENCE_KINDS = new Set<CanonicalDifferenceKind>([
  'none',
  'formatting',
  'path',
  'cross_domain',
])

function populateCanonicalMismatchKind(row: Row): boolean {
  const current = row.canonicalMismatchKind
  const expected = classifyCanonicalDifference(
    typeof row.userCanonical === 'string' ? row.userCanonical : null,
    typeof row.googleCanonical === 'string' ? row.googleCanonical : null,
  )
  const missingOrInvalid = typeof current !== 'string'
    || !CANONICAL_DIFFERENCE_KINDS.has(current as CanonicalDifferenceKind)
  row.canonicalMismatchKind = expected
  return missingOrInvalid || current !== expected
}

/**
 * Fields whose change constitutes a TRANSITION.
 *
 * `lastCrawlTime` is deliberately absent: Google re-crawls far more often than
 * it changes its mind, so keying on it would make nearly every observation a
 * transition and collapse the compaction ratio the storage budget depends on.
 */
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
  ...GSCDUMP_INDEXING_TRANSITION_FIELDS.flatMap((field): ColumnDef[] => {
    const capped = field[0]!.toUpperCase() + field.slice(1)
    return [
      { name: `from${capped}`, type: 'VARCHAR', nullable: true },
      { name: `to${capped}`, type: 'VARCHAR', nullable: true },
    ]
  }),
]

/** True when the two observations differ on any transition-defining field. */
function isStateTransition(before: Row, after: Row): boolean {
  return GSCDUMP_INDEXING_TRANSITION_FIELDS.some(field => (before[field] ?? null) !== (after[field] ?? null))
}

function buildTransitionRow(before: Row, after: Row): Row {
  const row: Row = {
    urlHash: String(after.urlHash),
    url: String(after.url ?? before.url ?? ''),
    changedAfter: String(before.inspectedAt ?? ''),
    changedBefore: String(after.inspectedAt ?? ''),
  }
  for (const field of GSCDUMP_INDEXING_TRANSITION_FIELDS) {
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
        populateCanonicalMismatchKind(row)
        merged.push(row)
      }
      const bytes = encodeRowsToParquetFlex(merged, {
        columns: INSPECTION_EVENT_COLUMNS,
        sortKey: ['urlHash'],
      })

      // Transitions must be durable before the base advances. If this write
      // fails, the prior base and source events still recreate the same change
      // on retry. appendTransitions dedupes partial multi-month writes.
      const transitionsWritten = opts?.transitions
        ? await appendTransitions(ds, ctx, transitions)
        : 0

      await ds.write(baseKey, bytes)

      if (consumed.length > 0)
        await ds.delete(consumed)
      return { baseRowCount: merged.length, eventsFolded, eventFilesDeleted: consumed.length, transitionsWritten }
    },

    async backfillCanonicalMismatchKinds(ctx) {
      const baseKey = inspectionBaseKey(ctx)
      const baseBytes = await readOptional(ds, baseKey)
      if (!baseBytes)
        return { baseRowCount: 0, rowsBackfilled: 0, rewritten: false }

      const rows = await decodeParquetToRows(baseBytes)
      let rowsBackfilled = 0
      for (const row of rows) {
        if (populateCanonicalMismatchKind(row))
          rowsBackfilled++
      }
      if (rowsBackfilled === 0)
        return { baseRowCount: rows.length, rowsBackfilled: 0, rewritten: false }

      await ds.write(baseKey, encodeRowsToParquetFlex(rows, {
        columns: INSPECTION_EVENT_COLUMNS,
        sortKey: ['urlHash'],
      }))
      return { baseRowCount: rows.length, rowsBackfilled, rewritten: true }
    },

    parquetUri(ctx) {
      return ds.uri?.(inspectionParquetKey(ctx))
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
