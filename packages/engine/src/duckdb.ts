// DuckDB-backed codec + executor, edge-compatible. Consumers (CLI, Workers)
// supply a DuckDBHandle backed by whatever loader fits their runtime —
// async-over-worker in browsers, native bindings in Node.
//
// This file is the *virtual-FS* implementation: rows ↔ Parquet bytes round-
// trip through DuckDB's in-memory FS, then through `dataSource.read`/`.write`.
// Workers backends that prefer DuckDB-driven I/O (httpfs over R2) ship their
// own codec/executor pair instead of this one.

import type {
  CodecCtx,
  DataSource,
  ParquetCodec,
  QueryExecutor,
  Row,
  TableName,
  WriteResult,
} from './storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { coerceRows } from './coerce'
import { substituteNamedFiles } from './parquet-plan'
import { dateColumnsFor, SCHEMAS, TABLE_METADATA } from './schema'
import { sqlEscape } from './sql-bind'
import { dateReplaceClause as buildDateReplaceClause } from './sql-fragments'

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

const DEFAULT_BUFFER_READ_CONCURRENCY = 16
const MAX_BUFFER_READ_CONCURRENCY = 64

export interface DuckDBReadOptions {
  /**
   * Maximum non-URI parquet reads held in flight while registering DuckDB
   * buffers. Defaults to 16; callers handling unusually large files can lower
   * it to trade latency for peak JS memory.
   */
  bufferReadConcurrency?: number
}

function bufferReadConcurrency(value: number | undefined, fileCount: number): number {
  const requested = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_BUFFER_READ_CONCURRENCY
  return Math.max(1, Math.min(fileCount || 1, requested, MAX_BUFFER_READ_CONCURRENCY))
}

async function registerBufferedFiles(
  db: DuckDBHandle,
  files: readonly { key: string, name: string }[],
  dataSource: DataSource,
  registered: string[],
  signal?: AbortSignal,
  maxConcurrency?: number,
): Promise<void> {
  const batchSize = bufferReadConcurrency(maxConcurrency, files.length)
  for (let i = 0; i < files.length; i += batchSize) {
    signal?.throwIfAborted()
    const batch = files.slice(i, i + batchSize)
    const buffers = await Promise.all(
      batch.map(file => dataSource.read(file.key, undefined, signal)),
    )
    for (let j = 0; j < batch.length; j++) {
      signal?.throwIfAborted()
      const file = batch[j]!
      await db.registerFileBuffer(file.name, buffers[j]!)
      registered.push(file.name)
    }
  }
}

async function encodeBytes(
  db: DuckDBHandle,
  table: TableName,
  rows: Row[],
): Promise<Uint8Array> {
  const inName = db.makeTempPath('json')
  const outName = db.makeTempPath('parquet')
  // Rows crossing a source boundary are already number-coerced, but this codec
  // can be handed computed rows directly — coerce defensively so a stray int64
  // aggregate serializes as a number (not a crash) into the typed parquet copy.
  const jsonBytes = encodeJsonBigintSafe(coerceRows(rows))
  const registered: string[] = []
  await db.registerFileBuffer(inName, jsonBytes)
  registered.push(inName)
  try {
    const sql = rows.length === 0
      ? `COPY (SELECT * FROM ${emptyTableSchema(table)} WHERE FALSE) TO '${sqlEscape(outName)}' (FORMAT PARQUET, COMPRESSION ZSTD)`
      : `COPY (SELECT * FROM read_json_auto('${sqlEscape(inName)}', format='array', columns=${columnsJson(table)})) TO '${sqlEscape(outName)}' (FORMAT PARQUET, COMPRESSION ZSTD)`
    await db.query(sql)
    registered.push(outName)
    return await db.copyFileToBuffer(outName)
  }
  finally {
    await db.dropFiles(registered)
  }
}

async function decodeBytes(
  db: DuckDBHandle,
  bytes: Uint8Array,
  table: TableName | undefined,
): Promise<Row[]> {
  const name = db.makeTempPath('parquet')
  await db.registerFileBuffer(name, bytes)
  try {
    return await db.query(
      `SELECT * ${dateReplaceClause(table)} FROM read_parquet('${sqlEscape(name)}')`,
    )
  }
  finally {
    await db.dropFiles([name])
  }
}

