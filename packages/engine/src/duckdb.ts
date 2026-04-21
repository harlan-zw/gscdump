// DuckDB-backed codec + executor, edge-compatible. Consumers (CLI, Workers)
// supply a DuckDBHandle backed by whatever loader fits their runtime —
// async-over-worker in browsers, blocking-node bindings in Node.
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
import { substituteNamedFiles } from './compiler'
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

async function encodeBytes(
  db: DuckDBHandle,
  table: TableName,
  rows: Row[],
): Promise<Uint8Array> {
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

export function createDuckDBCodec(factory: DuckDBFactory): ParquetCodec {
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
            `COPY (SELECT * FROM read_parquet([${fileList}], union_by_name=true)) TO '${sqlEscape(outName)}' (FORMAT PARQUET)`,
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

      const inputs = await Promise.all(inputKeys.map(k => dataSource.read(k)))
      const inNames: string[] = []
      const outName = db.makeTempPath('parquet')
      const registered: string[] = []
      for (let i = 0; i < inputs.length; i++) {
        const name = db.makeTempPath('parquet')
        await db.registerFileBuffer(name, inputs[i]!)
        inNames.push(name)
        registered.push(name)
      }

      try {
        const fileList = inNames.map(n => `'${sqlEscape(n)}'`).join(', ')
        // DuckDB streams read_parquet → COPY without materialising all rows in
        // memory. Matches the read path.
        await db.query(
          `COPY (SELECT * FROM read_parquet([${fileList}])) TO '${sqlEscape(outName)}' (FORMAT PARQUET)`,
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
  table: TableName,
): string {
  const emptyFallback = `(SELECT * FROM ${emptyTableSchema(table)} WHERE FALSE)`
  let out = sql
  for (const [name, keys] of Object.entries(placeholders)) {
    if (keys.length > 0)
      continue
    const pattern = new RegExp(
      `read_parquet\\(\\s*\\{\\{${name}\\}\\}\\s*(?:,\\s*union_by_name\\s*=\\s*true\\s*)?\\)`,
      'g',
    )
    out = out.replace(pattern, emptyFallback)
  }
  return out
}

export function createDuckDBExecutor(factory: DuckDBFactory): QueryExecutor {
  return {
    async execute({ sql, params, fileKeys, dataSource, table, signal }) {
      signal?.throwIfAborted()
      const db = await factory.getDuckDB()

      const placeholders: Record<string, string[]> = {}
      const registered: string[] = []

      for (const [name, keys] of Object.entries(fileKeys)) {
        const resolved: string[] = []
        for (const key of keys) {
          const uri = dataSource.uri?.(key)
          if (uri !== undefined) {
            resolved.push(uri)
          }
          else {
            const bytes = await dataSource.read(key, undefined, signal)
            await db.registerFileBuffer(key, bytes)
            registered.push(key)
            resolved.push(key)
          }
        }
        placeholders[name] = resolved
      }

      try {
        signal?.throwIfAborted()
        const rewritten = rewriteEmptyFileSets(sql, placeholders, table)
        const finalSql = substituteNamedFiles(rewritten, placeholders)
        const rows = await db.query(finalSql, params)
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

/**
 * Canonical "empty-file" SELECT clause for a table. Codecs that need to
 * emit a schema-correct empty Parquet can wrap this in:
 *   `COPY (SELECT * FROM <clause> WHERE FALSE) TO '<key>' (FORMAT PARQUET)`
 * to satisfy the ParquetCodec empty-rows invariant.
 */
export function canonicalEmptyParquetSchema(table: TableName): string {
  return emptyTableSchema(table)
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
