import type { TableName } from './local-store'
import { rm } from 'node:fs/promises'
import { dateColumnsFor } from '@gscdump/engine/schema'
import { sqlEscape } from '@gscdump/engine/sql'
import { dateReplaceClause } from '@gscdump/engine/sql-fragments'

/** One set of Parquet files and the constant columns added to each of its rows. */
export interface NativeDuckDBSource {
  filePaths: string[]
  /** Column name to string value, e.g. `{ search_type: 'image' }`. */
  constants: Record<string, string>
}

export interface NativeDuckDBTableInput {
  /** Table name in the output database. */
  name: string
  /** Columns stored as calendar days, cast from their Parquet encoding. */
  dateColumns: readonly string[]
  sources: NativeDuckDBSource[]
}

export interface NativeDuckDBTableResult {
  table: string
  files: number
  rows: number
}

function parquetFileListSql(filePaths: readonly string[]): string {
  return filePaths.map(filePath => `'${sqlEscape(filePath)}'`).join(', ')
}

async function loadDuckDB(): Promise<typeof import('@duckdb/node-api')> {
  return import('@duckdb/node-api')
}

/** Read local Parquet partitions through the CLI-only native DuckDB adapter. */
export async function readParquetRows(
  filePaths: string[],
  table: TableName,
): Promise<Record<string, unknown>[]> {
  const { DuckDBInstance } = await loadDuckDB()
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  try {
    const replace = dateReplaceClause(dateColumnsFor(table), 'string')
    const reader = await conn.runAndReadAll(
      `SELECT * ${replace} FROM read_parquet([${parquetFileListSql(filePaths)}], union_by_name=true)`,
    )
    return reader.getRowObjects() as Record<string, unknown>[]
  }
  finally {
    conn.closeSync()
    instance.closeSync()
  }
}

/** Materialise Parquet sources into a persistent DuckDB database, one table per input. */
export async function materializeParquetTables(
  outPath: string,
  tables: readonly NativeDuckDBTableInput[],
  force = false,
): Promise<NativeDuckDBTableResult[]> {
  if (force)
    await rm(outPath, { force: true })

  const { DuckDBInstance } = await loadDuckDB()
  const instance = await DuckDBInstance.create(outPath)
  const conn = await instance.connect()
  const results: NativeDuckDBTableResult[] = []
  try {
    for (const input of tables) {
      const replace = dateReplaceClause(input.dateColumns, 'date')
      const selects = input.sources.map((source) => {
        const constants = Object.entries(source.constants)
          .map(([column, value]) => `, '${sqlEscape(value)}' AS ${column}`)
          .join('')
        return `SELECT * ${replace}${constants} FROM read_parquet([${parquetFileListSql(source.filePaths)}], union_by_name=true)`
      })
      await conn.run(`CREATE OR REPLACE TABLE ${input.name} AS ${selects.join(' UNION ALL BY NAME ')}`)
      const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM ${input.name}`)
      const rows = reader.getRowObjects() as Array<{ n: bigint }>
      results.push({
        table: input.name,
        files: input.sources.reduce((sum, source) => sum + source.filePaths.length, 0),
        rows: Number(rows[0]?.n ?? 0),
      })
    }
  }
  finally {
    conn.closeSync()
    instance.closeSync()
  }
  return results
}