export function createDuckDBCodec(factory: DuckDBFactory, options: DuckDBReadOptions = {}): ParquetCodec {
  return {
    async writeRows(ctx: CodecCtx, rows: Row[], key: string, dataSource: DataSource): Promise<WriteResult> {
      const db = await factory.getDuckDB()
      const bytes = await encodeBytes(db, ctx.table, rows)
      await dataSource.write(key, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },

    async readRows(ctx: CodecCtx, key: string, dataSource: DataSource): Promise<Row[]> {
      const db = await factory.getDuckDB()
      const bytes = await dataSource.read(key)
      return decodeBytes(db, bytes, ctx.table)
    },

    async compactRows(
      ctx: CodecCtx,
      inputKeys: string[],
      outputKey: string,
      dataSource: DataSource,
    ): Promise<WriteResult> {
      const db = await factory.getDuckDB()
      if (inputKeys.length === 0) {
        const bytes = await encodeBytes(db, ctx.table, [])
        await dataSource.write(outputKey, bytes)
        return { bytes: bytes.byteLength, rowCount: 0 }
      }

      const inputUris = inputKeys.map(k => dataSource.uri?.(k))
      const allInputsResolvable = inputUris.every(u => u !== undefined)

      // URI-read fast path: DuckDB fetches inputs through its native URI
      // layer (httpfs / native FS) without materialising bytes in JS. Output
      // still round-trips through the virtual FS + dataSource.write so the
      // adapter owns directory creation and auth-signed URLs stay internal.
      if (allInputsResolvable) {
        const outName = db.makeTempPath('parquet')
        const fileList = (inputUris as string[])
          .map(u => `'${sqlEscape(u)}'`)
          .join(', ')
        try {
          await db.query(
            `COPY (${dedupedMergeSql(ctx.table, fileList)}) TO '${sqlEscape(outName)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
          )
          const bytes = await db.copyFileToBuffer(outName)
          const countRows = await db.query(
            `SELECT count(*)::BIGINT AS n FROM read_parquet('${sqlEscape(outName)}')`,
          ) as Array<{ n: number | bigint }>
          const rowCount = Number(countRows[0]?.n ?? 0)
          await dataSource.write(outputKey, bytes)
          return { bytes: bytes.byteLength, rowCount }
        }
        finally {
          await db.dropFiles([outName])
        }
      }

      const inNames: string[] = []
      const outName = db.makeTempPath('parquet')
      const registered: string[] = []
      const bufferedInputs = inputKeys.map((key) => {
        const name = db.makeTempPath('parquet')
        inNames.push(name)
        return { key, name }
      })

      try {
        await registerBufferedFiles(db, bufferedInputs, dataSource, registered, undefined, options.bufferReadConcurrency)
        const fileList = inNames.map(n => `'${sqlEscape(n)}'`).join(', ')
        // DuckDB streams read_parquet → COPY without materialising all rows in
        // memory. Matches the read path. `union_by_name` lets us merge files
        // with column-additive schema drift without a binder error.
        await db.query(
          `COPY (${dedupedMergeSql(ctx.table, fileList)}) TO '${sqlEscape(outName)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        )
        registered.push(outName)
        const bytes = await db.copyFileToBuffer(outName)
        const countRows = await db.query(
          `SELECT count(*)::BIGINT AS n FROM read_parquet('${sqlEscape(outName)}')`,
        ) as Array<{ n: number | bigint }>
        const rowCount = Number(countRows[0]?.n ?? 0)
        await dataSource.write(outputKey, bytes)
        return { bytes: bytes.byteLength, rowCount }
      }
      finally {
        await db.dropFiles(registered)
      }
    },
  }
}

const quoteCol = (c: string): string => `"${c.replace(/"/g, '""')}"`

/**
 * SELECT body that merges parquet inputs and collapses any natural-key
 * collision to a single row.
 *
 * Correct tiered-compaction inputs own disjoint natural keys (each daily/
 * weekly/monthly bucket covers distinct dates), so the `QUALIFY` is a no-op
 * on healthy data. It exists as a recurrence guard: the 2026-04 monthly
 * compaction corruption merged a complete month back onto its own daily
 * inputs, doubling every row. `union_by_name` tolerates additive schema drift.
 *
 * The survivors are emitted in `clusterKey` (dimension-first) order so the
 * compacted file is GLOBALLY clustered, not just clustered within each input
 * file's block. Daily inputs are each internally cluster-sorted by the encoder
 * (`sortRowsByClusterKey`), but concatenating them interleaves every day's
 * dimension values across the merged file's row groups — which both defeats
 * row-group skipping for point lookups (`WHERE url = …`) and scatters repeated
 * dimension values so the writer's dictionary/RLE runs stay short. Re-sorting
 * on merge restores both: measured on real page_keywords data, a single
 * compacted file shrinks ~28% and a url-filtered query runs ~2.4x faster.
 */
function dedupedMergeSql(table: TableName, fileListSql: string): string {
  const base = `SELECT * FROM read_parquet([${fileListSql}], union_by_name = true)`
  const sortKey = SCHEMAS[table].sortKey
  const clusterKey = TABLE_METADATA[table].clusterKey
  const dedup = sortKey.length === 0
    ? base
    : `${base} QUALIFY row_number() OVER (PARTITION BY ${sortKey.map(quoteCol).join(', ')}) = 1`
  if (clusterKey.length === 0)
    return dedup
  return `${dedup} ORDER BY ${clusterKey.map(quoteCol).join(', ')}`
}

/**
 * Replace every `read_parquet({{NAME}}, union_by_name = true)` occurrence
 * (any whitespace, any `union_by_name` variant) with a schema-correct
 * empty subquery when the named file set has no keys. Without this,
 * DuckDB errors with a Binder Error on `read_parquet([])` because it
 * can't infer the schema from an empty literal. Analyzers that use
 * `{{FILES_PREV}}` against a prev-window that happens to have no parquets
 * (e.g. movers/decay run on fresh data) hit this without the fallback.
 */
function rewriteEmptyFileSets(
  sql: string,
  placeholders: Record<string, string[]>,
  defaultTable: TableName,
  placeholderTables?: Record<string, TableName>,
): string {
  let out = sql
  for (const [name, keys] of Object.entries(placeholders)) {
    if (keys.length > 0)
      continue
    const tableForName = placeholderTables?.[name] ?? defaultTable
    const emptyFallback = `(SELECT * FROM ${emptyTableSchema(tableForName)} WHERE FALSE)`
    const pattern = new RegExp(
      `read_parquet\\(\\s*\\{\\{${name}\\}\\}\\s*(?:,\\s*union_by_name\\s*=\\s*true\\s*)?\\)`,
      'g',
    )
    out = out.replace(pattern, emptyFallback)
  }
  return out
}

export function createDuckDBExecutor(factory: DuckDBFactory, options: DuckDBReadOptions = {}): QueryExecutor {
  return {
    async execute({ sql, params, fileKeys, placeholderTables, dataSource, table, signal, profiler }) {
      signal?.throwIfAborted()
      const db = await factory.getDuckDB()

      const placeholders: Record<string, string[]> = {}
      const registered: string[] = []

      const totalFiles = Object.values(fileKeys).reduce((n, keys) => n + keys.length, 0)
      const endRegister = profiler?.start('files.register', { files: totalFiles })
      // Resolve every placeholder's keys: a native URI is free (DuckDB reads it
      // directly), a non-URI key must be fetched + registered into the vFS. The
      // buffer reads are independent, so they run concurrently — a serial loop
      // costs N × per-read latency, which on a remote DataSource (R2 without a
      // `bucketName`, where each read is an object GET) is O(seconds) for a
      // multi-file query. Reads are batched so a large remote file set doesn't
      // also retain every Uint8Array in JS while DuckDB already owns registered
      // vFS buffers. Mirrors `compactRows` above.
      try {
        const bufferedByName = new Map<string, { key: string, name: string }>()
        for (const [name, keys] of Object.entries(fileKeys)) {
          const resolved: string[] = []
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i]!
            const uri = dataSource.uri?.(key)
            if (uri !== undefined) {
              resolved.push(uri)
            }
            else {
              // One object can appear in multiple placeholders (for example a
              // current window and a broader comparison window). Registering
              // it once is sufficient because every placeholder uses the same
              // vFS name; avoid duplicate GETs and duplicate registrations.
              let buffered = bufferedByName.get(key)
              if (!buffered) {
                buffered = { key, name: db.makeTempPath('parquet') }
                bufferedByName.set(key, buffered)
              }
              resolved.push(buffered.name)
            }
          }
          placeholders[name] = resolved
        }
        // Apply the concurrency ceiling across the whole query, not once per
        // placeholder. Otherwise a query with four file sets could hold 4x the
        // documented number of remote reads and buffers in flight.
        await registerBufferedFiles(
          db,
          [...bufferedByName.values()],
          dataSource,
          registered,
          signal,
          options.bufferReadConcurrency,
        )
        // `buffered` is the count that took the read+register path (the rest
        // resolved to a native URI for free).
        endRegister?.({ buffered: registered.length })
        signal?.throwIfAborted()
        const rewritten = rewriteEmptyFileSets(sql, placeholders, table, placeholderTables)
        const finalSql = substituteNamedFiles(rewritten, placeholders)
        const endQuery = profiler?.start('query.run')
        const rows = await db.query(finalSql, params)
        endQuery?.({ rows: rows.length })
        return { rows, sql: finalSql }
      }
      finally {
        if (registered.length > 0)
          await db.dropFiles(registered)
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
  // Row decode emits ISO `YYYY-MM-DD` strings (the `'string'` form) so the
  // values round-trip cleanly through JSON / Workers RPC. The clause itself is
  // built by the shared fragment so every read path agrees on the SQL.
  return buildDateReplaceClause(dateColumnsFor(table), 'string')
}

function columnList(table: TableName): string {
  return SCHEMAS[table].columns.map(c => c.name).join(', ')
}

function placeholderValues(table: TableName): string {
  const defaults = SCHEMAS[table].columns.map(c => defaultForType(c.type))
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
  const entries = SCHEMAS[table].columns.map(c => `'${c.name}': '${c.type}'`)
  return `{${entries.join(', ')}}`
}
