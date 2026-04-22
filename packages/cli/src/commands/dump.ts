import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { logger } from '../utils'

const DEFAULT_OUT = './gscdump-export'

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
    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const store = ctx.store!
    const outDir = path.resolve(String(args.out))

    if (args.compact) {
      await compactClosedMonths(store, siteUrl, args.quiet)
    }

    const entries = await listLiveEntries(store, siteUrl)
    if (entries.length === 0) {
      logger.warn(`No data for ${siteUrl}. Run \`gscdump sync\` first.`)
      process.exit(0)
    }

    await fs.mkdir(outDir, { recursive: true })
    let copied = 0
    for (const entry of entries) {
      const bytes = await store.engine.readObject(entry.objectKey)
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

async function listLiveEntries(store: LocalStore, siteUrl: string): Promise<ManifestEntry[]> {
  const siteId = store.siteIdFor(siteUrl)
  const perTable = await Promise.all(
    allTables().map(table => store.engine.listLive({
      userId: store.userId,
      siteId,
      table: table as TableName,
    })),
  )
  return perTable.flat()
}

async function compactClosedMonths(store: LocalStore, siteUrl: string, quiet: unknown): Promise<void> {
  const siteId = store.siteIdFor(siteUrl)
  for (const table of allTables()) {
    if (!quiet)
      logger.info(`Compacting ${table} (raw→d7→d30→d90)`)
    await store.engine.compactTiered({
      userId: store.userId,
      siteId,
      table: table as TableName,
    })
  }
}
