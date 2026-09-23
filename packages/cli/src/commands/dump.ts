import type { SearchType } from 'gscdump/query'
import type { EntityDataset, EntityDatasetRows } from '../local-entities'
import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { defineCommand } from 'citty'
import { dumpCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { ENTITY_DATASETS, readEntityDatasets } from '../local-entities'
import { allTables } from '../local-store'
import { readParquetRows } from '../native-duckdb'
import { ALL_SEARCH_TYPES, applyOutputMode, displayPath, logger, OUTPUT_ARGS, parseSearchType, runWithConcurrency, toCSV } from '../utils'

const DEFAULT_OUT = './gscdump-export'
const FORMATS = ['parquet', 'json', 'ndjson', 'csv'] as const

export const dumpCommand = defineCommand({
  meta: dumpCommandMeta,
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
      description: `Comma-separated tables and entity datasets (default: all). Known: ${[...allTables(), ...ENTITY_DATASETS].join(', ')}`,
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

    let preloadedEntries = args['all-sites']
      ? await store.engine.listLive({
          userId: store.userId,
          ...(searchType !== undefined ? { searchType } : {}),
        })
      : undefined
    const targets: Array<{ site: string, siteId: string }> = args['all-sites']
      ? [...new Set(preloadedEntries!.flatMap(entry => entry.siteId ? [entry.siteId] : []))]
          .map(siteId => ({ site: siteId, siteId }))
      : await ctx.resolveSite(args.site ? String(args.site) : undefined)
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

    const summary = await dumpSites({
      store,
      targets,
      outDir,
      format,
      ...(tablesFilter ? { tables: tablesFilter } : {}),
      ...(searchType !== undefined ? { searchType } : {}),
      ...(preloadedEntries ? { entries: preloadedEntries } : {}),
    })

    if (json) {
      console.log(JSON.stringify({ outDir, sites: summary }, null, 2))
      return
    }
    for (const site of summary) {
      if (site.files.length === 0) {
        if (!quiet)
          logger.warn(`No data for ${site.site}; skipping`)
        continue
      }
      logger.success(`[${site.site}] ${site.totals.files} ${site.format} file(s), ${site.totals.rows.toLocaleString()} rows, ${formatBytes(site.totals.bytes)} → ${displayPath(site.outPath)}`)
      if (quiet)
        continue
      for (const file of site.files)
        console.log(`  ${path.relative(outDir, file.path)}  ${formatBytes(file.bytes)}  ${file.rows.toLocaleString()} rows`)
      for (const skip of site.skipped)
        console.log(`  \x1B[90m${skip.dataset}: no rows yet; skipped\x1B[0m`)
    }
  },
})

export type DumpFormat = typeof FORMATS[number]

export interface DumpFile {
  /** Analytics table or entity dataset name. */
  dataset: string
  /** Absolute path of the written file. */
  path: string
  bytes: number
  rows: number
}

