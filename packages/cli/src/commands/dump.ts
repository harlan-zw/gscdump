import type { SearchType } from 'gscdump/query'
import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dumpCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { readParquetRows } from '../native-duckdb'
import { readSiteMap, siteUrlForId } from '../store-sites'
import { ALL_SEARCH_TYPES, applyOutputMode, displayPath, logger, OUTPUT_ARGS, parseSearchType, runWithConcurrency, toCSV } from '../utils'

const DEFAULT_OUT = './gscdump-export'
const FORMATS = ['parquet', 'json', 'ndjson', 'csv'] as const
type DumpFormat = typeof FORMATS[number]

export const dumpCommand = defineCommand({
  meta: dumpCommandMeta,
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site, for example example.com; ignored with --all-sites',
    },
    'out': {
      type: 'string',
      alias: 'o',
      default: DEFAULT_OUT,
      description: `Output directory (default: ${DEFAULT_OUT})`,
    },
    'format': {
      type: 'string',
      alias: 'F',
      default: 'parquet',
      description: `Output format: ${FORMATS.join(', ')} (default: parquet copies raw files)`,
    },
    'tables': {
      type: 'string',
      alias: 't',
      description: `Comma-separated table list (default: all). Known: ${allTables().join(', ')}`,
    },
    'all-sites': {
      type: 'boolean',
      default: false,
      description: 'Iterate every site with local data',
    },
    'compact': {
      type: 'boolean',
      default: false,
      description: 'Compact every closed month into a single file before exporting',
    },
    'search-type': {
      type: 'string',
      description: `Restrict dump to a single GSC search-type slice (${ALL_SEARCH_TYPES.join(', ')}). Default: all slices.`,
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json, quiet } = applyOutputMode(args)
    const format = String(args.format) as DumpFormat
    if (!(FORMATS as readonly string[]).includes(format)) {
      logger.error(`Invalid --format: ${format}. Allowed: ${FORMATS.join(', ')}`)
      process.exit(1)
    }
    const tablesFilter = args.tables
      ? new Set(String(args.tables).split(',').map(t => t.trim()).filter(Boolean))
      : null
    const searchType = parseSearchType(args['search-type'])
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const outDir = path.resolve(String(args.out))
    const siteMap = await readSiteMap(store.dataDir, store.userId)

    let preloadedEntries = args['all-sites']
      ? await store.engine.listLive({
          userId: store.userId,
          ...(searchType !== undefined ? { searchType } : {}),
        })
      : undefined
    const targets: Array<{ site: string, siteId: string }> = args['all-sites']
      ? [...new Set(preloadedEntries!.flatMap(entry => entry.siteId ? [entry.siteId] : []))]
          .map(siteId => ({ site: siteUrlForId(siteMap, siteId), siteId }))
      : await ctx.resolveSite(args.site ? String(args.site) : undefined, { scope: 'store' })
          .then(site => [{ site, siteId: store.siteIdFor(site) }])
    if (targets.length === 0) {
      logger.warn('No sites with local data. Run `gscdump sync` first.')
      process.exit(0)
    }

    if (args.compact) {
      for (const target of targets)
        await compactClosedMonths(store, target.siteId, quiet)
      // Compaction retires the keys in the discovery snapshot and registers
      // replacements, so refresh once before exporting every site.
      if (preloadedEntries) {
        preloadedEntries = await store.engine.listLive({
          userId: store.userId,
          ...(searchType !== undefined ? { searchType } : {}),
        })
      }
    }

    const summary: Array<{ site: string, files: number, rows: number, format: DumpFormat, outPath: string }> = []
    for (const target of targets) {
      const entries = (preloadedEntries
        ? preloadedEntries.filter(entry => entry.siteId === target.siteId)
        : await listLiveEntries(store, target.siteId, searchType))
        .filter(e => !tablesFilter || tablesFilter.has(e.table))
      if (entries.length === 0) {
        if (!quiet)
          logger.warn(`No data for ${target.site}; skipping`)
        continue
      }
      if (format === 'parquet') {
        const written = await dumpParquet(store, entries, outDir)
        summary.push({ site: target.site, files: written, rows: 0, format, outPath: outDir })
      }
      else {
        const written = await dumpRowFormat(store, entries, outDir, target.site, format)
        summary.push({ site: target.site, files: written.files, rows: written.rows, format, outPath: outDir })
      }
    }

    if (json) {
      console.log(JSON.stringify({ outDir, sites: summary }, null, 2))
      return
    }
    for (const s of summary) {
      const rows = s.rows ? `, ${s.rows.toLocaleString()} rows` : ''
      logger.success(`[${s.site}] ${s.files} ${s.format} file(s)${rows} → ${displayPath(s.outPath)}`)
    }
  },
})

async function listLiveEntries(store: LocalStore, siteId: string, searchType?: SearchType): Promise<ManifestEntry[]> {
  return store.engine.listLive({
    userId: store.userId,
    siteId,
    ...(searchType !== undefined ? { searchType } : {}),
  })
}

async function dumpParquet(store: LocalStore, entries: ManifestEntry[], outDir: string): Promise<number> {
  await fs.mkdir(outDir, { recursive: true })
  const readyDirectories = new Map<string, Promise<void>>()
  async function ensureDirectory(dir: string): Promise<void> {
    let ready = readyDirectories.get(dir)
    if (!ready) {
      ready = fs.mkdir(dir, { recursive: true }).then(() => undefined)
      readyDirectories.set(dir, ready)
      ready.catch(() => readyDirectories.delete(dir))
    }
    await ready
  }
  let copied = 0
  await runWithConcurrency(entries, 8, async (entry) => {
    const bytes = await store.engine.readObject(entry.objectKey)
    const target = path.join(outDir, entry.objectKey)
    await ensureDirectory(path.dirname(target))
    await fs.writeFile(target, bytes)
    copied++
  })
  return copied
}

// Read parquet rows back through DuckDB and re-emit per table in the chosen
// row format. Each table becomes one file under <outDir>/<site>/<table>.<ext>.
async function dumpRowFormat(
  store: LocalStore,
  entries: ManifestEntry[],
  outDir: string,
  siteUrl: string,
  format: 'json' | 'ndjson' | 'csv',
): Promise<{ files: number, rows: number }> {
  const byTable = new Map<TableName, ManifestEntry[]>()
  for (const e of entries) {
    const arr = byTable.get(e.table as TableName) ?? []
    arr.push(e)
    byTable.set(e.table as TableName, arr)
  }
  const safeSite = siteUrl.replace(/[^a-z0-9]+/gi, '_')
  const siteDir = path.join(outDir, safeSite)
  await fs.mkdir(siteDir, { recursive: true })

  let files = 0
  let totalRows = 0
  for (const [table, tableEntries] of byTable) {
    const filePaths = tableEntries.map(e => path.join(store.dataDir, e.objectKey))
    const rows = await readParquetRows(filePaths, table)
    const ext = format === 'csv' ? 'csv' : format === 'ndjson' ? 'ndjson' : 'json'
    const target = path.join(siteDir, `${table}.${ext}`)
    let body: string
    if (format === 'json')
      body = JSON.stringify(rows, null, 2)
    else if (format === 'ndjson')
      body = rows.map(r => JSON.stringify(r)).join('\n')
    else
      body = rows.length > 0 ? toCSV(rows, Object.keys(rows[0])) : ''
    await fs.writeFile(target, body)
    files++
    totalRows += rows.length
  }
  return { files, rows: totalRows }
}

async function compactClosedMonths(store: LocalStore, siteId: string, quiet: unknown): Promise<void> {
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
