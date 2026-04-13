// DuckDB integration, edge-compatible. Consumers (CLI, Workers) supply a
// DuckDBHandle backed by whatever loader fits their runtime — async-over-
// worker in browsers/CF, blocking-node bindings in Node.

import type { ParquetCodec, QueryExecutor, Row, TableName } from './storage'
import { SCHEMAS } from './schema'

export interface DuckDBHandle {
  query: (sql: string, params?: unknown[]) => Promise<Row[]>
  registerFileBuffer: (name: string, bytes: Uint8Array) => Promise<void>
  copyFileToBuffer: (name: string) => Promise<Uint8Array>
  dropFiles: (names: string[]) => Promise<void>
  /**
   * Returns a unique path suitable for `COPY TO '…'` + `copyFileToBuffer`.
   * In Node this is an absolute path under `os.tmpdir()` so DuckDB doesn't
   * litter the CWD; in browsers/Workers it's a plain virtual-FS name.
   */
  makeTempPath: (ext: string) => string
}

export interface DuckDBFactory {
  getDuckDB: () => Promise<DuckDBHandle>
}

function sqlEscape(path: string): string {
  return path.replace(/'/g, '\'\'')
}

export function createDuckDBCodec(factory: DuckDBFactory): ParquetCodec {
  return {
    async encode(table: TableName, rows: Row[]): Promise<Uint8Array> {
      const db = await factory.getDuckDB()
      const inName = db.makeTempPath('json')
      const outName = db.makeTempPath('parquet')

      const jsonBytes = new TextEncoder().encode(JSON.stringify(rows))
      const registered: string[] = []
      await db.registerFileBuffer(inName, jsonBytes)
      registered.push(inName)

      try {
        const sql = rows.length === 0
          ? `COPY (SELECT * FROM ${emptyTableSchema(table)} WHERE FALSE) TO '${sqlEscape(outName)}' (FORMAT PARQUET)`
          : `COPY (SELECT * FROM read_json_auto('${sqlEscape(inName)}', format='array', columns=${columnsJson(table)})) TO '${sqlEscape(outName)}' (FORMAT PARQUET)`
        await db.query(sql)
        registered.push(outName)
        return await db.copyFileToBuffer(outName)
      }
      finally {
        await db.dropFiles(registered)
      }
    },

    async decode(bytes: Uint8Array, table?: TableName): Promise<Row[]> {
      const db = await factory.getDuckDB()
      const name = db.makeTempPath('parquet')
      await db.registerFileBuffer(name, bytes)
      try {
        // Cast DATE columns → YYYY-MM-DD string so rows survive JSON round-trips
        // and match the string shape the codec accepts on encode.
        return await db.query(
          `SELECT * ${dateReplaceClause(table)} FROM read_parquet('${sqlEscape(name)}')`,
        )
      }
      finally {
        await db.dropFiles([name])
      }
    },
  }
}

export function createDuckDBExecutor(factory: DuckDBFactory): QueryExecutor {
  return {
    async execute({ sql, params, files }) {
      const db = await factory.getDuckDB()
      const names: string[] = []
      for (const f of files) {
        await db.registerFileBuffer(f.key, f.bytes)
        names.push(f.key)
      }
      try {
        return await db.query(sql, params)
      }
      finally {
        await db.dropFiles(names)
      }
    },
  }
}

function emptyTableSchema(table: TableName): string {
  return `(FROM (VALUES ${placeholderValues(table)}) t(${columnList(table)}))`
}

function dateReplaceClause(table: TableName | undefined): string {
  if (!table)
    return ''
  const dateCols = SCHEMAS[table].columns.filter(c => c.type === 'DATE').map(c => c.name)
  if (dateCols.length === 0)
    return ''
  const replacements = dateCols.map(n => `strftime(${n}, '%Y-%m-%d') AS ${n}`)
  return `REPLACE (${replacements.join(', ')})`
}

const TABLE_COLUMNS: Record<TableName, Array<[string, string]>> = {
  pages: [
    ['url', 'VARCHAR'],
    ['date', 'DATE'],
    ['clicks', 'INTEGER'],
    ['impressions', 'INTEGER'],
    ['sum_position', 'DOUBLE'],
  ],
  keywords: [
    ['query', 'VARCHAR'],
    ['date', 'DATE'],
    ['clicks', 'INTEGER'],
    ['impressions', 'INTEGER'],
    ['sum_position', 'DOUBLE'],
  ],
  countries: [
    ['country', 'VARCHAR'],
    ['date', 'DATE'],
    ['clicks', 'INTEGER'],
    ['impressions', 'INTEGER'],
    ['sum_position', 'DOUBLE'],
  ],
  devices: [
    ['device', 'VARCHAR'],
    ['date', 'DATE'],
    ['clicks', 'INTEGER'],
    ['impressions', 'INTEGER'],
    ['sum_position', 'DOUBLE'],
  ],
  page_keywords: [
    ['url', 'VARCHAR'],
    ['query', 'VARCHAR'],
    ['date', 'DATE'],
    ['clicks', 'INTEGER'],
    ['impressions', 'INTEGER'],
    ['sum_position', 'DOUBLE'],
  ],
}

function columnList(table: TableName): string {
  return TABLE_COLUMNS[table].map(([n]) => n).join(', ')
}

function placeholderValues(table: TableName): string {
  const cols = TABLE_COLUMNS[table]
  const defaults = cols.map(([, t]) => defaultForType(t))
  return `(${defaults.join(', ')})`
}

function defaultForType(t: string): string {
  if (t === 'VARCHAR')
    return '\'\''
  if (t === 'DATE')
    return 'DATE \'1970-01-01\''
  if (t === 'INTEGER' || t === 'BIGINT')
    return '0'
  if (t === 'DOUBLE')
    return 'CAST(0 AS DOUBLE)'
  return 'NULL'
}

function columnsJson(table: TableName): string {
  const obj: Record<string, string> = {}
  for (const [name, type] of TABLE_COLUMNS[table])
    obj[name] = type
  return `{${Object.entries(obj).map(([k, v]) => `'${k}': '${v}'`).join(', ')}}`
}
