import type {
  CompactionTier,
  DataSource,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  WriteCtx,
} from './storage'
import { MS_PER_DAY } from 'gscdump'
import { currentSchemaVersion } from './schema'
import {
  dayPartition,
  inferSearchType,
  mondayOfWeek,
  monthPartition,
  objectKey,
  quarterOfMonth,
  quarterPartition,
  weekPartition,
} from './storage'

const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2}-\d{2})$/
const WEEKLY_PARTITION_RE = /^weekly\/(\d{4}-\d{2}-\d{2})$/
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/

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
