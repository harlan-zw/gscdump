import type { SearchType } from 'gscdump/query'
import type { BingDumpStep } from '../dump-bing'
import type { EntityDataset, EntityDatasetRows } from '../local-entities'
import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { defineCommand } from 'citty'
import { getDateRange } from 'gscdump/dates'
import { decodeSiteId } from 'gscdump/tenant'
import { dumpCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { dumpBing } from '../dump-bing'
import { ENTITY_DATASETS, readEntityDatasets } from '../local-entities'
import { allTables } from '../local-store'
import { readParquetRows } from '../native-duckdb'
import { ALL_SEARCH_TYPES, applyOutputMode, displayPath, logger, OUTPUT_ARGS, parseNameList, parseSearchType, runWithConcurrency, toCSV } from '../utils'

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
      description: `Comma-separated tables and datasets (default: all). Known: ${[...allTables(), ...ENTITY_DATASETS, 'bing'].join(', ')}`,
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
    'bing': {
      type: 'boolean',
      default: true,
      description: 'Also export Bing data for matching sites when a Bing login exists',
      negativeDescription: 'Skip Bing',
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
      ? new Set<string>(parseNameList(args.tables, [...allTables(), ...ENTITY_DATASETS, 'bing'], '--tables'))
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
          .map(siteId => ({ site: decodeSiteId(siteId), siteId }))
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

    const siteList = ctx.client
      ? await ctx.loadSites().then(sites => sites.map(site => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel })))
      : undefined
    const bing: BingDumpStep = args.bing === false || (tablesFilter && !tablesFilter.has('bing'))
      ? { _tag: 'disabled' }
      : await dumpBing({
          googleSites: args['all-sites'] ? 'all' : targets.map(target => target.site),
          outDir,
          format,
        }).catch((error: unknown) => ({ _tag: 'failed' as const, reason: error instanceof Error ? error.message : String(error) }))
    const result = await dumpSites({
      store,
      targets,
      outDir,
      format,
      ...(tablesFilter ? { tables: tablesFilter } : {}),
      ...(searchType !== undefined ? { searchType } : {}),
      ...(preloadedEntries ? { entries: preloadedEntries } : {}),
      ...(siteList ? { siteList } : {}),
      bing,
    })

    if (json) {
      console.log(JSON.stringify({ ...result, bing }, null, 2))
      return
    }
    for (const site of result.sites) {
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
      const gaps = site.coverage.filter(entry => entry.missingDates.length > 0 || entry.failedDates.length > 0)
      for (const gap of gaps)
        logger.warn(`  ${gap.table}${gap.searchType === 'web' ? '' : `/${gap.searchType}`}: ${gap.missingDates.length} missing and ${gap.failedDates.length} failed date(s); see manifest.json`)
    }
    if (bing._tag === 'dumped') {
      for (const site of bing.sites) {
        const bytes = site.files.reduce((sum, file) => sum + file.bytes, 0)
        logger.success(`[Bing ${site.siteUrl}] ${site.files.length} file(s), ${formatBytes(bytes)}`)
        if (!quiet) {
          for (const file of site.files)
            console.log(`  ${path.relative(outDir, file.path)}  ${formatBytes(file.bytes)}  ${file.rows.toLocaleString()} rows`)
        }
      }
      for (const failure of bing.failures)
        logger.warn(`Bing ${failure.siteUrl} not exported: ${failure.error}`)
    }
    else if (bing._tag === 'failed') {
      logger.warn(`Bing not exported: ${bing.reason}`)
    }
    else if (bing._tag === 'skipped' && !quiet) {
      logger.info(`Bing skipped: ${bing.reason}`)
    }
    if (!quiet) {
      for (const file of result.metadataFiles)
        console.log(`  ${path.relative(outDir, file.path)}  ${formatBytes(file.bytes)}`)
    }
  },
})

export type DumpFormat = typeof FORMATS[number]

export interface DumpFile {
  /** Analytics table or entity dataset name. */
  dataset: string
  /** Search type of an analytics table file. Entity datasets have none. */
  searchType?: SearchType
  /** Absolute path of the written file. */
  path: string
  bytes: number
  rows: number
}

export interface CoverageEntry {
  table: TableName
  searchType: SearchType
  oldestDate: string | null
  newestDate: string | null
  lastSyncAt: string | null
  /** Dates inside the synced range with no completed sync. */
  missingDates: string[]
  failedDates: Array<{ date: string, error: string | null }>
}

export interface SiteDumpSummary {
  site: string
  siteId: string
  format: DumpFormat
  outPath: string
  files: DumpFile[]
  /** Datasets with no rows. They get no file. */
  skipped: Array<{ dataset: EntityDataset, reason: 'empty' }>
  totals: { files: number, bytes: number, rows: number }
  /** What the Store holds for each table and search type, including its gaps. */
  coverage: CoverageEntry[]
}

export interface DumpResult {
  outDir: string
  sites: SiteDumpSummary[]
  /** Files that describe the whole dump: `manifest.json`, and `sites.json` when the site list was known. */
  metadataFiles: Array<{ path: string, bytes: number }>
}

