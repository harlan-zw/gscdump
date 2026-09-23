// Writers for `gscdump dump`. Every format reads through one in-memory DuckDB
// connection, so rows stream from the Store's Parquet to the output and never
// sit in memory as one array.
//
// - File formats write one file per dataset:
//   `<site>/<search_type>/<table>.<ext>` for analytics tables and
//   `<site>/<dataset>.<ext>` for entity datasets.
// - `sqlite` and `duckdb` write one database file with one table per dataset.
//   Each table holds every Site and search type, told apart by the `site` and
//   `search_type` columns.

import type { DuckDBConnection } from '@duckdb/node-api'
import type { ColumnDef } from '@gscdump/engine/schema'
import type { SearchType } from 'gscdump/query'
import type { EntityDatasetRows } from './local-entities'
import type { TableSource } from './table-sources'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { encodeRowsToParquetFlex } from '@gscdump/engine/hyparquet'
import { exportColumns, readParquetSql, sourceSelectSql, sqlString } from './table-sources'

export const DUMP_FORMATS = ['parquet', 'csv', 'json', 'ndjson', 'sqlite', 'duckdb'] as const
export type DumpFormat = typeof DUMP_FORMATS[number]

export function isDumpFormat(value: string): value is DumpFormat {
  return (DUMP_FORMATS as readonly string[]).includes(value)
}

/** One dataset written for one Site (and one search type for analytics tables). */
export interface DumpedDataset {
  /** Analytics table or entity dataset name. In a database file, also the table name. */
  dataset: string
  /** Search type of an analytics table. Entity datasets have none. */
  searchType?: SearchType
  /** Absolute path of the file that holds the rows. */
  path: string
  rows: number
}

export interface WrittenFile {
  path: string
  bytes: number
}

export interface DumpSink {
  writeTable: (source: TableSource) => Promise<DumpedDataset>
  writeEntity: (site: string, dataset: EntityDatasetRows) => Promise<DumpedDataset>
  /** Finish every write and list the files with their sizes. */
  close: () => Promise<WrittenFile[]>
}

/** Directory name for a Site URL inside a dump. */
export function siteDirName(siteUrl: string): string {
  return siteUrl.replace(/[^a-z0-9]+/gi, '_')
}

/**
 * One directory per Site for the whole dump. `siteDirName` is lossy, so two
 * Site URLs can sanitize to the same name (https://x.com/a-b and
 * https://x.com/a_b). A colliding Site appends a short hash of its exact URL,
 * so every Site keeps its own files.
 */
export function createSiteDirNamer(): (siteUrl: string) => string {
  const dirBySite = new Map<string, string>()
  return (siteUrl) => {
    const known = dirBySite.get(siteUrl)
    if (known !== undefined)
      return known
    const base = siteDirName(siteUrl)
    const dir = [...dirBySite.values()].includes(base)
      ? `${base}_${createHash('sha256').update(siteUrl).digest('hex').slice(0, 8)}`
      : base
    dirBySite.set(siteUrl, dir)
    return dir
  }
}

/** Database file that a `sqlite` or `duckdb` dump writes into the output directory. */
export function databasePath(outDir: string, format: 'sqlite' | 'duckdb'): string {
  return path.join(outDir, `gscdump.${format}`)
}

const COPY_OPTIONS: Record<FileFormat, string> = {
  parquet: 'FORMAT parquet, COMPRESSION zstd',
  csv: 'FORMAT csv, HEADER true',
  json: 'FORMAT json, ARRAY true',
  ndjson: 'FORMAT json',
}

type FileFormat = Exclude<DumpFormat, 'sqlite' | 'duckdb'>

const SQLITE_TYPES: Record<ColumnDef['type'], string> = {
  VARCHAR: 'TEXT',
  DATE: 'TEXT',
  INTEGER: 'INTEGER',
  BIGINT: 'INTEGER',
  DOUBLE: 'REAL',
}

interface Session {
  connection: DuckDBConnection
  tempDir: string
  close: () => Promise<void>
}

