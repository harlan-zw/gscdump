import type { StorageEngine, TableName } from '../local-store'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { sqlEscape } from '@gscdump/engine/sql'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { displayPath, setQuiet } from '../utils'

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
  if (opts.force)
    await rm(outPath, { force: true })

  const instance = await DuckDBInstance.create(outPath)
  const conn = await instance.connect()
  const tables: ExportTableResult[] = []

  try {
    for (const table of allTables()) {
      const entries = await opts.engine.listLive({
        userId: opts.userId,
        siteId: opts.siteId,
        table: table as TableName,
      })
      if (entries.length === 0)
        continue

      const paths = entries.map(e => path.join(opts.dataDir, e.objectKey))
      const fileList = paths.map(p => `'${sqlEscape(p)}'`).join(', ')
      await conn.run(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_parquet([${fileList}], union_by_name=true)`,
      )

      const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM ${table}`)
      const rows = reader.getRowObjects() as Array<{ n: bigint }>
      const rowCount = Number(rows[0]?.n ?? 0)
      tables.push({ table: table as TableName, files: entries.length, rows: rowCount })
    }
  }
  finally {
    conn.closeSync()
    instance.closeSync()
  }

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
      description: 'Limit export to a single site URL (omit to include all)',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Overwrite the output file if it already exists',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output a JSON summary instead of formatted text',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress info/success output',
    },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
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

    if (args.json) {
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