export interface SiteDumpSummary {
  site: string
  format: DumpFormat
  outPath: string
  files: DumpFile[]
  /** Datasets with no rows. They get no file. */
  skipped: Array<{ dataset: EntityDataset, reason: 'empty' }>
  totals: { files: number, bytes: number, rows: number }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/**
 * Write every requested analytics table and entity dataset for each site.
 * `tables` limits the datasets by name; omit it for all of them. `entries`
 * reuses a manifest listing the caller already holds.
 */
export async function dumpSites(opts: {
  store: LocalStore
  targets: ReadonlyArray<{ site: string, siteId: string }>
  outDir: string
  format: DumpFormat
  tables?: ReadonlySet<string>
  searchType?: SearchType
  entries?: readonly ManifestEntry[]
}): Promise<SiteDumpSummary[]> {
  const { store, outDir, format, tables } = opts
  const wantedEntities = ENTITY_DATASETS.filter(dataset => !tables || tables.has(dataset))
  const summary: SiteDumpSummary[] = []
  for (const target of opts.targets) {
    const entries = (opts.entries
      ? opts.entries.filter(entry => entry.siteId === target.siteId)
      : await listLiveEntries(store, target.siteId, opts.searchType))
      .filter(e => !tables || tables.has(e.table))
    const files: DumpFile[] = entries.length === 0
      ? []
      : format === 'parquet'
        ? await dumpParquet(store, entries, outDir)
        : await dumpRowFormat(store, entries, outDir, target.site, format)

    const skipped: SiteDumpSummary['skipped'] = []
    const datasets = await readEntityDatasets(store.dataSource, { userId: store.userId, siteId: target.siteId }, wantedEntities)
    for (const dataset of datasets) {
      if (dataset.rows.length === 0) {
        skipped.push({ dataset: dataset.dataset, reason: 'empty' })
        continue
      }
      files.push(format === 'parquet'
        ? await writeEntityParquet(outDir, `u_${store.userId}/${target.siteId}`, dataset)
        : await writeRows(path.join(outDir, safeSiteDir(target.site)), dataset.dataset, dataset.rows, format))
    }

    summary.push({
      site: target.site,
      format,
      outPath: outDir,
      files,
      skipped,
      totals: {
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        rows: files.reduce((sum, file) => sum + file.rows, 0),
      },
    })
  }
  return summary
}

function safeSiteDir(siteUrl: string): string {
  return siteUrl.replace(/[^a-z0-9]+/gi, '_')
}

// Entity datasets sit beside the analytics tables: <site>/<dataset>/<dataset>.parquet.
async function writeEntityParquet(outDir: string, sitePrefix: string, dataset: EntityDatasetRows): Promise<DumpFile> {
  const target = path.join(outDir, sitePrefix, dataset.dataset, `${dataset.dataset}.parquet`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const bytes = encodeRowsToParquetFlex(dataset.rows, { columns: dataset.columns })
  await fs.writeFile(target, bytes)
  return { dataset: dataset.dataset, path: target, bytes: bytes.byteLength, rows: dataset.rows.length }
}

async function writeRows(
  siteDir: string,
  dataset: string,
  rows: Record<string, unknown>[],
  format: 'json' | 'ndjson' | 'csv',
): Promise<DumpFile> {
  await fs.mkdir(siteDir, { recursive: true })
  const target = path.join(siteDir, `${dataset}.${format}`)
  let body: string
  if (format === 'json')
    body = JSON.stringify(rows, bigintSafe, 2)
  else if (format === 'ndjson')
    body = rows.map(r => JSON.stringify(r, bigintSafe)).join('\n')
  else
    body = rows.length > 0 ? toCSV(rows, Object.keys(rows[0]!)) : ''
  await fs.writeFile(target, body)
  return { dataset, path: target, bytes: Buffer.byteLength(body), rows: rows.length }
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

async function listLiveEntries(store: LocalStore, siteId: string, searchType?: SearchType): Promise<ManifestEntry[]> {
  return store.engine.listLive({
    userId: store.userId,
    siteId,
    ...(searchType !== undefined ? { searchType } : {}),
  })
}

async function dumpParquet(store: LocalStore, entries: ManifestEntry[], outDir: string): Promise<DumpFile[]> {
  await fs.mkdir(outDir, { recursive: true })
  const readyDirectories = new Map<string, Promise<void>>()
  async function ensureDirectory(dir: string): Promise<void> {
    let ready = readyDirectories.get(dir)
    if (!ready) {
      ready = fs.mkdir(dir, { recursive: true }).then(() => undefined)
      readyDirectories.set(dir, ready)
      // A failed mkdir is retried by the next caller; this caller still sees the rejection.
      ready.catch(() => readyDirectories.delete(dir))
    }
    await ready
  }
  const files: DumpFile[] = []
  await runWithConcurrency(entries, 8, async (entry) => {
    const bytes = await store.engine.readObject(entry.objectKey)
    const target = path.join(outDir, entry.objectKey)
    await ensureDirectory(path.dirname(target))
    await fs.writeFile(target, bytes)
    files.push({ dataset: entry.table, path: target, bytes: bytes.byteLength, rows: entry.rowCount })
  })
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// Read parquet rows back through DuckDB and re-emit per table in the chosen
// row format. Each table becomes one file under <outDir>/<site>/<table>.<ext>.
async function dumpRowFormat(
  store: LocalStore,
  entries: ManifestEntry[],
  outDir: string,
  siteUrl: string,
  format: 'json' | 'ndjson' | 'csv',
): Promise<DumpFile[]> {
  const byTable = new Map<TableName, ManifestEntry[]>()
  for (const e of entries) {
    const arr = byTable.get(e.table as TableName) ?? []
    arr.push(e)
    byTable.set(e.table as TableName, arr)
  }
  const siteDir = path.join(outDir, safeSiteDir(siteUrl))
  const files: DumpFile[] = []
  for (const [table, tableEntries] of byTable) {
    const filePaths = tableEntries.map(e => path.join(store.dataDir, e.objectKey))
    const rows = await readParquetRows(filePaths, table)
    files.push(await writeRows(siteDir, table, rows, format))
  }
  return files
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
