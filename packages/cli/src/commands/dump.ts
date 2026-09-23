import type { SearchType } from 'gscdump/query'
import type { BingDumpStep } from '../dump-bing'
import type { DumpedDataset, DumpFormat, DumpSink, WrittenFile } from '../dump-writers'
import type { EntityDataset } from '../local-entities'
import type { LocalStore, ManifestEntry, TableName } from '../local-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import { getDateRange } from 'gscdump/dates'
import { dumpCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { dumpBing } from '../dump-bing'
import { DUMP_FORMATS, isDumpFormat, openDumpSink } from '../dump-writers'
import { ENTITY_DATASETS, readEntityDatasets } from '../local-entities'
import { allTables } from '../local-store'
import { groupTableSources, siteUrlFor } from '../table-sources'
import { ALL_SEARCH_TYPES, applyOutputMode, displayPath, logger, OUTPUT_ARGS, parseSearchType } from '../utils'

const DEFAULT_OUT = './gscdump-export'

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
      description: `Output format: ${DUMP_FORMATS.join(', ')} (default: parquet). sqlite and duckdb write one database file`,
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
    const format = String(args.format)
    if (!isDumpFormat(format)) {
      logger.error(`Invalid --format: ${format}. Allowed: ${DUMP_FORMATS.join(', ')}`)
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
          .map(siteId => ({ site: siteUrlFor(siteId), siteId }))
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
    const result = await dumpSites({
      store,
      targets,
      outDir,
      format,
      ...(tablesFilter ? { tables: tablesFilter } : {}),
      ...(searchType !== undefined ? { searchType } : {}),
      ...(preloadedEntries ? { entries: preloadedEntries } : {}),
      ...(siteList ? { siteList } : {}),
    })
    const bing: BingDumpStep = args.bing === false || (tablesFilter && !tablesFilter.has('bing'))
      ? { _tag: 'disabled' }
      : await dumpBing({
          googleSites: args['all-sites'] ? 'all' : targets.map(target => target.site),
          outDir,
          format,
        }).catch((error: unknown) => ({ _tag: 'failed' as const, reason: error instanceof Error ? error.message : String(error) }))

    if (json) {
      console.log(JSON.stringify({ ...result, bing }, null, 2))
      return
    }
    const bytesByPath = new Map(result.files.map(file => [file.path, file.bytes]))
    const database = format === 'sqlite' || format === 'duckdb'
    if (database && result.sites.some(site => site.datasets.length > 0)) {
      const file = result.files[0]!
      logger.success(`Wrote ${displayPath(file.path)} (${formatBytes(file.bytes)})`)
    }
    for (const site of result.sites) {
      if (site.datasets.length === 0) {
        if (!quiet)
          logger.warn(`No data for ${site.site}; skipping`)
        continue
      }
      logger.success(`[${site.site}] ${site.totals.datasets} dataset(s), ${site.totals.rows.toLocaleString()} rows`)
      if (quiet)
        continue
      for (const dataset of site.datasets) {
        const label = database
          ? `${dataset.dataset}${dataset.searchType ? ` (search_type = ${dataset.searchType})` : ''}`
          : `${path.relative(outDir, dataset.path)}  ${formatBytes(bytesByPath.get(dataset.path) ?? 0)}`
        console.log(`  ${label}  ${dataset.rows.toLocaleString()} rows`)
      }
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

export type { DumpedDataset, DumpFormat, WrittenFile } from '../dump-writers'

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
  datasets: DumpedDataset[]
  /** Datasets with no rows. They get no file. */
  skipped: Array<{ dataset: EntityDataset, reason: 'empty' }>
  totals: { datasets: number, rows: number }
  /** What the Store holds for each table and search type, including its gaps. */
  coverage: CoverageEntry[]
}

export interface DumpResult {
  outDir: string
  format: DumpFormat
  /** Data files the dump wrote, with their sizes. A database format writes one. */
  files: WrittenFile[]
  /** Files that describe the whole dump: `manifest.json`, and `sites.json` when the Site list was known. */
  metadataFiles: WrittenFile[]
  sites: SiteDumpSummary[]
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
 * Write every requested analytics table and entity dataset for each Site.
 * `tables` limits the datasets by name; omit it for all of them. `entries`
 * reuses a manifest listing the caller already holds. The dump reads only
 * the Store: it never calls a Search Engine to fill a gap.
 */
export async function dumpSites(opts: {
  store: LocalStore
  targets: ReadonlyArray<{ site: string, siteId: string }>
  outDir: string
  format: DumpFormat
  tables?: ReadonlySet<string>
  searchType?: SearchType
  entries?: readonly ManifestEntry[]
  /** Search Console Sites and permission levels, written to `sites.json`. */
  siteList?: readonly SiteListing[]
}): Promise<DumpResult> {
  const { outDir, format } = opts
  const sink = await openDumpSink(outDir, format)
  // Close on failure too, so the DuckDB connection and temporary files are released.
  const summary = await dumpEachSite(sink, opts).catch(async (error: unknown) => {
    await sink.close()
    throw error
  })
  const files = await sink.close()
  const metadataFiles: WrittenFile[] = []
  if (opts.siteList)
    metadataFiles.push(await writeJsonFile(path.join(outDir, 'sites.json'), { sites: opts.siteList }))
  metadataFiles.push(await writeJsonFile(path.join(outDir, 'manifest.json'), {
    generatedAt: new Date().toISOString(),
    format,
    files: files.map(file => ({ ...file, path: path.relative(outDir, file.path) })),
    sites: summary.map(site => ({
      ...site,
      datasets: site.datasets.map(dataset => ({ ...dataset, path: path.relative(outDir, dataset.path) })),
    })),
  }))
  return { outDir, format, files, metadataFiles, sites: summary }
}

async function dumpEachSite(sink: DumpSink, opts: Parameters<typeof dumpSites>[0]): Promise<SiteDumpSummary[]> {
  const { store, tables } = opts
  const wantedEntities = ENTITY_DATASETS.filter(dataset => !tables || tables.has(dataset))
  const summary: SiteDumpSummary[] = []
  for (const target of opts.targets) {
    const entries = (opts.entries
      ? opts.entries.filter(entry => entry.siteId === target.siteId)
      : await listLiveEntries(store, target.siteId, opts.searchType))
      .filter(e => !tables || tables.has(e.table))
    const datasets: DumpedDataset[] = []
    // Tag rows with the Site the caller resolved, which may differ in case from the site id.
    for (const source of groupTableSources(entries, store.dataDir))
      datasets.push(await sink.writeTable({ ...source, site: target.site }))

    const skipped: SiteDumpSummary['skipped'] = []
    for (const dataset of await readEntityDatasets(store.dataSource, { userId: store.userId, siteId: target.siteId }, wantedEntities)) {
      if (dataset.rows.length === 0)
        skipped.push({ dataset: dataset.dataset, reason: 'empty' })
      else
        datasets.push(await sink.writeEntity(target.site, dataset))
    }

    summary.push({
      site: target.site,
      siteId: target.siteId,
      coverage: await readDumpCoverage(store, target.siteId),
      datasets,
      skipped,
      totals: {
        datasets: datasets.length,
        rows: datasets.reduce((sum, dataset) => sum + dataset.rows, 0),
      },
    })
  }
  return summary
}

async function writeJsonFile(target: string, value: unknown): Promise<WrittenFile> {
  const body = `${JSON.stringify(value, null, 2)}\n`
  await fs.writeFile(target, body)
  return { path: target, bytes: Buffer.byteLength(body) }
}

/**
 * Coverage seam: the one place `dump` reads what the Store holds for a Site.
 * Its result goes to the summary and to manifest.json. The shared Store
 * coverage model from the sync work replaces this function.
 */
async function readDumpCoverage(store: LocalStore, siteId: string): Promise<CoverageEntry[]> {
  return readCoverage(store, siteId)
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

async function listLiveEntries(store: LocalStore, siteId: string, searchType?: SearchType): Promise<ManifestEntry[]> {
  return store.engine.listLive({
    userId: store.userId,
    siteId,
    ...(searchType !== undefined ? { searchType } : {}),
  })
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
