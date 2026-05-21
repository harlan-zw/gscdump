// Pure-JS ParquetCodec backed by hyparquet (read) and hyparquet-writer (write).
// No DuckDB-WASM dependency, edge-safe (Cloudflare Workers, Deno, browsers).
//
// Trade-offs vs. the DuckDB-WASM codec:
// - No monotonic linear-memory growth. DuckDB-WASM leaks memory across
//   writes/compactions; this encoder allocates and releases per-call.
// - Smaller runtime (~200 KB gzipped vs. ~5 MB WASM).
// - Slower on large reads: hyparquet is JS, DuckDB is native via httpfs.
//   Use this codec for writes + compaction; keep DuckDB for ad-hoc query I/O.
//
// Output invariant: column set + logical types MUST round-trip through
// DuckDB's `read_parquet([..., ...], union_by_name = true)` identically to
// DuckDB-written files. `date` lands as VARCHAR (BYTE_ARRAY/UTF8) because
// rows carry ISO strings; INTEGER → INT32; BIGINT → INT64; DOUBLE → DOUBLE.

import type { AsyncBuffer, ParquetQueryFilter } from 'hyparquet'
import type { BasicType, ColumnSource } from 'hyparquet-writer'
import type { ColumnDef, ColumnType } from '../schema'
import type {
  CodecCtx,
  DataSource,
  ParquetCodec,
  Row,
  TableName,
  WriteResult,
} from '../storage'
import { parquetReadObjects } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { dedupeByNaturalKey, SCHEMAS, TABLE_METADATA } from '../schema'

// 25k rows/group keeps a typical day file in 2-10 row groups so DuckDB's
// stats-based row-group pruning has something to skip. The hyparquet-writer
// default of 100k yields one giant group for most days, which makes the
// declared `clusterKey` worthless at query time.
const ROW_GROUP_SIZE = 25000

function basicTypeFor(colType: ColumnType): BasicType {
  if (colType === 'VARCHAR' || colType === 'DATE')
    return 'STRING'
  if (colType === 'BIGINT')
    return 'INT64'
  if (colType === 'INTEGER')
    return 'INT32'
  if (colType === 'DOUBLE')
    return 'DOUBLE'
  throw new Error(`unsupported column type for parquet encoding: ${colType satisfies never}`)
}

function coerceValue(value: unknown, type: BasicType): unknown {
  if (value === null || value === undefined)
    return null
  if (type === 'STRING')
    return typeof value === 'string' ? value : String(value)
  if (type === 'INT32') {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n))
      throw new Error(`non-finite number for INT32: ${String(value)}`)
    return Math.trunc(n)
  }
  if (type === 'INT64') {
    if (typeof value === 'bigint')
      return value
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n))
      throw new Error(`non-finite number for INT64: ${String(value)}`)
    return BigInt(Math.trunc(n))
  }
  if (type === 'DOUBLE') {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n))
      throw new Error(`non-finite number for DOUBLE: ${String(value)}`)
    return n
  }
  return value
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b)
    return 0
  if (a === null || a === undefined)
    return -1
  if (b === null || b === undefined)
    return 1
  if (typeof a === 'number' && typeof b === 'number')
    return a - b
  return String(a) < String(b) ? -1 : 1
}

// Physical row order written into parquet. Uses `clusterKey` (dimension-first)
// rather than `sortKey` (natural-key identity, date-first) so the
// high-cardinality dimension column is contiguous — see TABLE_METADATA.
function sortRowsByClusterKey(table: TableName, rows: readonly Row[]): readonly Row[] {
  const clusterKey = TABLE_METADATA[table].clusterKey
  if (clusterKey.length === 0 || rows.length <= 1)
    return rows
  const copy = rows.slice()
  copy.sort((a, b) => {
    for (const col of clusterKey) {
      const cmp = compareValues(a[col], b[col])
      if (cmp !== 0)
        return cmp
    }
    return 0
  })
  return copy
}

export function encodeRowsToParquet(table: TableName, rows: readonly Row[]): Uint8Array {
  const schema = SCHEMAS[table]
  const sorted = sortRowsByClusterKey(table, rows)
  const columnData: ColumnSource[] = schema.columns.map((col) => {
    const type = basicTypeFor(col.type)
    const data = sorted.map(r => coerceValue(r[col.name], type))
    return {
      name: col.name,
      data,
      type,
      nullable: col.nullable,
      // Page-level statistics let DuckDB prune below the row-group granularity
      // for high-cardinality columns (url, query). Cheap to write, free to skip.
      columnIndex: true,
    }
  })
  const buffer = parquetWriteBuffer({ columnData, rowGroupSize: ROW_GROUP_SIZE })
  return new Uint8Array(buffer)
}

