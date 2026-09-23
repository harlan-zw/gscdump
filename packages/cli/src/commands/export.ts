import type { StorageEngine, TableName } from '../local-store'
import path from 'node:path'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { materializeParquetTables } from '../native-duckdb'
import { applyOutputMode, displayPath, OUTPUT_ARGS } from '../utils'

export interface ExportOptions {
  engine: StorageEngine
  dataDir: string
  userId: string
  siteId?: string
  outPath: string
  force?: boolean
}

export interface ExportTableResult {
  table: TableName
  files: number
  rows: number
}

export interface ExportResult {
  outPath: string
  tables: ExportTableResult[]
  totalRows: number
}

export async function exportToDuckDB(opts: ExportOptions): Promise<ExportResult> {
  const outPath = path.resolve(opts.outPath)
  // The local manifest is one JSON document. Read it once and group in memory;
  // querying once per table rereads and reparses the same file nine times.
  const entries = await opts.engine.listLive({
    userId: opts.userId,
    siteId: opts.siteId,
  })
  const inputs: Array<{ table: TableName, filePaths: string[] }> = []
  for (const table of allTables()) {
    const tableEntries = entries.filter(entry => entry.table === table)
    if (tableEntries.length > 0) {
      inputs.push({
        table: table as TableName,
        filePaths: tableEntries.map(entry => path.join(opts.dataDir, entry.objectKey)),
      })
    }
  }

  const tables: ExportTableResult[] = await materializeParquetTables(outPath, inputs, opts.force)

  const totalRows = tables.reduce((acc, t) => acc + t.rows, 0)
  return { outPath, tables, totalRows }
}

export const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Pack live Parquet partitions into a single .duckdb file for portable distribution (browser attach, CDN serving, etc.)',
  },
  args: {
    out: {
      type: 'string',
      required: true,
      description: 'Output path for the .duckdb file',
    },
    site: {
      type: 'string',
      description: 'Limit the export to one Site, for example example.com (omit to include all)',
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
    const siteId = args.site ? store.siteIdFor(await ctx.resolveSite(String(args.site), { scope: 'store' })) : undefined

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
      console.log(`  ${t.table.padEnd(15)} ${String(t.files).padStart(4)} parquet → ${t.table}  (${t.rows.toLocaleString()} rows)`)

    console.log(`\n  Exported ${result.tables.length} table(s), ${result.totalRows.toLocaleString()} rows → ${displayPath(result.outPath)}`)
    // Keep absolute path in the SQL example: the user copy-pastes this into
    // DuckDB which doesn't share our cwd.
    console.log(`\n  Attach from DuckDB:     \x1B[36mATTACH '${result.outPath}' AS gsc (READ_ONLY); SELECT * FROM gsc.pages LIMIT 10;\x1B[0m`)
    console.log(`  Attach in a browser:    use DuckDB-WASM registerFileBuffer + \x1B[36mATTACH 'gsc.duckdb' AS gsc (READ_ONLY)\x1B[0m`)
  },
})
