import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'

import { analyzeInBrowser } from '@gscdump/engine-duckdb-node'
import { bindLiterals } from '@gscdump/engine/sql'

export interface QueryResult {
  rows: Record<string, unknown>[]
  queryMs: number
}

export interface AnalyzeResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  queryMs: number
}

export interface DuckDBWasmBootResult {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
}

export interface BootDuckDBWasmOptions {
  logger?: unknown
}

export interface BrowserParquetFile {
  bytes: Uint8Array
  name?: string
}

export interface BrowserParquetTable {
  table: string
  files: BrowserParquetFile[]
}

export interface BrowserParquetUrlTable {
  table: string
  urls: string[]
}

export interface AttachParquetTablesOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  tables: BrowserParquetTable[]
  schema?: string
}

export interface AttachParquetUrlTablesOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  tables: BrowserParquetUrlTable[]
  fetch?: typeof fetch
  schema?: string
  fetchInit?: RequestInit
}

export interface BrowserAnalysisRuntime {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  analyze: (params: AnalysisParams) => Promise<AnalyzeResult>
  close: () => Promise<void>
}

interface ArrowLikeRow {
  toJSON?: () => Record<string, unknown>
}

interface ArrowLikeTable {
  toArray: () => ArrowLikeRow[]
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, '\'\'')
}

function toRows(result: unknown): Record<string, unknown>[] {
  return (result as ArrowLikeTable)
    .toArray()
    .map((row) => {
      if (typeof row.toJSON === 'function')
        return row.toJSON()
      return row as Record<string, unknown>
    })
}

function fileName(table: string, index: number, provided?: string): string {
  return provided ?? `${table}_${index}.parquet`
}

function readParquetViewSql(schema: string, table: string, files: string[]): string {
  const escaped = files.map(name => `'${escapeSqlString(name)}'`).join(', ')
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS SELECT * FROM read_parquet([${escaped}], union_by_name = true)`
}

export async function bootDuckDBWasm(
  options: BootDuckDBWasmOptions = {},
): Promise<DuckDBWasmBootResult> {
  const { getJsDelivrBundles, selectBundle, AsyncDuckDB, ConsoleLogger } = await import('@duckdb/duckdb-wasm')
  const bundles = getJsDelivrBundles()
  const bundle = await selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const db = new AsyncDuckDB((options.logger as any) ?? new ConsoleLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  const conn = await db.connect()
  return { db, conn }
}

export async function attachParquetTables(
  options: AttachParquetTablesOptions,
): Promise<void> {
  const { db, conn, tables, schema = 'main' } = options
  for (const table of tables) {
    const names: string[] = []
    for (let i = 0; i < table.files.length; i++) {
      const file = table.files[i]!
      const name = fileName(table.table, i, file.name)
      names.push(name)
      await db.registerFileBuffer(name, file.bytes)
    }
    await conn.query(readParquetViewSql(schema, table.table, names))
  }
}

export async function attachParquetUrlTables(
  options: AttachParquetUrlTablesOptions,
): Promise<void> {
  const {
    db,
    conn,
    tables,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    schema = 'main',
    fetchInit,
  } = options

  const flat: Array<{ table: string, url: string, index: number }> = []
  const counts: Record<string, number> = {}
  for (const [table, urls] of tables.map(t => [t.table, t.urls] as const)) {
    if (urls.length === 0)
      continue
    counts[table] = urls.length
    for (let i = 0; i < urls.length; i++)
      flat.push({ table, url: urls[i]!, index: i })
  }

  await Promise.all(flat.map(async ({ table, url, index }) => {
    const response = await fetchImpl(url, fetchInit)
    if (!response.ok)
      throw new Error(`fetch ${url} failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await db.registerFileBuffer(fileName(table, index), bytes)
  }))

  for (const table of Object.keys(counts)) {
    const names: string[] = []
    for (let i = 0; i < counts[table]!; i++)
      names.push(fileName(table, i))
    await conn.query(readParquetViewSql(schema, table, names))
  }
}

export function createBrowserAnalysisRuntime(
  boot: DuckDBWasmBootResult,
  options: { schema?: string } = {},
): BrowserAnalysisRuntime {
  const { db, conn } = boot
  const schema = options.schema ?? 'main'

  return {
    db,
    conn,
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const t0 = performance.now()
      const finalSql = params && params.length > 0 ? bindLiterals(sql, params) : sql
      const result = await conn.query(finalSql)
      return {
        rows: toRows(result),
        queryMs: performance.now() - t0,
      }
    },
    async analyze(params: AnalysisParams): Promise<AnalyzeResult> {
      const t0 = performance.now()
      const result: AnalysisResult = await analyzeInBrowser({
        query: async (sql, bindParams) => {
          const finalSql = bindParams && bindParams.length > 0 ? bindLiterals(sql, bindParams) : sql
          return toRows(await conn.query(finalSql))
        },
      }, { schema }, params)
      return {
        results: result.results as Record<string, unknown>[],
        meta: result.meta,
        queryMs: performance.now() - t0,
      }
    },
    async close(): Promise<void> {
      await conn.close()
      // terminate() is safe here because this runtime owns the db+worker pair.
      await db.terminate()
    },
  }
}