async function openSession(): Promise<Session> {
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-dump-'))
  return {
    connection,
    tempDir,
    async close() {
      connection.closeSync()
      instance.closeSync()
      await fs.rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function countOf(connection: DuckDBConnection, sql: string): Promise<number> {
  const reader = await connection.runAndReadAll(sql)
  return Number(reader.getRowsJS()[0]?.[0] ?? 0)
}

async function presentColumns(connection: DuckDBConnection, source: TableSource): Promise<Set<string>> {
  const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${readParquetSql(source.files)}`)
  return new Set(reader.getRowObjectsJS().map(row => String(row.column_name)))
}

/**
 * Entity rows are already in memory. Write them to a temporary Parquet file so
 * every format reads them through the same DuckDB path as analytics tables.
 */
async function entitySelect(session: Session, site: string, dataset: EntityDatasetRows): Promise<string> {
  const file = path.join(session.tempDir, `${siteDirName(site)}-${dataset.dataset}.parquet`)
  await fs.writeFile(file, encodeRowsToParquetFlex(dataset.rows, { columns: dataset.columns }))
  const columns = dataset.columns.map(column => column.name).join(', ')
  return `SELECT ${sqlString(site)} AS site, ${columns} FROM read_parquet(${sqlString(file)})`
}

function entityColumns(dataset: EntityDatasetRows): ColumnDef[] {
  return [{ name: 'site', type: 'VARCHAR', nullable: false }, ...dataset.columns]
}

export async function openDumpSink(outDir: string, format: DumpFormat): Promise<DumpSink> {
  await fs.mkdir(outDir, { recursive: true })
  if (format === 'sqlite')
    return openSqliteSink(outDir)
  if (format === 'duckdb')
    return openDuckDBSink(outDir)
  return openFileSink(outDir, format)
}

async function openFileSink(outDir: string, format: FileFormat): Promise<DumpSink> {
  const session = await openSession()
  const written: string[] = []
  const siteDir = createSiteDirNamer()
  const copy = async (select: string, target: string): Promise<number> => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const rows = await countOf(session.connection, `COPY (${select}) TO ${sqlString(target)} (${COPY_OPTIONS[format]})`)
    written.push(target)
    return rows
  }
  // Row formats get a per-row `position`. Parquet keeps `sum_position` only, like the SQL views.
  const position = format !== 'parquet'
  return {
    async writeTable(source) {
      const select = sourceSelectSql(source, await presentColumns(session.connection, source), { position, dates: 'date' })
      const target = path.join(outDir, siteDir(source.site), source.searchType, `${source.table}.${format}`)
      return { dataset: source.table, searchType: source.searchType, path: target, rows: await copy(select, target) }
    },
    async writeEntity(site, dataset) {
      const target = path.join(outDir, siteDir(site), `${dataset.dataset}.${format}`)
      return { dataset: dataset.dataset, path: target, rows: await copy(await entitySelect(session, site, dataset), target) }
    },
    async close() {
      await session.close()
      return Promise.all(written.map(async file => ({ path: file, bytes: (await fs.stat(file)).size })))
    },
  }
}

async function openDuckDBSink(outDir: string): Promise<DumpSink> {
  const target = databasePath(outDir, 'duckdb')
  await fs.rm(target, { force: true })
  await fs.rm(`${target}.wal`, { force: true })
  const session = await openSession()
  await session.connection.run(`ATTACH ${sqlString(target)} AS out`)
  const created = new Set<string>()
  const insert = async (name: string, columns: readonly ColumnDef[], select: string): Promise<number> => {
    if (!created.has(name)) {
      const ddl = columns.map(column => `${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join(', ')
      await session.connection.run(`CREATE TABLE out.${name} (${ddl})`)
      created.add(name)
    }
    return countOf(session.connection, `INSERT INTO out.${name} BY NAME ${select}`)
  }
  return {
    async writeTable(source) {
      const select = sourceSelectSql(source, await presentColumns(session.connection, source), { position: false, dates: 'date' })
      return { dataset: source.table, searchType: source.searchType, path: target, rows: await insert(source.table, exportColumns(source.table), select) }
    },
    async writeEntity(site, dataset) {
      return { dataset: dataset.dataset, path: target, rows: await insert(dataset.dataset, entityColumns(dataset), await entitySelect(session, site, dataset)) }
    },
    async close() {
      await session.connection.run('DETACH out')
      await session.close()
      return [{ path: target, bytes: (await fs.stat(target)).size }]
    },
  }
}

function sqliteValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined)
    return null
  if (typeof value === 'boolean')
    return value ? 1 : 0
  if (value instanceof Date)
    return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
    return value
  return JSON.stringify(value)
}

async function openSqliteSink(outDir: string): Promise<DumpSink> {
  const target = databasePath(outDir, 'sqlite')
  await fs.rm(target, { force: true })
  // node:sqlite loads only for this format: it needs Node 22.13 or later, and
  // the rest of the CLI must still start without it.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(target)
  const session = await openSession()
  const created = new Set<string>()
  const insert = async (name: string, columns: readonly ColumnDef[], select: string): Promise<number> => {
    if (!created.has(name)) {
      const ddl = columns.map(column => `"${column.name}" ${SQLITE_TYPES[column.type]}${column.nullable ? '' : ' NOT NULL'}`).join(', ')
      db.exec(`CREATE TABLE "${name}" (${ddl})`)
      created.add(name)
    }
    const statement = db.prepare(`INSERT INTO "${name}" (${columns.map(column => `"${column.name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    const result = await session.connection.stream(`SELECT ${columns.map(column => column.name).join(', ')} FROM (${select})`)
    let rows = 0
    db.exec('BEGIN')
    try {
      for await (const chunk of result.yieldRowsJs()) {
        for (const row of chunk) {
          statement.run(...row.map(sqliteValue))
          rows++
        }
      }
      db.exec('COMMIT')
    }
    catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return rows
  }
  return {
    async writeTable(source) {
      const select = sourceSelectSql(source, await presentColumns(session.connection, source), { position: false, dates: 'iso' })
      return { dataset: source.table, searchType: source.searchType, path: target, rows: await insert(source.table, exportColumns(source.table), select) }
    },
    async writeEntity(site, dataset) {
      return { dataset: dataset.dataset, path: target, rows: await insert(dataset.dataset, entityColumns(dataset), await entitySelect(session, site, dataset)) }
    },
    async close() {
      db.close()
      await session.close()
      return [{ path: target, bytes: (await fs.stat(target)).size }]
    },
  }
}
