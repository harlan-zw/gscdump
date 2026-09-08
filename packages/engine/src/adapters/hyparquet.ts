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
// DuckDB-written files. `date` lands as a native parquet DATE (INT32 +
// converted_type DATE), matching the DuckDB codec + the icebird/Iceberg path —
// rows carry ISO strings on the way in (converted to int-days at encode) and
// back out (the reader's JS `Date` is normalised to `YYYY-MM-DD` on decode).
// INTEGER → INT32; BIGINT → INT64; DOUBLE → DOUBLE; VARCHAR → BYTE_ARRAY/UTF8.

import type { AsyncBuffer, ParquetQueryFilter, SchemaElement } from 'hyparquet'
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
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'
import { ByteWriter, parquetWriteRows } from 'hyparquet-writer'
import { SCHEMAS, TABLE_METADATA } from '../schema'

// 25k rows/group keeps a typical day file in 2-10 row groups so DuckDB's
// stats-based row-group pruning has something to skip. The hyparquet-writer
// default of 100k yields one giant group for most days, which makes the
// declared `clusterKey` worthless at query time.
const ROW_GROUP_SIZE = 25000
const DEFAULT_COMPACTION_READ_CONCURRENCY = 8
const MAX_COMPACTION_READ_CONCURRENCY = 32

// Non-DATE physical type. DATE is handled out-of-band (see `buildWriteSchema` +
// `toEpochDays`) because hyparquet-writer has no DATE `BasicType` — a real
// parquet DATE needs an explicit `SchemaElement` (INT32 + converted_type DATE).
function basicTypeFor(colType: ColumnType): BasicType {
  if (colType === 'VARCHAR')
    return 'STRING'
  if (colType === 'BIGINT')
    return 'INT64'
  if (colType === 'INTEGER')
    return 'INT32'
  if (colType === 'DOUBLE')
    return 'DOUBLE'
  if (colType === 'DATE')
    return 'INT32' // unreachable in encode (DATE takes the schema-override path)
  throw new Error(`unsupported column type for parquet encoding: ${colType satisfies never}`)
}

const EPOCH_DAY_MS = 86_400_000

/**
 * Convert a `date` value to the INT32 "days since the Unix epoch" a parquet
 * DATE column stores. Mirrors the icebird append path (`toIcebergDate`): an ISO
 * `YYYY-MM-DD` string is parsed at UTC midnight, a `Date` is floored to whole
 * days, and an already-numeric day-count passes through. Passing the int (never
 * a `Date`) keeps hyparquet-writer on its plain-number path — a dictionary-
 * encoded `Date` column is mis-encoded by the writer (NULLs on read-back).
 */
function toEpochDays(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  if (typeof value === 'number')
    return value
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      throw new TypeError('encodeRowsToParquet: invalid Date for DATE column')
    return Math.floor(ms / EPOCH_DAY_MS)
  }
  if (typeof value === 'string') {
    const ms = Date.parse(`${value}T00:00:00Z`)
    if (Number.isNaN(ms))
      throw new TypeError(`encodeRowsToParquet: invalid date string '${value}'`)
    return Math.floor(ms / EPOCH_DAY_MS)
  }
  throw new TypeError(`encodeRowsToParquet: unsupported DATE value '${String(value)}'`)
}

/**
 * Format the reader's UTC-midnight `Date` (from `dateFromDays`) back to the ISO
 * `YYYY-MM-DD` string the codec contract carries. Uses UTC components because
 * the DATE physical value is `days * 86_400_000` ms at UTC midnight.
 */
function isoFromDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build the explicit `SchemaElement[]` for `parquetWriteRows`. Mirrors
 * hyparquet-writer's own `basicTypeToSchemaElement` for the scalar types, plus
 * the one case it can't express via `BasicType`: a DATE column as INT32 +
 * `converted_type: 'DATE'`. Passing the schema makes the writer encode every
 * column from these elements (looked up by name), so the per-column specs only
 * carry name + index/null flags.
 */
