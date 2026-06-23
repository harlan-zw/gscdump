import type { SearchType } from 'gscdump/query'
import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { DuckDBInstance } from '@duckdb/node-api'
import { dateColumnsFor } from '@gscdump/engine/schema'
import { sqlEscape } from '@gscdump/engine/sql'
import { dateReplaceClause } from '@gscdump/engine/sql-fragments'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { ALL_SEARCH_TYPES, applyOutputMode, displayPath, logger, OUTPUT_ARGS, parseSearchType, toCSV } from '../utils'

const DEFAULT_OUT = './gscdump-export'
const FORMATS = ['parquet', 'json', 'ndjson', 'csv'] as const
type DumpFormat = typeof FORMATS[number]

export const dumpCommand = defineCommand({
  meta: {
    name: 'dump',
    description: 'Export live Parquet files from the local store to a directory',
  },
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com); ignored with --all-sites',
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
    const ctx = await createCommandContext({ needsAuth: !args['all-sites'], needsStore: true })
    const store = ctx.store!
    const outDir = path.resolve(String(args.out))

    const targets: string[] = args['all-sites']
      ? await listSitesWithData(store)
      : [await ctx.resolveSite(args.site ? String(args.site) : undefined)]
    if (targets.length === 0) {
      logger.warn('No sites with local data. Run `gscdump sync` first.')
      process.exit(0)
    }

    if (args.compact) {
      for (const siteUrl of targets)
        await compactClosedMonths(store, siteUrl, quiet)
    }

    const summary: Array<{ site: string, files: number, rows: number, format: DumpFormat, outPath: string }> = []
    for (const siteUrl of targets) {
      const entries = (await listLiveEntries(store, siteUrl, searchType))
        .filter(e => !tablesFilter || tablesFilter.has(e.table))
      if (entries.length === 0) {
        if (!quiet)
          logger.warn(`No data for ${siteUrl}; skipping`)
        continue
      }
      if (format === 'parquet') {
        const written = await dumpParquet(store, entries, outDir)
        summary.push({ site: siteUrl, files: written, rows: 0, format, outPath: outDir })
      }
      else {
        const written = await dumpRowFormat(store, entries, outDir, siteUrl, format)
        summary.push({ site: siteUrl, files: written.files, rows: written.rows, format, outPath: outDir })
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

async function listSitesWithData(store: LocalStore): Promise<string[]> {
  const siteIds = new Set<string>()
  for (const table of allTables()) {
    const entries = await store.engine.listLive({ userId: store.userId, table: table as TableName })
    for (const e of entries) {
      if (e.siteId)
        siteIds.add(e.siteId)
    }
  }
  return Array.from(siteIds)
}

async function listLiveEntries(store: LocalStore, siteUrl: string, searchType?: SearchType): Promise<ManifestEntry[]> {
  const siteId = store.siteIdFor(siteUrl)
  const perTable = await Promise.all(
    allTables().map(table => store.engine.listLive({
      userId: store.userId,
      siteId,
      table: table as TableName,
      ...(searchType !== undefined ? { searchType } : {}),
    })),
  )
  return perTable.flat()
}

async function dumpParquet(store: LocalStore, entries: ManifestEntry[], outDir: string): Promise<number> {
  await fs.mkdir(outDir, { recursive: true })
  let copied = 0
  for (const entry of entries) {
    const bytes = await store.engine.readObject(entry.objectKey)
    const target = path.join(outDir, entry.objectKey)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from(bytes))
    copied++
  }
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
    const rows = await readTableRows(filePaths, table)
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

async function readTableRows(filePaths: string[], table: TableName): Promise<Record<string, unknown>[]> {
  // Native `@duckdb/node-api` (not the engine vFS handle) for a one-shot bulk
  // read of on-disk partitions at native speed. Read semantics that must match
  // the engine — e.g. the date canonicalization below — go through the shared
  // sql-fragments helper. See docs/adr/0016-duckdb-two-node-runtimes-by-design.md.
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  try {
    const fileList = filePaths.map(p => `'${sqlEscape(p)}'`).join(', ')
    // Canonicalize legacy VARCHAR `date` columns to ISO strings, matching the
    // engine codec's read path — without it `dump --format json|csv|ndjson`
    // emits a different date shape than every other read of the same parquet.
    const replace = dateReplaceClause(dateColumnsFor(table), 'string')
    const reader = await conn.runAndReadAll(`SELECT * ${replace} FROM read_parquet([${fileList}], union_by_name=true)`)
    return reader.getRowObjects() as Record<string, unknown>[]
  }
  finally {
    conn.closeSync()
    instance.closeSync()
  }
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