export interface EncodeFlexOptions {
  /** Columns defining the output schema + order. */
  columns: readonly ColumnDef[]
  /** Sort key columns (subset of `columns` by name). Empty = preserve input order. */
  sortKey?: readonly string[]
  /** Row-group size; smaller groups = more prunable DuckDB stats. Default 25000. */
  rowGroupSize?: number
}

/**
 * Schema-free encoder for rollups + auxiliary tables whose column set isn't
 * in `SCHEMAS`. Caller supplies column definitions; types must be one of
 * `VARCHAR | DATE | BIGINT | INTEGER | DOUBLE` — same physical mappings as
 * the canonical encoder so DuckDB `read_parquet(union_by_name = true)`
 * merges cleanly with fact-table reads.
 */
export function encodeRowsToParquetFlex(rows: readonly Row[], opts: EncodeFlexOptions): Uint8Array {
  const { columns, sortKey = [], rowGroupSize = ROW_GROUP_SIZE } = opts
  const sorted = sortKey.length === 0 || rows.length <= 1
    ? rows
    : [...rows].sort((a, b) => {
        for (const col of sortKey) {
          const cmp = compareValues(a[col], b[col])
          if (cmp !== 0)
            return cmp
        }
        return 0
      })
  const columnData: ColumnSource[] = columns.map((col) => {
    const type = basicTypeFor(col.type)
    const data = sorted.map(r => coerceValue(r[col.name], type))
    return {
      name: col.name,
      data,
      type,
      nullable: col.nullable,
      columnIndex: true,
    }
  })
  const buffer = parquetWriteBuffer({ columnData, rowGroupSize })
  return new Uint8Array(buffer)
}

function asyncBufferFromBytes(bytes: Uint8Array): AsyncBuffer {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return {
    byteLength: ab.byteLength,
    slice(start: number, end?: number) {
      return ab.slice(start, end)
    },
  }
}

export interface DecodeParquetOptions {
  /**
   * Row filter pushed down into the parquet reader. hyparquet evaluates this
   * per row group — pruning groups whose column statistics can't match and
   * materialising only matching rows — so a filtered decode of a large file
   * holds at most one row group plus the matches in memory, never the whole
   * file. Use this whenever the caller needs a sub-slice of a big parquet
   * (e.g. one feedpath out of a site-wide sitemap-urls index).
   */
  filter?: ParquetQueryFilter
}

export async function decodeParquetToRows(
  bytes: Uint8Array,
  opts: DecodeParquetOptions = {},
): Promise<Row[]> {
  if (bytes.byteLength === 0)
    return []
  const rows = await parquetReadObjects({
    file: asyncBufferFromBytes(bytes),
    ...(opts.filter ? { filter: opts.filter } : {}),
  })
  return rows as Row[]
}

export interface HyparquetCodecOptions {
  /**
   * Override `readRows`. Useful when reads should be delegated to a faster
   * engine (e.g. DuckDB-WASM via httpfs) while writes + compaction stay on
   * hyparquet to avoid WASM linear-memory growth. Defaults to hyparquet.
   */
  readRows?: (ctx: CodecCtx, key: string, dataSource: DataSource) => Promise<Row[]>
}

export function createHyparquetCodec(options: HyparquetCodecOptions = {}): ParquetCodec {
  const readRows = options.readRows ?? (async (_ctx, key, dataSource) => {
    const bytes = await dataSource.read(key)
    return decodeParquetToRows(bytes)
  })

  return {
    async writeRows(ctx: CodecCtx, rows: readonly Row[], key: string, dataSource: DataSource): Promise<WriteResult> {
      const bytes = encodeRowsToParquet(ctx.table, rows)
      await dataSource.write(key, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },

    readRows,

    async compactRows(
      ctx: CodecCtx,
      inputKeys: string[],
      outputKey: string,
      dataSource: DataSource,
    ): Promise<WriteResult> {
      if (inputKeys.length === 0) {
        const bytes = encodeRowsToParquet(ctx.table, [])
        await dataSource.write(outputKey, bytes)
        return { bytes: bytes.byteLength, rowCount: 0 }
      }
      const allRows: Row[] = []
      for (const key of inputKeys) {
        const input = await dataSource.read(key)
        const rows = await decodeParquetToRows(input)
        allRows.push(...rows)
      }
      // Recurrence guard: correct compaction inputs own disjoint natural keys,
      // but a duplicated-row regression must not survive a merge — collapse
      // any natural-key collision before encoding. See dedupeByNaturalKey.
      const rows = dedupeByNaturalKey(ctx.table, allRows)
      const bytes = encodeRowsToParquet(ctx.table, rows)
      await dataSource.write(outputKey, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },
  }
}
