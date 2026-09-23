import type { EntityDataset } from '../local-entities'
import type { StorageEngine, TableName } from '../local-store'
import type { NativeDuckDBTableInput } from '../native-duckdb'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFilesystemDataSource } from '@gscdump/engine/filesystem'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { dateColumnsFor } from '@gscdump/engine/schema'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { ENTITY_DATASETS, readEntityDatasets } from '../local-entities'
import { allTables } from '../local-store'
import { materializeParquetTables } from '../native-duckdb'
import { applyOutputMode, displayPath, formatBytes, OUTPUT_ARGS } from '../utils'

export interface ExportOptions {
  engine: StorageEngine
  dataDir: string
  userId: string
  siteId?: string
  outPath: string
  force?: boolean
}

export interface ExportTableResult {
  /** Analytics table or entity dataset name. */
  table: string
  files: number
  rows: number
}

export interface ExportResult {
  outPath: string
  /** Size of the written .duckdb file. */
  bytes: number
  tables: ExportTableResult[]
  /** Entity datasets with no rows. They get no table. */
  skipped: EntityDataset[]
  totalRows: number
}

/**
 * Pack the Store into one .duckdb file: one table per analytics table, with
 * `search_type` and `site_id` columns, then one table per entity dataset
 * with a `site_id` column. Entity rows come from the same builders `dump` uses.
 */
export async function exportToDuckDB(opts: ExportOptions): Promise<ExportResult> {
  const outPath = path.resolve(opts.outPath)
  // The local manifest is one JSON document. Read it once and group in memory;
  // querying once per table rereads and reparses the same file nine times.
  const entries = await opts.engine.listLive({
    userId: opts.userId,
    siteId: opts.siteId,
  })
  const inputs: NativeDuckDBTableInput[] = []
  for (const table of allTables()) {
    const groups = new Map<string, { filePaths: string[], constants: Record<string, string> }>()
    for (const entry of entries) {
      if (entry.table !== table)
        continue
      const searchType = entry.searchType ?? 'web'
      const site = entry.siteId ?? ''
      const key = `${searchType}\u0000${site}`
      const group = groups.get(key) ?? { filePaths: [], constants: { search_type: searchType, site_id: site } }
      group.filePaths.push(path.join(opts.dataDir, entry.objectKey))
      groups.set(key, group)
    }
    if (groups.size > 0)
      inputs.push({ name: table, dateColumns: dateColumnsFor(table as TableName), sources: [...groups.values()] })
  }

  // Entity rows are staged as Parquet so DuckDB loads them like the analytics files.
  const siteIds = opts.siteId
    ? [opts.siteId]
    : [...new Set(entries.flatMap(entry => entry.siteId ? [entry.siteId] : []))]
  const dataSource = createFilesystemDataSource({ rootDir: opts.dataDir })
  const staging = await mkdtemp(path.join(os.tmpdir(), 'gscdump-export-'))
  try {
    const skipped: EntityDataset[] = []
    for (const dataset of ENTITY_DATASETS) {
      const sources: NativeDuckDBTableInput['sources'] = []
      for (const siteId of siteIds) {
        const [rows] = await readEntityDatasets(dataSource, { userId: opts.userId, siteId }, [dataset])
        if (!rows || rows.rows.length === 0)
          continue
        const file = path.join(staging, `${dataset}-${sources.length}.parquet`)
        await writeFile(file, encodeRowsToParquetFlex(rows.rows, { columns: rows.columns }))
        sources.push({ filePaths: [file], constants: { site_id: siteId } })
      }
      if (sources.length > 0)
        inputs.push({ name: dataset, dateColumns: [], sources })
      else
        skipped.push(dataset)
    }

    const tables = await materializeParquetTables(outPath, inputs, opts.force)
    const bytes = tables.length > 0 ? (await stat(outPath)).size : 0
    const totalRows = tables.reduce((acc, t) => acc + t.rows, 0)
    return { outPath, bytes, tables, skipped, totalRows }
  }
  finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Pack the Store, inspections, and sitemaps into a single .duckdb file for portable distribution (browser attach, CDN serving, etc.)',
  },
  args: {
    out: {
      type: 'string',
      required: true,
      description: 'Output path for the .duckdb file',
    },
    site: {
      type: 'string',
      description: 'Limit export to a single site URL (omit to include all)',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Overwrite the output file if it already exists',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteId = args.site ? store.siteIdFor(args.site) : undefined

    const result = await exportToDuckDB({
      engine: store.engine,
      dataDir: store.dataDir,
      userId: store.userId,
      siteId,
      outPath: args.out,
      force: args.force,
    })

    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    if (result.tables.length === 0) {
      console.log(`\n  No data to export. Run \`gscdump sync\` first.`)
      return
    }

    for (const t of result.tables)
      console.log(`  ${t.table.padEnd(32)} ${String(t.files).padStart(4)} parquet → ${t.table}  (${t.rows.toLocaleString()} rows)`)
    for (const dataset of result.skipped)
      console.log(`  \x1B[90m${dataset}: no rows yet; skipped\x1B[0m`)

    console.log(`\n  Exported ${result.tables.length} table(s), ${result.totalRows.toLocaleString()} rows, ${formatBytes(result.bytes)} → ${displayPath(result.outPath)}`)
    console.log(`  Analytics tables carry search_type and site_id columns. Entity tables carry site_id.`)
    // Keep absolute path in the SQL example: the user copy-pastes this into
    // DuckDB which doesn't share our cwd.
    console.log(`\n  Attach from DuckDB:     \x1B[36mATTACH '${result.outPath}' AS gsc (READ_ONLY); SELECT * FROM gsc.pages LIMIT 10;\x1B[0m`)
    console.log(`  Attach in a browser:    use DuckDB-WASM registerFileBuffer + \x1B[36mATTACH 'gsc.duckdb' AS gsc (READ_ONLY)\x1B[0m`)
  },
})
