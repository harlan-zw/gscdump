import type {
  CompactionTier,
  DataSource,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  WriteCtx,
} from './storage'
import { MS_PER_DAY } from 'gscdump'
import { dayPartition, inferSearchType, mondayOfWeek, monthPartition, objectKey, quarterOfMonth, quarterPartition, weekPartition } from './layout'
import { currentSchemaVersion } from './schema'

const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2}-\d{2})$/
const WEEKLY_PARTITION_RE = /^weekly\/(\d{4}-\d{2}-\d{2})$/
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/
const QUARTERLY_PARTITION_RE = /^quarterly\/(\d{4})-Q([1-4])$/

export interface CompactionDeps {
  dataSource: DataSource
  manifestStore: ManifestStore
  codec: ParquetCodec
}

/**
 * Per-tier age threshold in days. Default ladder collapses on these gates:
 * - raw → d7 once a daily file is older than `raw` days (default 7).
 * - d7 → d30 once the entire weekly bucket sits behind `d7` days (default 30).
 * - d30 → d90 once the entire monthly bucket sits behind `d30` days (default 90).
 */
export interface CompactionThresholds {
  raw?: number
  d7?: number
  d30?: number
}

const DEFAULT_THRESHOLDS: Required<CompactionThresholds> = {
  raw: 7,
  d7: 30,
  d30: 90,
}

// Host policy: queue a per-(site, table) compaction job once the count of
// live raw daily files for a table crosses this. Matches the default
// `raw → d7` daily→weekly gate, so the host trigger fires the same day the
// engine's threshold-driven path would have collapsed the bucket.
export const RAW_DAILY_COMPACT_THRESHOLD = 7

// Predicate hosts use against `ManifestStore.listLive` results to decide
// whether a table's raw-daily count warrants kicking a compaction job.
export function countRawDailies(
  entries: ReadonlyArray<{ tier?: string | null, partition: string }>,
): number {
  return entries.filter(e => e.tier === 'raw' || (e.tier == null && e.partition.startsWith('daily/'))).length
}

/**
 * GSC `dataState='all'` finalizes ~3 days after a date. Until that grace
 * elapses, sync may still write fresh dailies into a bucket, so compacting
 * on bucket-end alone produces a partition that later collides with re-sync
 * dailies (double-counts at query time, since the resolver unions every
 * live tier). Every stage's effective cutoff is floored at this many days
 * past `bucketLatestMs` regardless of caller-supplied thresholds.
 */
const PENDING_WINDOW_DAYS = 4

interface StageDef {
  inputTier: CompactionTier
  outputTier: CompactionTier
  cutoffDays: number
  /** Bucket key for an input entry; entries sharing a key merge together. */
  bucketKey: (entry: ManifestEntry) => string | undefined
  /** Latest representative date of a bucket (UTC ms); compared against the cutoff. */
  bucketLatestMs: (bucketKey: string) => number
  /** Resulting partition string for a bucket key. */
  outputPartition: (bucketKey: string) => string
}

const RAW_TO_D7: StageDef = {
  inputTier: 'raw',
  outputTier: 'd7',
  cutoffDays: DEFAULT_THRESHOLDS.raw,
  bucketKey: (e) => {
    const m = e.partition.match(DAILY_PARTITION_RE)
    if (!m)
      return undefined
    return mondayOfWeek(m[1]!)
  },
  bucketLatestMs: monday => Date.parse(`${monday}T00:00:00Z`) + 6 * MS_PER_DAY,
  outputPartition: weekPartition,
}

const D7_TO_D30: StageDef = {
  inputTier: 'd7',
  outputTier: 'd30',
  cutoffDays: DEFAULT_THRESHOLDS.d7,
  bucketKey: (e) => {
    const m = e.partition.match(WEEKLY_PARTITION_RE)
    if (!m)
      return undefined
    return m[1]!.slice(0, 7)
  },
  bucketLatestMs: monthEndMs,
  outputPartition: monthPartition,
}

const D30_TO_D90: StageDef = {
  inputTier: 'd30',
  outputTier: 'd90',
  cutoffDays: DEFAULT_THRESHOLDS.d30,
  bucketKey: (e) => {
    const m = e.partition.match(MONTHLY_PARTITION_RE)
    if (!m)
      return undefined
    return quarterOfMonth(m[1]!)
  },
  bucketLatestMs: quarterEndMs,
  outputPartition: quarterPartition,
}

const STAGES: readonly StageDef[] = [RAW_TO_D7, D7_TO_D30, D30_TO_D90]

export async function compactTieredImpl(
  deps: CompactionDeps,
  ctx: WriteCtx,
  now: number,
  overrides: CompactionThresholds = {},
): Promise<void> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides }
  const stagesWithThresholds = STAGES.map(s => ({
    ...s,
    cutoffDays:
      s.outputTier === 'd7'
        ? thresholds.raw
        : s.outputTier === 'd30'
          ? thresholds.d7
          : thresholds.d30,
  }))

  for (const stage of stagesWithThresholds)
    await runStage(deps, ctx, stage, now)
}

