import type { ManifestEntry, TableName } from 'gscdump/analytics/contracts'
import type { AnalyticsHarness } from '../analytics'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { allTables } from 'gscdump/analytics/schema'
import { createAnalyticsHarness } from '../analytics'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
import { logger } from '../utils'

interface GscSite {
  siteUrl: string
  permissionLevel: string
}

const DEFAULT_OUT = './gscdump-export'

async function resolveSiteUrl(sites: GscSite[], target?: string): Promise<string> {
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
    const auth = await getAuth({ interactive: false, config })
    const client = googleSearchConsole(auth)
    const gscSites = await client.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    const sites: GscSite[] = gscSites
      .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
      .map(s => ({ siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel || 'unknown' }))
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
      const bytes = await harness.engine.readObject(entry.objectKey)
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
    allTables().map(table => harness.engine.listLive({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    })),
  )
  return perTable.flat()
}

async function compactClosedMonths(harness: AnalyticsHarness, siteUrl: string, quiet: unknown): Promise<void> {
  const siteId = harness.siteIdFor(siteUrl)
  for (const table of allTables()) {
    if (!quiet)
      logger.info(`Compacting ${table} older than 35d`)
    await harness.engine.compactOlderThan({
      userId: harness.userId,
      siteId,
      table: table as TableName,
    }, 35)
  }
}