function buildWriteSchema(columns: readonly ColumnDef[]): SchemaElement[] {
  const schema: SchemaElement[] = [{ name: 'root', num_children: columns.length }]
  for (const col of columns) {
    const repetition_type = col.nullable ? 'OPTIONAL' : 'REQUIRED'
    switch (col.type) {
      case 'DATE':
        schema.push({ name: col.name, type: 'INT32', converted_type: 'DATE', repetition_type })
        break
      case 'VARCHAR':
        schema.push({ name: col.name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type })
        break
      case 'INTEGER':
        schema.push({ name: col.name, type: 'INT32', repetition_type })
        break
      case 'BIGINT':
        schema.push({ name: col.name, type: 'INT64', repetition_type })
        break
      case 'DOUBLE':
        schema.push({ name: col.name, type: 'DOUBLE', repetition_type })
        break
    }
  }
  return schema
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

function naturalKeyHash(key: readonly string[], row: Row): number {
  let hash = 2166136261
  for (const column of key) {
    const value = String(row[column] ?? '')
    for (let i = 0; i < value.length; i++)
      hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
    hash = Math.imul(hash, 16777619)
  }
  // Keep numeric keys small. Collisions are resolved by comparing every field.
  return hash & 0x3FFFFFFF
}

function sameNaturalKey(key: readonly string[], a: Row, b: Row): boolean {
  return key.every(column => String(a[column] ?? '') === String(b[column] ?? ''))
}

type RowBucket = Row | Row[] | Map<string, Row>

function naturalKeyTuple(key: readonly string[], row: Row): string {
  return JSON.stringify(key.map(column => String(row[column] ?? '')))
}

// Numeric hashes avoid retaining a joined string for every row. Compare the
// original fields to resolve collisions. Limit linear scans to eight rows;
// larger buckets use exact tuple keys, including embedded separator characters.
function indexRow(index: Map<number, RowBucket>, key: readonly string[], row: Row): void {
  const hash = naturalKeyHash(key, row)
  const existing = index.get(hash)
  if (existing === undefined) {
    index.set(hash, row)
  }
  else if (existing instanceof Map) {
    existing.set(naturalKeyTuple(key, row), row)
  }
  else if (Array.isArray(existing)) {
    const match = existing.findIndex(candidate => sameNaturalKey(key, candidate, row))
    if (match >= 0) {
      existing[match] = row
    }
    else if (existing.length < 8) {
      existing.push(row)
    }
    else {
      const bucket = new Map(existing.map(candidate => [naturalKeyTuple(key, candidate), candidate]))
      bucket.set(naturalKeyTuple(key, row), row)
      index.set(hash, bucket)
    }
  }
  else if (sameNaturalKey(key, existing, row)) {
    index.set(hash, row)
  }
  else {
    index.set(hash, [existing, row])
  }
}

// Encode an already-ordered row array to a parquet buffer. Feeds rows through
// `parquetWriteRows`, which pulls and transposes one row group at a time, so
// the transient transpose + coercion footprint is bounded by `rowGroupSize`
// rather than the whole column set (C arrays of length N). Rows are coerced
// lazily by a generator: `parquetWriteRows` reads `row[col]` verbatim and does
// no type conversion of its own, so the per-value coercion (INT64→BigInt,
// INT32 truncation, finite checks) must happen before the writer sees them.
function encodeOrderedRows(
  rows: readonly Row[],
  columns: readonly ColumnDef[],
  rowGroupSize: number,
): Uint8Array {
  // An explicit schema drives encoding (the writer looks each column up by name
  // in it), so DATE can be expressed as INT32 + converted_type DATE — something
  // the `BasicType`-inferred path cannot do.
  const schema = buildWriteSchema(columns)
  const codecs = columns.map(col => ({
    name: col.name,
    isDate: col.type === 'DATE',
    type: basicTypeFor(col.type),
  }))
  // Page-level statistics let DuckDB prune below the row-group granularity for
  // high-cardinality columns (url, query). Cheap to write, free to skip. The
  // schema fixes the physical type, so the spec only needs name + flags.
  const columnSpecs: Omit<ColumnSource, 'data'>[] = columns.map(col => ({
    name: col.name,
    nullable: col.nullable,
    columnIndex: true,
  }))
  function* coercedRows(): Generator<Record<string, unknown>> {
    for (const r of rows) {
      const out: Record<string, unknown> = {}
      for (const codec of codecs) {
        // DATE → int-days (plain number) so the writer dictionary-dedupes it
        // correctly; everything else through the type-aware value coercion.
        out[codec.name] = codec.isDate
          ? toEpochDays(r[codec.name])
          : coerceValue(r[codec.name], codec.type)
      }
      yield out
    }
  }
  const writer = new ByteWriter()
  // ByteWriter is fully synchronous, so this returns void (no promise to await).
  parquetWriteRows({ writer, rows: coercedRows(), columns: columnSpecs, schema, rowGroupSize })
  return new Uint8Array(writer.getBuffer())
}

export function encodeRowsToParquet(table: TableName, rows: readonly Row[]): Uint8Array {
  const schema = SCHEMAS[table]
  const sorted = sortRowsByClusterKey(table, rows)
  return encodeOrderedRows(sorted, schema.columns, ROW_GROUP_SIZE)
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
  return encodeOrderedRows(sorted, columns, rowGroupSize)
}

// Adapt a Uint8Array to hyparquet's `AsyncBuffer` WITHOUT an upfront full-file
// copy. hyparquet only ever reads the footer + the column chunks it needs, so
// slicing lazily from the underlying ArrayBuffer (offset-corrected) copies just
// those ranges — peak memory is ~1× the file plus the ranges read, not the ~2×
// an eager `buffer.slice()` of the whole file would cost on large reads.
function asyncBufferFromBytes(bytes: Uint8Array): AsyncBuffer {
  const base = bytes.byteOffset
  const buf = bytes.buffer
  return {
    byteLength: bytes.byteLength,
    slice(start: number, end?: number) {
      const from = base + start
      const to = end === undefined ? base + bytes.byteLength : base + end
      return buf.slice(from, to) as ArrayBuffer
    },
  }
}

export interface DecodeParquetOptions {
  /** First physical row to decode, inclusive. */
  rowStart?: number
  /** Last physical row to decode, exclusive. */
  rowEnd?: number
  /**
   * Row filter pushed down into the parquet reader. hyparquet evaluates this
   * per row group — pruning groups whose column statistics can't match and
   * materialising only matching rows — so a filtered decode of a large file
   * holds at most one row group plus the matches in memory, never the whole
   * file. Use when a caller needs a sub-slice of a big parquet keyed on a
   * clustered column (a row group's min/max stats only prune if the predicate
   * column is the physical sort key — see `sortKey`/`clusterKey`).
   */
  filter?: ParquetQueryFilter
  /**
   * Project a subset of columns. hyparquet only fetches + decodes the named
   * column chunks, so a read that needs 2 of 14 columns skips the other 12's
   * pages entirely. Omit to read every column. A name the file lacks is
   * dropped from the projection before the read, so the decoded rows simply
   * lack that key. That is what lets one projection span files written before
   * a column existed (union-by-name); hyparquet itself throws on such a name.
   */
  columns?: readonly string[]
}

export async function decodeParquetToRows(
  bytes: Uint8Array,
  opts: DecodeParquetOptions = {},
): Promise<Row[]> {
  const rows: Row[] = []
  for await (const group of decodeParquetGroups(bytes, opts)) {
    for (const row of group)
      rows.push(row)
  }
  return rows
}

// Decode one physical row group at a time. The reader otherwise retains all
// decoded columns while assembling rows. Compaction can fold each group
// immediately without retaining a second array for the whole input file.
async function* decodeParquetGroups(
  bytes: Uint8Array,
  opts: DecodeParquetOptions = {},
): AsyncGenerator<Row[]> {
  if (bytes.byteLength === 0)
    return
  const file = asyncBufferFromBytes(bytes)
  const metadata = await parquetMetadataAsync(file)
  const present = new Set(parquetSchema(metadata).children.map(child => child.element.name))
  // Missing projected columns remain absent for older files.
  const columns = opts.columns?.filter(name => present.has(name))
  let groupStart = 0
  for (const group of metadata.row_groups) {
    const groupEnd = groupStart + Number(group.num_rows)
    const rowStart = Math.max(groupStart, opts.rowStart ?? 0)
    const rowEnd = Math.min(groupEnd, opts.rowEnd ?? Infinity)
    if (rowStart < rowEnd) {
      const rows = await parquetReadObjects({
        file,
        // Chunk offsets remain absolute. Row selection becomes local to this
        // group so the reader does not rescan every group for each request.
        metadata: { ...metadata, row_groups: [group], num_rows: group.num_rows },
        columns,
        rowStart: rowStart - groupStart,
        rowEnd: rowEnd - groupStart,
        useOffsetIndex: rowStart > groupStart || rowEnd < groupEnd,
        // Preserve bloom and page-index pruning for filtered reads.
        ...(opts.filter ? { filter: opts.filter, useBloomFilters: true, usePageIndex: true } : {}),
      })
      yield normalizeDecodedDates(rows as Row[])
    }
    groupStart = groupEnd
  }
}

/**
 * Normalise any `Date`-valued cell back to an ISO `YYYY-MM-DD` string, the form
 * the codec contract carries (and that JSON / Workers RPC round-trips cleanly).
 * A native parquet DATE column decodes to a JS `Date` (hyparquet's
 * `dateFromDays`); legacy string-`date` files already hold strings and pass
 * through. Share repeated date strings within this decode. Bound the cache
 * so files with many distinct dates cannot retain a second copy of every day.
 */
function normalizeDecodedDates(rows: Row[]): Row[] {
  const dates = new Map<number, string>()
  for (const row of rows) {
    const r = row as Record<string, unknown>
    for (const k in r) {
      const v = r[k]
      if (v instanceof Date) {
        const day = Math.floor(v.getTime() / EPOCH_DAY_MS)
        let iso = dates.get(day)
        if (iso === undefined) {
          iso = isoFromDate(v)
          if (dates.size >= 1024)
            dates.clear()
          dates.set(day, iso)
        }
        r[k] = iso
      }
    }
  }
  return rows
}

export interface HyparquetCodecOptions {
  /**
   * Override `readRows`. Useful when reads should be delegated to a faster
   * engine (e.g. DuckDB-WASM via httpfs) while writes + compaction stay on
   * hyparquet to avoid WASM linear-memory growth. Defaults to hyparquet.
   */
  readRows?: (ctx: CodecCtx, key: string, dataSource: DataSource) => Promise<Row[]>
  /**
   * Maximum input-file reads held in flight during compaction. Defaults to 8;
   * lower it for unusually large files to trade latency for peak JS memory.
   */
  compactionReadConcurrency?: number
}

export function createHyparquetCodec(options: HyparquetCodecOptions = {}): ParquetCodec {
  const readRows = options.readRows ?? (async (_ctx, key, dataSource) => {
    const bytes = await dataSource.read(key)
    return decodeParquetToRows(bytes)
  })
  const requestedConcurrency = options.compactionReadConcurrency
  const compactionReadConcurrency = typeof requestedConcurrency === 'number' && Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(MAX_COMPACTION_READ_CONCURRENCY, Math.floor(requestedConcurrency)))
    : DEFAULT_COMPACTION_READ_CONCURRENCY

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
      const key = TABLE_METADATA[ctx.table].sortKey
      const byNaturalKey = new Map<number, RowBucket>()
      for (let offset = 0; offset < inputKeys.length; offset += compactionReadConcurrency) {
        const batch = inputKeys.slice(offset, offset + compactionReadConcurrency)
        const inputs = await Promise.all(batch.map(key => dataSource.read(key)))
        // Decode/fold in input order so collision semantics remain unchanged,
        // while the latency-bound object reads overlap.
        while (inputs.length > 0) {
          const input = inputs.shift()!
          for await (const rows of decodeParquetGroups(input)) {
            for (const row of rows)
              indexRow(byNaturalKey, key, row)
          }
        }
      }
      // Recurrence guard: correct compaction inputs own disjoint natural keys,
      // but a duplicated-row regression must not survive a merge — collapse
      // any natural-key collision before encoding. Accumulating directly into
      // the map avoids holding both `allRows` and a second dedupe map for
      // whale-site compactions.
      const rows: Row[] = []
      for (const entry of byNaturalKey.values()) {
        if (entry instanceof Map || Array.isArray(entry)) {
          for (const row of entry.values())
            rows.push(row)
        }
        else {
          rows.push(entry)
        }
      }
      byNaturalKey.clear()
      const bytes = encodeRowsToParquet(ctx.table, rows)
      await dataSource.write(outputKey, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },
  }
}
