import type { ManifestEntry, TableName } from 'gscdump/analytics'
import type { DriverSite } from 'gscdump/driver'
import type { AnalyticsHarness } from '../analytics'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { allTables } from 'gscdump/analytics'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'
import { getDriver } from '../driver'
import { logger } from '../utils'

const DEFAULT_OUT = './gscdump-export'
const MONTH_RE = /^(\d{4}-\d{2})$/
const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2})-\d{2}$/
const MONTHLY_PARTITION_RE = /^monthly\/(\d{4}-\d{2})$/

async function resolveSiteUrl(sites: DriverSite[], target?: string): Promise<string> {
  if (target) {
    const match = sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    if (match)
      return match.siteUrl
  }
  if (sites.length === 1)
    return sites[0].siteUrl

  const selected = await select({
    message: 'Select a site',
    options: sites.map(s => ({ value: s.siteUrl, label: s.siteUrl })),
  })
  if (isCancel(selected)) {
    cancel('Cancelled')
    process.exit(0)
  }
  return selected as string
}

export const dumpCommand = defineCommand({
  meta: {
    name: 'dump',
    description: 'Export live Parquet files from the local store to a directory',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    out: {
      type: 'string',
      alias: 'o',
      default: DEFAULT_OUT,
      description: `Output directory (default: ${DEFAULT_OUT})`,
    },
    compact: {
      type: 'boolean',
      default: false,
      description: 'Compact every closed month into a single file before exporting',
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
      logger.error('dump targets the local Parquet store; cloud mode is not supported.')
      process.exit(1)
    }

    const driver = await getDriver({ interactive: false })
    const sites = await driver.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    if (sites.length === 0) {
      logger.error('No sites available')
      process.exit(1)
    }
    const siteUrl = await resolveSiteUrl(sites, String(args.site || config.defaultSite || ''))

    const harness = createAnalyticsHarness(config)
    const outDir = path.resolve(String(args.out))

    if (args.compact) {
      await compactClosedMonths(harness, siteUrl, args.quiet)
    }

    const entries = await listLiveEntries(harness, siteUrl)
    if (entries.length === 0) {
      logger.warn(`No data for ${siteUrl}. Run \`gscdump sync\` first.`)
      process.exit(0)
    }

    await fs.mkdir(outDir, { recursive: true })
    let copied = 0
    for (const entry of entries) {
      const bytes = await harness.dataSource.read(entry.objectKey)
      const target = path.join(outDir, entry.objectKey)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, Buffer.from(bytes))
      copied++
    }

    if (!args.quiet) {
      logger.success(`Exported ${copied} file(s) to ${outDir}`)
    }
  },
})

async function listLiveEntries(harness: AnalyticsHarness, siteUrl: string): Promise<ManifestEntry[]> {
  const siteId = harness.siteIdFor(siteUrl)
  const perTable = await Promise.all(
    allTables().map(table => harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    })),
  )
  return perTable.flat()
}

async function compactClosedMonths(harness: AnalyticsHarness, siteUrl: string, quiet: unknown): Promise<void> {
  const siteId = harness.siteIdFor(siteUrl)
  const closedMonths = new Map<string, Set<TableName>>()
  const now = Date.now()
  const thirtyFiveDaysMs = 35 * 86_400_000

  for (const table of allTables()) {
    const entries = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    })
    for (const e of entries) {
      const month = monthFromPartition(e.partition)
      if (!month)
        continue
      const monthEndMs = Date.parse(`${month}-28T23:59:59Z`) + 4 * 86_400_000
      if (now - monthEndMs < thirtyFiveDaysMs)
        continue
      if (!closedMonths.has(month))
        closedMonths.set(month, new Set())
      closedMonths.get(month)!.add(table as TableName)
    }
  }

  for (const [month, tables] of closedMonths) {
    for (const table of tables) {
      if (!quiet)
        logger.info(`Compacting ${table} ${month}`)
      await harness.engine.compactMonth({
        userId: harness.userId,
        siteId,
        table,
      }, month)
    }
  }
}

function monthFromPartition(partition: string): string | null {
  const daily = partition.match(DAILY_PARTITION_RE)
  if (daily)
    return daily[1]
  const monthly = partition.match(MONTHLY_PARTITION_RE)
  if (monthly)
    return monthly[1]
  const any = partition.match(MONTH_RE)
  return any ? any[1] : null
}
