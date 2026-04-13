import type { ManifestEntry, TableName } from 'gscdump/analytics'
import type { AnalyticsHarness } from '../analytics'
import process from 'node:process'
import { defineCommand } from 'citty'
import { allTables, dayPartition } from 'gscdump/analytics'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'
import { logger } from '../utils'

const MONTH_RE = /^\d{4}-\d{2}$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAILY_PREFIX_RE = /^daily\//
const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2})-\d{2}$/
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/
const THIRTY_FIVE_DAYS_MS = 35 * 86_400_000

export const compactCommand = defineCommand({
  meta: {
    name: 'compact',
    description: 'Compact shards into fewer files (per day or per month)',
  },
  args: {
    day: {
      type: 'string',
      description: 'Compact a specific day (YYYY-MM-DD) across every table',
    },
    month: {
      type: 'string',
      description: 'Compact a specific month (YYYY-MM) across every table',
    },
    site: {
      type: 'string',
      alias: 's',
      description: 'Restrict to a single site (default: all sites with local data)',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    if (config.mode === 'cloud') {
      logger.error('compact operates on the local Parquet store; cloud mode is not supported.')
      process.exit(1)
    }

    const harness = createAnalyticsHarness(config)
    const sitePrefix = args.site ? harness.siteIdFor(String(args.site)) : undefined
    const quiet = Boolean(args.quiet)

    if (args.day) {
      if (!DAY_RE.test(String(args.day))) {
        logger.error('--day must be YYYY-MM-DD')
        process.exit(1)
      }
      await compactDay(harness, String(args.day), sitePrefix, quiet)
      return
    }

    if (args.month) {
      if (!MONTH_RE.test(String(args.month))) {
        logger.error('--month must be YYYY-MM')
        process.exit(1)
      }
      await compactMonth(harness, String(args.month), sitePrefix, quiet)
      return
    }

    await autoCompact(harness, sitePrefix, quiet)
  },
})

async function compactDay(
  harness: AnalyticsHarness,
  day: string,
  siteId: string | undefined,
  quiet: boolean,
): Promise<void> {
  const partition = dayPartition(day)
  let compacted = 0
  for (const table of allTables()) {
    const entries = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
      partitions: [partition],
    })
    const bySite = groupBySite(entries)
    for (const [targetSite, shards] of bySite) {
      if (shards.length < 2)
        continue
      if (!quiet)
        logger.info(`Compacting ${table} ${day} (${shards.length} shards) [${targetSite ?? '-'}]`)
      await harness.engine.compactDay({
        userId: harness.userId,
        siteId: targetSite,
        table: table as TableName,
        date: day,
      }, shards)
      compacted++
    }
  }
  if (!quiet)
    logger.success(`compactDay: ${compacted} partition(s) merged`)
}

async function compactMonth(
  harness: AnalyticsHarness,
  month: string,
  siteId: string | undefined,
  quiet: boolean,
): Promise<void> {
  let compacted = 0
  for (const table of allTables()) {
    const candidates = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    })
    const sitesInMonth = new Set<string | undefined>()
    for (const e of candidates) {
      if (!partitionInMonth(e.partition, month))
        continue
      sitesInMonth.add(e.siteId)
    }
    for (const targetSite of sitesInMonth) {
      if (!quiet)
        logger.info(`Compacting ${table} ${month} [${targetSite ?? '-'}]`)
      await harness.engine.compactMonth({
        userId: harness.userId,
        siteId: targetSite,
        table: table as TableName,
      }, month)
      compacted++
    }
  }
  if (!quiet)
    logger.success(`compactMonth: ${compacted} (site × table) merged`)
}

async function autoCompact(
  harness: AnalyticsHarness,
  siteId: string | undefined,
  quiet: boolean,
): Promise<void> {
  const now = Date.now()
  let dayMerges = 0
  let monthMerges = 0

  for (const table of allTables()) {
    const entries = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    })
    const shardedDays = groupByPartition(entries.filter(e => e.partition.startsWith('daily/')))
    for (const [partition, shards] of shardedDays) {
      if (shards.length < 2)
        continue
      const day = partition.replace(DAILY_PREFIX_RE, '')
      const bySite = groupBySite(shards)
      for (const [targetSite, siteShards] of bySite) {
        if (siteShards.length < 2)
          continue
        if (!quiet)
          logger.info(`Auto-compacting ${table} ${day} (${siteShards.length} shards)`)
        await harness.engine.compactDay({
          userId: harness.userId,
          siteId: targetSite,
          table: table as TableName,
          date: day,
        }, siteShards)
        dayMerges++
      }
    }

    const monthsToMerge = new Map<string, Set<string | undefined>>()
    for (const entry of entries) {
      const month = monthFromPartition(entry.partition)
      if (!month)
        continue
      const monthEnd = monthEndMs(month)
      if (now - monthEnd < THIRTY_FIVE_DAYS_MS)
        continue
      if (!monthsToMerge.has(month))
        monthsToMerge.set(month, new Set())
      monthsToMerge.get(month)!.add(entry.siteId)
    }
    for (const [month, siteSet] of monthsToMerge) {
      for (const targetSite of siteSet) {
        if (!quiet)
          logger.info(`Auto-compacting ${table} ${month}`)
        await harness.engine.compactMonth({
          userId: harness.userId,
          siteId: targetSite,
          table: table as TableName,
        }, month)
        monthMerges++
      }
    }
  }

  if (!quiet)
    logger.success(`auto: ${dayMerges} day merges, ${monthMerges} month merges`)
}

function groupBySite(entries: ManifestEntry[]): Map<string | undefined, ManifestEntry[]> {
  const out = new Map<string | undefined, ManifestEntry[]>()
  for (const e of entries) {
    const list = out.get(e.siteId) ?? []
    list.push(e)
    out.set(e.siteId, list)
  }
  return out
}

function groupByPartition(entries: ManifestEntry[]): Map<string, ManifestEntry[]> {
  const out = new Map<string, ManifestEntry[]>()
  for (const e of entries) {
    const list = out.get(e.partition) ?? []
    list.push(e)
    out.set(e.partition, list)
  }
  return out
}

function partitionInMonth(partition: string, month: string): boolean {
  const m = monthFromPartition(partition)
  return m === month
}

function monthFromPartition(partition: string): string | null {
  const daily = partition.match(DAILY_PARTITION_RE)
  if (daily)
    return daily[1]
  const monthly = partition.match(MONTHLY_PARTITION_RE)
  if (monthly)
    return monthly[1]
  return null
}

function monthEndMs(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return Date.UTC(y, m, 0, 23, 59, 59)
}
