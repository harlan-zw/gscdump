import type { StorageEngine, TableName } from './local-store'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { dateColumnsFor } from '@gscdump/engine/schema'
import { sqlEscape } from '@gscdump/engine/sql'
import { dateReplaceClause } from '@gscdump/engine/sql-fragments'
import { allTables } from './local-store'

export interface AnalyzerSnapshotOptions {
  engine: StorageEngine
  dataDir: string
  userId: string
  siteId?: string
  outPath: string
  force?: boolean
}

export interface AnalyzerSnapshotTable {
  table: TableName
  files: number
  rows: number
}

export interface AnalyzerSnapshot {
  outPath: string
  tables: AnalyzerSnapshotTable[]
  totalRows: number
}

function parquetFileListSql(filePaths: readonly string[]): string {
  return filePaths.map(filePath => `'${sqlEscape(filePath)}'`).join(', ')
}

/**
 * Pack the live Parquet partitions into a `.duckdb` file in the schema the
 * browser Analyzers attach: one table per Store table, columns as stored.
 * This is an Analyzer fixture, separate from the portable `dump --format
 * duckdb` layout, which adds `site` and `search_type` columns.
 */
export async function writeAnalyzerSnapshot(opts: AnalyzerSnapshotOptions): Promise<AnalyzerSnapshot> {
  const outPath = path.resolve(opts.outPath)
  // The local manifest is one JSON document. Read it once and group in memory.
  const entries = await opts.engine.listLive({ userId: opts.userId, siteId: opts.siteId })
  if (opts.force)
    await rm(outPath, { force: true })

  const instance = await DuckDBInstance.create(outPath)
  const conn = await instance.connect()
  const tables: AnalyzerSnapshotTable[] = []
  try {
    for (const table of allTables()) {
      const filePaths = entries.filter(entry => entry.table === table).map(entry => path.join(opts.dataDir, entry.objectKey))
      if (filePaths.length === 0)
        continue
      const replace = dateReplaceClause(dateColumnsFor(table), 'date')
      await conn.run(`CREATE OR REPLACE TABLE ${table} AS SELECT * ${replace} FROM read_parquet([${parquetFileListSql(filePaths)}], union_by_name=true)`)
      const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM ${table}`)
      tables.push({ table, files: filePaths.length, rows: Number(reader.getRowsJS()[0]?.[0] ?? 0) })
    }
  }
  finally {
    conn.closeSync()
    instance.closeSync()
  }
  return { outPath, tables, totalRows: tables.reduce((sum, table) => sum + table.rows, 0) }
}
