import type { TableName } from './local-store'
import { rm } from 'node:fs/promises'
import { dateColumnsFor } from '@gscdump/engine/schema'
import { sqlEscape } from '@gscdump/engine/sql'
import { dateReplaceClause } from '@gscdump/engine/sql-fragments'

export interface NativeDuckDBTableInput {
  table: TableName
  filePaths: string[]
}

export interface NativeDuckDBTableResult {
  table: TableName
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

/** Materialise local Parquet partitions into a persistent DuckDB database. */
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
      const replace = dateReplaceClause(dateColumnsFor(input.table), 'date')
      await conn.run(
        `CREATE OR REPLACE TABLE ${input.table} AS SELECT * ${replace} FROM read_parquet([${parquetFileListSql(input.filePaths)}], union_by_name=true)`,
      )
      const reader = await conn.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM ${input.table}`)
      const rows = reader.getRowObjects() as Array<{ n: bigint }>
      results.push({
        table: input.table,
        files: input.filePaths.length,
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