async function runStage(
  deps: CompactionDeps,
  ctx: WriteCtx,
  stage: StageDef,
  now: number,
): Promise<void> {
  const effectiveDays = Math.max(stage.cutoffDays, PENDING_WINDOW_DAYS)
  const cutoff = now - effectiveDays * MS_PER_DAY

  // Intentionally unfiltered by searchType — compaction sweeps every slice
  // (web, discover, ...) for the tenant+table+tier in one pass. Same-type
  // bucketing happens below via the `(searchType, bucketKey)` composite key
  // so different searchTypes never merge into a single output parquet.
  const candidates = await deps.manifestStore.listLive({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: ctx.table,
    tier: stage.inputTier,
  })

  // Bucket key includes searchType so files for different types never merge
  // into a single output. Each (bucketKey, searchType) combination produces
  // its own compacted file.
  const buckets = new Map<string, ManifestEntry[]>()
  for (const entry of candidates) {
    // Hourly partitions are GC-only — never merged into daily/weekly/monthly
    // cohorts. Belt-and-braces against future stage definitions that might
    // otherwise scoop them up.
    if (entry.partition.startsWith('hourly/'))
      continue
    const key = stage.bucketKey(entry)
    if (!key)
      continue
    if (stage.bucketLatestMs(key) >= cutoff)
      continue
    const searchType = inferSearchType(entry)
    const compositeKey = `${searchType}\0${key}`
    if (!buckets.has(compositeKey))
      buckets.set(compositeKey, [])
    buckets.get(compositeKey)!.push(entry)
  }

  for (const [compositeKey, entries] of buckets) {
    const [searchType, bucket] = compositeKey.split('\0') as [string, string]
    // Single-file bucket whose partition already matches the target shape
    // is already compacted at this tier; no work to do.
    const targetPartition = stage.outputPartition(bucket)
    if (entries.length === 1 && entries[0]!.partition === targetPartition)
      continue

    await deps.manifestStore.withLock(
      { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, partition: targetPartition },
      async () => {
        const key = objectKey(ctx, ctx.table, targetPartition, now, searchType as ReturnType<typeof inferSearchType>)
        const { bytes, rowCount } = await deps.codec.compactRows(
          { table: ctx.table },
          entries.map(e => e.objectKey),
          key,
          deps.dataSource,
        )

        const newEntry: ManifestEntry = {
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partition: targetPartition,
          objectKey: key,
          rowCount,
          bytes,
          createdAt: now,
          schemaVersion: currentSchemaVersion(ctx.table),
          tier: stage.outputTier,
          ...(searchType !== 'web' ? { searchType: searchType as ReturnType<typeof inferSearchType> } : {}),
        }
        await deps.manifestStore.registerVersion(newEntry, entries)
      },
    )
  }
}

export function enumeratePartitions(startDate: string, endDate: string): string[] {
  const out: string[] = []
  const [sy, sm, sd] = startDate.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = endDate.split('-').map(Number) as [number, number, number]
  const start = Date.UTC(sy, sm - 1, sd)
  const end = Date.UTC(ey, em - 1, ed)
  if (end < start)
    return out

  const seenWeeks = new Set<string>()
  const seenMonths = new Set<string>()
  const seenQuarters = new Set<string>()
  for (let t = start; t <= end; t += 86400_000) {
    const d = new Date(t)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    const isoDay = `${y}-${m}-${day}`
    const isoMonth = `${y}-${m}`
    out.push(dayPartition(isoDay))
    const monday = mondayOfWeek(isoDay)
    if (!seenWeeks.has(monday)) {
      seenWeeks.add(monday)
      out.push(weekPartition(monday))
    }
    if (!seenMonths.has(isoMonth)) {
      seenMonths.add(isoMonth)
      out.push(monthPartition(isoMonth))
    }
    const quarter = quarterOfMonth(isoMonth)
    if (!seenQuarters.has(quarter)) {
      seenQuarters.add(quarter)
      out.push(quarterPartition(quarter))
    }
  }
  return out
}

/**
 * Day-span [startMs, endMs] (UTC, day-aligned) covered by a partition name,
 * or `undefined` for shapes that don't carry a date range (`hourly/`, sidecar
 * keys, anything unrecognised). Tier rank: lower = finer.
 */
function partitionSpan(partition: string): { rank: number, startMs: number, endMs: number } | undefined {
  let m = partition.match(DAILY_PARTITION_RE)
  if (m) {
    const ms = Date.parse(`${m[1]!}T00:00:00Z`)
    return { rank: 0, startMs: ms, endMs: ms }
  }
  m = partition.match(WEEKLY_PARTITION_RE)
  if (m) {
    const ms = Date.parse(`${m[1]!}T00:00:00Z`)
    return { rank: 1, startMs: ms, endMs: ms + 6 * MS_PER_DAY }
  }
  m = partition.match(MONTHLY_PARTITION_RE)
  if (m) {
    const [y, mo] = m[1]!.split('-').map(Number) as [number, number]
    return { rank: 2, startMs: Date.UTC(y, mo - 1, 1), endMs: Date.UTC(y, mo, 0) }
  }
  m = partition.match(QUARTERLY_PARTITION_RE)
  if (m) {
    const y = Number(m[1])
    const q = Number(m[2])
    return { rank: 3, startMs: Date.UTC(y, (q - 1) * 3, 1), endMs: Date.UTC(y, q * 3, 0) }
  }
  return undefined
}