export interface SiteListing {
  siteUrl: string
  permissionLevel: string | null
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
  /** Search Console sites and permission levels, written to `sites.json`. */
  siteList?: readonly SiteListing[]
  /** Outcome of the Bing step, listed in `manifest.json`. */
  bing?: BingDumpStep
}): Promise<DumpResult> {
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
      siteId: target.siteId,
      coverage: await readCoverage(store, target.siteId),
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
  await fs.mkdir(outDir, { recursive: true })
  const metadataFiles: DumpResult['metadataFiles'] = []
  if (opts.siteList)
    metadataFiles.push(await writeJsonFile(path.join(outDir, 'sites.json'), { sites: opts.siteList }))
  metadataFiles.push(await writeJsonFile(path.join(outDir, 'manifest.json'), {
    generatedAt: new Date().toISOString(),
    format,
    sites: summary.map(site => ({
      site: site.site,
      siteId: site.siteId,
      totals: site.totals,
      files: site.files.map(file => ({ ...file, path: path.relative(outDir, file.path) })),
      skipped: site.skipped,
      coverage: site.coverage,
    })),
    ...(opts.bing ? { bing: manifestBing(opts.bing, outDir) } : {}),
  }))
  return { outDir, sites: summary, metadataFiles }
}

/** The Bing step for `manifest.json`, with file paths relative to the dump directory. */
function manifestBing(step: BingDumpStep, outDir: string): BingDumpStep {
  if (step._tag !== 'dumped')
    return step
  return {
    ...step,
    sites: step.sites.map(site => ({
      siteUrl: site.siteUrl,
      files: site.files.map(file => ({ ...file, path: path.relative(outDir, file.path) })),
    })),
  }
}

async function writeJsonFile(target: string, value: unknown): Promise<{ path: string, bytes: number }> {
  const body = `${JSON.stringify(value, bigintSafe, 2)}\n`
  await fs.writeFile(target, body)
  return { path: target, bytes: Buffer.byteLength(body) }
}

/** Watermarks plus failed and missing dates for every table and search type the Store knows. */
async function readCoverage(store: LocalStore, siteId: string): Promise<CoverageEntry[]> {
  const scope = { userId: store.userId, siteId }
  const [watermarks, states] = await Promise.all([store.engine.getWatermarks(scope), store.engine.getSyncStates(scope)])
  const groups = new Map<string, CoverageEntry & { done: Set<string> }>()
  const group = (table: TableName, searchType: SearchType): CoverageEntry & { done: Set<string> } => {
    const key = `${table}\u0000${searchType}`
    let entry = groups.get(key)
    if (!entry) {
      entry = { table, searchType, oldestDate: null, newestDate: null, lastSyncAt: null, missingDates: [], failedDates: [], done: new Set() }
      groups.set(key, entry)
    }
    return entry
  }
  for (const mark of watermarks) {
    const entry = group(mark.table, mark.searchType ?? 'web')
    entry.oldestDate = mark.oldestDateSynced
    entry.newestDate = mark.newestDateSynced
    entry.lastSyncAt = new Date(mark.lastSyncAt).toISOString()
  }
  for (const state of states) {
    const entry = group(state.table, state.searchType ?? 'web')
    if (state.state === 'done')
      entry.done.add(state.date)
    else if (state.state === 'failed')
      entry.failedDates.push({ date: state.date, error: state.error ?? null })
  }
  return [...groups.values()]
    .map(({ done, ...entry }) => {
      const failed = new Set(entry.failedDates.map(f => f.date))
      const missingDates = entry.oldestDate && entry.newestDate
        ? getDateRange(entry.oldestDate, entry.newestDate).filter(date => !done.has(date) && !failed.has(date))
        : []
      return { ...entry, missingDates, failedDates: entry.failedDates.sort((a, b) => a.date.localeCompare(b.date)) }
    })
    .sort((a, b) => a.table.localeCompare(b.table) || a.searchType.localeCompare(b.searchType))
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
    files.push({ dataset: entry.table, searchType: entry.searchType ?? 'web', path: target, bytes: bytes.byteLength, rows: entry.rowCount })
  })
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// Read parquet rows back through DuckDB and re-emit per table and search type
// in the chosen row format. Web rows go to <outDir>/<site>/<table>.<ext>; other
// search types go to <outDir>/<site>/<searchType>/<table>.<ext>. The rows carry
// no search type column, so one file never mixes two types.
async function dumpRowFormat(
  store: LocalStore,
  entries: ManifestEntry[],
  outDir: string,
  siteUrl: string,
  format: 'json' | 'ndjson' | 'csv',
): Promise<DumpFile[]> {
  const groups = new Map<string, { table: TableName, searchType: SearchType, entries: ManifestEntry[] }>()
  for (const e of entries) {
    const searchType = e.searchType ?? 'web'
    const key = `${e.table}\u0000${searchType}`
    const group = groups.get(key) ?? { table: e.table as TableName, searchType, entries: [] }
    group.entries.push(e)
    groups.set(key, group)
  }
  const siteDir = path.join(outDir, safeSiteDir(siteUrl))
  const files: DumpFile[] = []
  for (const { table, searchType, entries: groupEntries } of groups.values()) {
    const filePaths = groupEntries.map(e => path.join(store.dataDir, e.objectKey))
    const rows = await readParquetRows(filePaths, table)
    const dir = searchType === 'web' ? siteDir : path.join(siteDir, searchType)
    files.push({ ...await writeRows(dir, table, rows, format), searchType })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
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