/**
 * Split manifest entries into the set worth reading (`kept`) and the set whose
 * every covered day is already served by a finer-or-newer live entry
 * (`subsumed`).
 *
 * Tiered compaction (daily→weekly→monthly→quarterly) is meant to retire its
 * inputs, but coarse files can outlive their finer counterparts: a D1→R2
 * backfill writes daily files that compact to monthly while a later re-sync
 * writes fresh daily/weekly for the same dates, and same-partition re-writes
 * leave a stale prior version live. All stay live, the resolver unions every
 * live tier whose partition intersects the range, and `union_by_name` sums the
 * overlap — impressions/clicks double-count.
 *
 * Entries are walked finest-tier-first, newest-first within a tier, so a
 * coarse or stale file is dropped only when every day it covers is already
 * claimed. Subsumption is evaluated per searchType — a `web` monthly never
 * cancels a `discover` weekly, they cover disjoint data. Partial
 * month-boundary overlap (a weekly straddling two months alongside a kept
 * monthly) still double-counts those boundary days — eliminating that needs
 * per-file date predicates in the SQL, tracked separately. Unrecognised
 * partition shapes (`hourly/`, sidecar keys) are always kept.
 *
 * `queryRange` clamps every entry's day-span to the window the caller will
 * actually read. This is required when `entries` came from a partition-
 * filtered `listLive` (`runSQL` enumerates only the partitions intersecting
 * the query): a `monthly/2026-04` whose Apr 27-30 falls past the query end
 * must not be judged "unsubsumed" just because `weekly/2026-04-27` wasn't
 * enumerated — those out-of-window days are SQL-filtered to nothing anyway.
 * Omit `queryRange` when `entries` is the full manifest (e.g. analysis-sources).
 */
export function splitOverlappingTiers(
  entries: ManifestEntry[],
  queryRange?: { start: string, end: string },
): { kept: ManifestEntry[], subsumed: ManifestEntry[] } {
  const rangeStartMs = queryRange ? Date.parse(`${queryRange.start}T00:00:00Z`) : undefined
  const rangeEndMs = queryRange ? Date.parse(`${queryRange.end}T00:00:00Z`) : undefined
  const spanned: { entry: ManifestEntry, rank: number, days: number[] }[] = []
  const kept: ManifestEntry[] = []
  const subsumed: ManifestEntry[] = []
  for (const entry of entries) {
    const span = partitionSpan(entry.partition)
    if (!span) {
      // Unrecognised shape (hourly/, sidecar) — never deduped.
      kept.push(entry)
      continue
    }
    const days: number[] = []
    for (let t = span.startMs; t <= span.endMs; t += MS_PER_DAY) {
      if (rangeStartMs !== undefined && (t < rangeStartMs || t > rangeEndMs!))
        continue
      days.push(t)
    }
    // Entirely outside the query window — contributes no rows, drop it.
    if (queryRange && days.length === 0) {
      subsumed.push(entry)
      continue
    }
    spanned.push({ entry, rank: span.rank, days })
  }

  // Finest tier first, then newest-first — so a coarse tier is tested against
  // already-covered days, and the newest version of a partition claims its
  // days before any stale same-partition prior version is reached.
  spanned.sort((a, b) => a.rank - b.rank || b.entry.createdAt - a.entry.createdAt)
  // Coverage tracked per searchType — different slices never cancel each other.
  const coveredBySearchType = new Map<string, Set<number>>()
  for (const { entry, days } of spanned) {
    const slice = inferSearchType(entry)
    let covered = coveredBySearchType.get(slice)
    if (!covered) {
      covered = new Set<number>()
      coveredBySearchType.set(slice, covered)
    }
    if (days.every(d => covered!.has(d))) {
      subsumed.push(entry)
      continue
    }
    kept.push(entry)
    for (const d of days)
      covered.add(d)
  }
  return { kept, subsumed }
}

/** Entries worth reading — see {@link splitOverlappingTiers}. */
export function dedupeOverlappingTiers(
  entries: ManifestEntry[],
  queryRange?: { start: string, end: string },
): ManifestEntry[] {
  return splitOverlappingTiers(entries, queryRange).kept
}

function monthEndMs(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return Date.UTC(y, m, 0, 23, 59, 59, 999)
}

function quarterEndMs(quarter: string): number {
  const [yStr, qStr] = quarter.split('-Q') as [string, string]
  const y = Number(yStr)
  const q = Number(qStr)
  // Quarter q ends at the last instant of month q*3.
  return Date.UTC(y, q * 3, 0, 23, 59, 59, 999)
}
