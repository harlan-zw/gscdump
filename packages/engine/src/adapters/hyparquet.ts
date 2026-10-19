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
import type { BoundedValuesOptions } from './parquet-bounded-values'
import { decompress as decompressZstd } from 'fzstd'
import { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetSchema, readOffsetIndex } from 'hyparquet'
import { ByteWriter, ParquetWriter, parquetWriteRows } from 'hyparquet-writer'
import { SCHEMAS, TABLE_METADATA } from '../schema'
import { boundedValuesPolicy, decodeBoundedValues } from './parquet-bounded-values'
import { parquetDecodeBudget } from './parquet-decode-budget'
import { parquetRangeCache } from './parquet-range-cache'

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
  fileMetadata?: Readonly<Record<string, string>>,
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
  const metadataKeys = Object.keys(fileMetadata ?? {}).sort()
  const kvMetadata = metadataKeys.length > 0
    ? metadataKeys.map(key => ({ key, value: fileMetadata![key]! }))
    : undefined
  // ByteWriter is fully synchronous, so this returns void (no promise to await).
  parquetWriteRows({ writer, rows: coercedRows(), columns: columnSpecs, schema, rowGroupSize, kvMetadata })
  return new Uint8Array(writer.getBuffer())
}

export interface EncodeParquetOptions {
  /** File footer metadata, without adding fact columns. Keys are encoded in sorted order. */
  fileMetadata?: Readonly<Record<string, string>>
}

export function encodeRowsToParquet(table: TableName, rows: readonly Row[], opts: EncodeParquetOptions = {}): Uint8Array {
  const schema = SCHEMAS[table]
  const sorted = sortRowsByClusterKey(table, rows)
  return encodeOrderedRows(sorted, schema.columns, ROW_GROUP_SIZE, opts.fileMetadata)
}

export interface EncodeFlexOptions extends EncodeParquetOptions {
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
  return encodeOrderedRows(sorted, columns, rowGroupSize, opts.fileMetadata)
}

export interface EncodeParquetBatchesOptions extends EncodeParquetOptions {
  /** Output schema and column order. Input rows must already be ordered/deduplicated. */
  columns: readonly ColumnDef[]
  /** Maximum rows per output group. Default 25000, matching the array codec. */
  rowGroupSize?: number
  limits?: {
    /** Refuse a producer batch with more rows. Default 25000. */
    maxBatchRows?: number
    /** Conservative scalar-value bytes per producer batch. Default 8 MiB. */
    maxBatchBytes?: number
    /** Split groups at this conservative scalar-value budget. Default 2 MiB. */
    maxRowGroupBytes?: number
    /** Bound retained footer/index descriptors. Default 4096. */
    maxRowGroups?: number
    /** Bound retained descriptor/scalar bytes, including statistics. Default 8 MiB. */
    maxRetainedMetadataBytes?: number
    /** Bound the current encoded group or footer buffer. Default 8 MiB. */
    maxOutputBufferBytes?: number
  }
}

function streamLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError(`parquet stream ${name} must be a positive safe integer`)
  return limit
}

// Three bytes per UTF-16 code unit bounds UTF-8 without another encoded copy.
// This measures scalar payload only, NOT V8 object/array or codec heap usage.
function scalarBytes(value: unknown): number {
  return typeof value === 'string' ? value.length * 3 + 8 : 16
}

// Count each newly retained public descriptor once, including untruncated
// statistic strings. This is a conservative admission metric, not heap size.
function retainedDescriptorBytes(value: unknown, remaining: number): number {
  const seen = new Set<object>()
  let bytes = 0
  const visit = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      if (seen.has(value))
        return
      seen.add(value)
      bytes += 64
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        bytes += value.byteLength
      }
      else {
        for (const key in value) {
          if (Object.hasOwn(value, key)) {
            bytes += scalarBytes(key)
            visit((value as Record<string, unknown>)[key])
          }
        }
      }
    }
    else {
      bytes += scalarBytes(value)
    }
    if (bytes > remaining)
      throw new RangeError('parquet stream exceeds maxRetainedMetadataBytes')
  }
  visit(value)
  return bytes
}

/**
 * Encode ordered batches into ONE Parquet file with sequential backpressure.
 * Group boundaries depend on rows/options, never producer batch boundaries.
 * `write` borrows its bytes only until its returned promise settles; copy them
 * if retaining them. This function does not close/commit a destination. On ANY
 * rejection the caller must abort/discard the entire partial output, including
 * after a footer callback failure. It performs no sorting, dedupe or retries.
 * Memory includes one input batch, one group, and bounded footer descriptors.
 */
export async function encodeParquetRowBatches(
  batches: AsyncIterable<readonly Row[]> | Iterable<readonly Row[]>,
  opts: EncodeParquetBatchesOptions,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<WriteResult> {
  const rowGroupSize = streamLimit(opts.rowGroupSize, ROW_GROUP_SIZE, 'rowGroupSize')
  const maxBatchRows = streamLimit(opts.limits?.maxBatchRows, ROW_GROUP_SIZE, 'maxBatchRows')
  const maxBatchBytes = streamLimit(opts.limits?.maxBatchBytes, 8 * 1024 * 1024, 'maxBatchBytes')
  const maxRowGroupBytes = streamLimit(opts.limits?.maxRowGroupBytes, 2 * 1024 * 1024, 'maxRowGroupBytes')
  const maxRowGroups = streamLimit(opts.limits?.maxRowGroups, 4096, 'maxRowGroups')
  const maxRetainedMetadataBytes = streamLimit(opts.limits?.maxRetainedMetadataBytes, 8 * 1024 * 1024, 'maxRetainedMetadataBytes')
  const maxOutputBufferBytes = streamLimit(opts.limits?.maxOutputBufferBytes, 8 * 1024 * 1024, 'maxOutputBufferBytes')
  if (opts.columns.length === 0 || opts.columns.length > 64 || new Set(opts.columns.map(col => col.name)).size !== opts.columns.length)
    throw new RangeError('parquet stream requires 1 to 64 uniquely named columns')
  const codecs = opts.columns.map(col => ({ name: col.name, isDate: col.type === 'DATE', type: basicTypeFor(col.type), nullable: col.nullable }))
  const schema = buildWriteSchema(opts.columns)
  const metadataKeys = Object.keys(opts.fileMetadata ?? {}).sort()
  let metadataBytes = 0
  for (const key of metadataKeys) {
    metadataBytes += scalarBytes(key) + scalarBytes(opts.fileMetadata![key])
    if (metadataBytes > maxOutputBufferBytes)
      throw new RangeError('parquet stream file metadata exceeds maxOutputBufferBytes')
  }
  let retainedMetadataBytes = retainedDescriptorBytes([schema, opts.fileMetadata], maxRetainedMetadataBytes)
  const writer = new ByteWriter(Math.min(64 * 1024, maxOutputBufferBytes))
  // ByteWriter's documented offset is global; index is the current buffer.
  // No whole-file buffer is retained. Encoding is synchronous within a group,
  // and the public ParquetWriter awaits flush before encoding another group.
  writer.ensure = (size) => {
    const required = writer.index + size
    if (required > maxOutputBufferBytes)
      throw new RangeError('parquet stream encoded group/footer exceeds maxOutputBufferBytes')
    if (required > writer.buffer.byteLength) {
      const next = new ArrayBuffer(Math.min(maxOutputBufferBytes, Math.max(required, writer.buffer.byteLength * 2)))
      new Uint8Array(next).set(new Uint8Array(writer.buffer, 0, writer.index))
      writer.buffer = next
      writer.view = new DataView(next)
    }
  }
  const flush = async (): Promise<void> => {
    if (writer.index > 0)
      await write(new Uint8Array(writer.buffer, 0, writer.index))
    writer.index = 0
  }
  const output = Object.assign(writer, { flush, finish: flush })
  const parquet = new ParquetWriter({
    writer: output,
    schema,
    kvMetadata: metadataKeys.length ? metadataKeys.map(key => ({ key, value: opts.fileMetadata![key]! })) : undefined,
  })
  let values: unknown[][] = codecs.map(() => [])
  let groupRows = 0
  let groupBytes = 0
  let groups = 0
  let rowCount = 0
  const flushGroup = async (): Promise<void> => {
    if (!groupRows)
      return
    if (++groups > maxRowGroups)
      throw new RangeError('parquet stream exceeds maxRowGroups')
    const firstIndex = parquet.pendingIndexes.length
    await parquet.write({
      columnData: codecs.map((col, index) => ({ name: col.name, nullable: col.nullable, columnIndex: true, data: values[index]! })),
      rowGroupSize: groupRows,
    })
    retainedMetadataBytes += retainedDescriptorBytes(
      [parquet.row_groups[parquet.row_groups.length - 1], parquet.pendingIndexes.slice(firstIndex)],
      maxRetainedMetadataBytes - retainedMetadataBytes,
    )
    values = codecs.map(() => [])
    groupRows = 0
    groupBytes = 0
  }
  try {
    for await (const batch of batches) {
      if (batch.length > maxBatchRows)
        throw new RangeError('parquet stream exceeds maxBatchRows')
      let batchBytes = 0
      for (const row of batch) {
        const converted = codecs.map(col => col.isDate ? toEpochDays(row[col.name]) : coerceValue(row[col.name], col.type))
        const bytes = converted.reduce<number>((sum, value) => sum + scalarBytes(value), 0)
        batchBytes += bytes
        if (batchBytes > maxBatchBytes)
          throw new RangeError('parquet stream exceeds maxBatchBytes')
        if (bytes > maxRowGroupBytes)
          throw new RangeError('parquet stream single row exceeds maxRowGroupBytes')
        if (groupRows && (groupRows >= rowGroupSize || groupBytes + bytes > maxRowGroupBytes))
          await flushGroup()
        for (let index = 0; index < converted.length; index++)
          values[index]!.push(converted[index])
        groupRows++
        groupBytes += bytes
        rowCount++
        if (groupRows === rowGroupSize)
          await flushGroup()
      }
    }
    await flushGroup()
    await parquet.finish()
    return { bytes: writer.offset, rowCount }
  }
  finally {
    // Do not keep a rejected operation's group/footer alive via an error stack.
    values = []
    parquet.row_groups.length = 0
    parquet.pendingIndexes.length = 0
    writer.buffer = new ArrayBuffer(0)
    writer.view = new DataView(writer.buffer)
    writer.index = 0
  }
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
    for (let i = 0; i < group.length; i++)
      rows.push(group[i])
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
  yield* decodeGroupsFromMetadata(file, metadata, opts)
}

/** A caller-owned, immutable/pinned object; ranges must return exactly the requested bytes. */
export interface ParquetRangeSource {
  byteLength: number
  slice: (start: number, end?: number) => ArrayBuffer | Promise<ArrayBuffer>
}

export interface DecodeParquetGroupsOptions extends DecodeParquetOptions {
  /**
   * Strict opt-in value cursors for flat scalar PLAIN/dictionary SNAPPY or raw
   * pages. Rejects unsupported inputs instead of falling back to eager decoding.
   * Page buffers and emitted values have separate bounds; not an isolate heap cap.
   * Cannot be combined with filters or indexedRowWindow.
   */
  boundedValues?: BoundedValuesOptions
  /**
   * Opt-in windows for flat scalar groups whose designated, selected columns
   * have offset indexes and no dictionary encoding. Ineligible groups retain
   * the original physical-group read, so targetRows is not a hard batch limit.
   * Windows still decode complete overlapping pages, not a bounded heap size.
   */
  indexedRowWindow?: {
    targetRows: number
    requiredIndexedColumns: readonly string[]
    /** Per eligible group; 0 disables caching. Default 0, maximum 2 MiB/128 entries. */
    rangeCacheBytes?: number
  }
  limits?: {
    /** Footer bytes before deserialization. Default 1 MiB. */
    maxMetadataBytes?: number
    /** Includes the existing encoder's 25000-row groups. Default 25000. */
    maxRowGroupRows?: number
    /** Declared uncompressed bytes across all columns in one group. Default 16 MiB. */
    maxRowGroupBytes?: number
    /** Bound metadata descriptors. Default 4096. */
    maxRowGroups?: number
    /** Maximum individual range request. Default 16 MiB. */
    maxReadBytes?: number
    /**
     * Optional cumulative source-range + SNAPPY-output bytes per physical group,
     * including all indexed windows. Charged before reads/output allocation;
     * cache hits do not allocate another range. Deliberately conservative, not
     * total JS heap. ZSTD refuses only with this option. Omission is unchanged.
     */
    maxReadAndDecompressBytes?: number
  }
}

/**
 * Pull one physical group at a time without downloading the complete object.
 * The limits are admission bounds over Parquet metadata, not a memory-safety
 * guarantee for malicious files or caller-retained batches. No cross-group
 * read-ahead is started. Missing/corrupt/range-error input throws; it is not empty.
 */
export async function* decodeParquetRowGroups(file: ParquetRangeSource, opts: DecodeParquetGroupsOptions = {}): AsyncGenerator<Row[]> {
  const values = boundedValuesPolicy(opts.boundedValues)
  const selection = values ? { columns: opts.columns?.slice(), rowStart: opts.rowStart, rowEnd: opts.rowEnd } : undefined
  if (values) {
    for (const key of ['rowStart', 'rowEnd'] as const) {
      const value = selection![key]
      if (value !== undefined && !(key === 'rowEnd' && value === Infinity) && (!Number.isSafeInteger(value) || value < 0))
        throw new RangeError(`invalid boundedValues.${key}`)
    }
  }
  if (values && (opts.filter || opts.indexedRowWindow))
    throw new Error('boundedValues cannot be combined with filter or indexedRowWindow')
  const indexedWindow = indexedWindowPolicy(opts.indexedRowWindow)
  const maxReadAndDecompressBytes = opts.limits?.maxReadAndDecompressBytes === undefined
    ? undefined
    : streamLimit(opts.limits.maxReadAndDecompressBytes, 0, 'maxReadAndDecompressBytes')
  const maxMetadataBytes = streamLimit(opts.limits?.maxMetadataBytes, 1024 * 1024, 'maxMetadataBytes')
  const maxRowGroupRows = streamLimit(opts.limits?.maxRowGroupRows, ROW_GROUP_SIZE, 'maxRowGroupRows')
  const maxRowGroupBytes = streamLimit(opts.limits?.maxRowGroupBytes, 16 * 1024 * 1024, 'maxRowGroupBytes')
  const maxRowGroups = streamLimit(opts.limits?.maxRowGroups, 4096, 'maxRowGroups')
  const maxReadBytes = streamLimit(opts.limits?.maxReadBytes, 16 * 1024 * 1024, 'maxReadBytes')
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 12)
    throw new RangeError('parquet stream requires a valid file length')
  const bounded: AsyncBuffer = {
    byteLength: file.byteLength,
    async slice(start, end = file.byteLength) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.byteLength || end - start > maxReadBytes)
        throw new RangeError('parquet stream range exceeds maxReadBytes or file bounds')
      const bytes = await file.slice(start, end)
      if (bytes.byteLength !== end - start)
        throw new Error('parquet stream returned an incomplete range')
      return bytes
    },
  }
  const trailer = new DataView(await bounded.slice(file.byteLength - 8, file.byteLength))
  if (trailer.getUint32(4, true) !== 0x31524150)
    throw new Error('parquet stream invalid footer')
  const metadataBytes = trailer.getUint32(0, true)
  if (metadataBytes > maxMetadataBytes || metadataBytes + 12 > file.byteLength)
    throw new RangeError('parquet stream footer exceeds maxMetadataBytes or file bounds')
  const metadata = parquetMetadata(await bounded.slice(file.byteLength - metadataBytes - 8, file.byteLength))
  if (metadata.row_groups.length > maxRowGroups || metadata.schema.length > 65)
    throw new RangeError('parquet stream exceeds row-group/schema descriptor limits')
  let totalRows = 0
  for (const group of metadata.row_groups) {
    if (group.columns.length > 64)
      throw new RangeError('parquet stream exceeds column descriptor limits')
    const rows = Number(group.num_rows)
    if (group.columns.some(col => [col.meta_data?.total_uncompressed_size, col.meta_data?.total_compressed_size]
      .some(size => !Number.isSafeInteger(Number(size)) || Number(size) < 0))) {
      throw new RangeError('parquet stream invalid declared group bytes')
    }
    const uncompressed = group.columns.reduce((sum, col) => sum + Number(col.meta_data?.total_uncompressed_size ?? NaN), 0)
    const compressed = group.columns.reduce((sum, col) => sum + Number(col.meta_data?.total_compressed_size ?? NaN), 0)
    if (!Number.isSafeInteger(rows) || rows < 0 || rows > maxRowGroupRows)
      throw new RangeError('parquet stream exceeds maxRowGroupRows')
    if (!Number.isSafeInteger(uncompressed) || uncompressed < 0 || uncompressed > maxRowGroupBytes
      || !Number.isSafeInteger(compressed) || compressed < 0 || compressed > maxRowGroupBytes) {
      throw new RangeError('parquet stream declared group bytes exceed maxRowGroupBytes')
    }
    totalRows += rows
  }
  if (!Number.isSafeInteger(totalRows) || BigInt(totalRows) !== metadata.num_rows)
    throw new Error('parquet stream row-count metadata mismatch')
  if (values) {
    yield* decodeBoundedValues(bounded, metadata, values, maxReadBytes, selection!, maxReadAndDecompressBytes)
    return
  }
  yield* decodeGroupsFromMetadata(bounded, metadata, opts, indexedWindow && { ...indexedWindow, maxReadBytes }, maxReadAndDecompressBytes)
}

interface IndexedWindowPolicy {
  targetRows: number
  requiredIndexedColumns: string[]
  rangeCacheBytes: number
}

function indexedWindowPolicy(policy: DecodeParquetGroupsOptions['indexedRowWindow']): IndexedWindowPolicy | undefined {
  if (policy === undefined)
    return undefined
  const { targetRows, requiredIndexedColumns, rangeCacheBytes = 0 } = policy
  if (!Number.isSafeInteger(targetRows) || targetRows < 1
    || !Array.isArray(requiredIndexedColumns) || requiredIndexedColumns.length < 1 || requiredIndexedColumns.length > 64
    || requiredIndexedColumns.some(name => typeof name !== 'string' || name.length === 0)
    || !Number.isSafeInteger(rangeCacheBytes) || rangeCacheBytes < 0 || rangeCacheBytes > 2 * 1024 * 1024) {
    throw new RangeError('invalid indexedRowWindow policy')
  }
  return { targetRows, requiredIndexedColumns: [...new Set<string>(requiredIndexedColumns)], rangeCacheBytes }
}

// Cached byte views must not escape in decoded binary/nested values. Keep this
// deliberately narrower than all formats accepted by the unchanged decoder.
function windowScalar(element: SchemaElement): boolean {
  if (element.num_children || element.repetition_type === 'REPEATED')
    return false
  const converted = element.converted_type
  const logical = element.logical_type?.type
  // The pinned reader's default utf8=true also converts unannotated BYTE_ARRAY
  // to strings. FIXED_LEN_BYTE_ARRAY and object-producing annotations stay out.
  if (element.type === 'BYTE_ARRAY')
    return (!converted || converted === 'UTF8') && (!logical || logical === 'STRING')
  return ['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE'].includes(element.type ?? '')
    && (!converted || ['DATE', 'TIME_MILLIS', 'TIME_MICROS', 'TIMESTAMP_MILLIS', 'TIMESTAMP_MICROS', 'UINT_8', 'UINT_16', 'UINT_32', 'UINT_64', 'INT_8', 'INT_16', 'INT_32', 'INT_64'].includes(converted))
    && (!logical || ['DATE', 'TIME', 'TIMESTAMP', 'INTEGER'].includes(logical))
}

type IndexedWindow = IndexedWindowPolicy & { maxReadBytes: number }
type ParquetMetadata = Awaited<ReturnType<typeof parquetMetadataAsync>>

function indexedGroup(group: ParquetMetadata['row_groups'][number], names: Set<string>, columns: string[] | undefined, fileBytes: number, policy: IndexedWindow): boolean {
  if (group.columns.length !== names.size || new Set(group.columns.map(col => col.meta_data?.path_in_schema[0])).size !== names.size
    || group.columns.some(col => col.meta_data?.path_in_schema.length !== 1 || !names.has(col.meta_data.path_in_schema[0]!))) {
    return false
  }
  return policy.requiredIndexedColumns.every((name) => {
    if (columns && !columns.includes(name))
      return false
    const matches = group.columns.filter(col => col.meta_data?.path_in_schema[0] === name)
    if (matches.length !== 1)
      return false
    const chunk = matches[0]!
    const meta = chunk.meta_data!
    if ((meta.dictionary_page_offset !== undefined && meta.dictionary_page_offset !== null)
      || meta.encodings.some(encoding => encoding === 'PLAIN_DICTIONARY' || encoding === 'RLE_DICTIONARY')) {
      return false
    }
    const start = Number(chunk.offset_index_offset)
    const length = chunk.offset_index_length
    return Number.isSafeInteger(start) && start >= 4 && Number.isSafeInteger(length) && length! > 0
      && length! <= policy.maxReadBytes && Number.isSafeInteger(start + length!) && start + length! <= fileBytes
  })
}

async function validateWindowIndexes(file: AsyncBuffer, group: ParquetMetadata['row_groups'][number], columns: string[] | undefined, hasFilter: boolean): Promise<void> {
  // The underlying reader trusts page row offsets and can otherwise pad shifted
  // values with undefined. Validate structure once before any window is emitted.
  // Filters may read columns omitted from projection, so include all indexes
  // in that case. This is not physical page-header/row-count verification.
  for (const column of group.columns) {
    const meta = column.meta_data!
    if (columns && !hasFilter && !columns.includes(meta.path_in_schema[0]!))
      continue
    if (!column.offset_index_offset || !column.offset_index_length)
      continue
    const start = Number(column.offset_index_offset)
    const bytes = await file.slice(start, start + column.offset_index_length)
    const pages = readOffsetIndex({ view: new DataView(bytes), offset: 0 }).page_locations
    const groupRows = Number(group.num_rows)
    const dataStart = Number(meta.data_page_offset)
    const columnStart = Number(meta.dictionary_page_offset ?? meta.data_page_offset)
    const columnEnd = columnStart + Number(meta.total_compressed_size)
    if (!pages.length || pages.length > groupRows || !Number.isSafeInteger(dataStart) || dataStart < 4
      || !Number.isSafeInteger(columnStart) || columnStart < 4 || !Number.isSafeInteger(columnEnd) || columnEnd > file.byteLength) {
      throw new Error('parquet stream invalid offset index')
    }
    let previousRow = -1
    let previousEnd = dataStart
    for (const [index, page] of pages.entries()) {
      const row = Number(page.first_row_index)
      const offset = Number(page.offset)
      const size = page.compressed_page_size
      if (!Number.isSafeInteger(row) || row <= previousRow || row >= groupRows || (index === 0 && row !== 0)
        || !Number.isSafeInteger(offset) || offset < previousEnd || !Number.isSafeInteger(size) || size < 1
        || !Number.isSafeInteger(offset + size) || offset + size > columnEnd) {
        throw new Error('parquet stream invalid offset index')
      }
      previousRow = row
      previousEnd = offset + size
    }
  }
}

async function* decodeGroupsFromMetadata(file: AsyncBuffer, metadata: ParquetMetadata, opts: DecodeParquetOptions, indexedWindow?: IndexedWindow, maxReadAndDecompressBytes?: number): AsyncGenerator<Row[]> {
  const tree = parquetSchema(metadata)
  // Columns the reader can decode into `Date` values. This adapter passes no
  // custom parsers, so the set is closed: DATE and TIMESTAMP logical types
  // plus legacy INT96. Resolving it once per decode lets the normalizer scan
  // those cells only, instead of every key of every row.
  const present = new Set<string>()
  const dateColumns: string[] = []
  let nested = false
  for (const child of tree.children) {
    present.add(child.element.name)
    if (child.children.length > 0)
      nested = true
    else if (isDateCapableElement(child.element))
      dateColumns.push(child.element.name)
  }
  // Missing projected columns remain absent for older files.
  const columns = opts.columns?.filter(name => present.has(name))
  // A nested schema can surface decoded values under keys the top-level
  // elements don't name; fall back to scanning every key there.
  const normalizeColumns: readonly string[] | null = nested ? null : dateColumns
  const windowSchema = indexedWindow && !nested && present.size === tree.children.length
    && tree.children.every(child => windowScalar(child.element))
  let groupStart = 0
  for (const group of metadata.row_groups) {
    const groupEnd = groupStart + Number(group.num_rows)
    const rowStart = Math.max(groupStart, opts.rowStart ?? 0)
    const rowEnd = Math.min(groupEnd, opts.rowEnd ?? Infinity)
    if (rowStart < rowEnd) {
      const window = windowSchema && indexedWindow && indexedGroup(group, present, columns, file.byteLength, indexedWindow) ? indexedWindow : undefined
      const budget = maxReadAndDecompressBytes === undefined ? undefined : parquetDecodeBudget(file, maxReadAndDecompressBytes)
      const groupFile = budget?.file ?? file
      const cached = window?.rangeCacheBytes ? parquetRangeCache(groupFile, window.rangeCacheBytes) : undefined
      try {
        if (window)
          await validateWindowIndexes(cached?.file ?? groupFile, group, columns, !!opts.filter)
        for (let start = rowStart; start < rowEnd;) {
          const end = Math.min(rowEnd, start + (window?.targetRows ?? rowEnd - rowStart))
          const rows = await parquetReadObjects({
            file: cached?.file ?? groupFile,
            // Catalog compaction writes ZSTD. Keep decoding pure JS for Workers.
            compressors: budget?.compressors ?? { ZSTD: input => decompressZstd(input) },
            // Chunk offsets remain absolute. Row selection becomes local to this
            // group so the reader does not rescan every group for each request.
            metadata: { ...metadata, row_groups: [group], num_rows: group.num_rows },
            columns,
            rowStart: start - groupStart,
            rowEnd: end - groupStart,
            useOffsetIndex: start > groupStart || end < groupEnd,
            // Preserve bloom and page-index pruning for filtered reads.
            ...(opts.filter ? { filter: opts.filter, useBloomFilters: true, usePageIndex: true } : {}),
          })
          yield normalizeDecodedDates(rows as Row[], normalizeColumns)
          start = end
        }
      }
      finally {
        budget?.close()
        cached?.close()
      }
    }
    groupStart = groupEnd
  }
}

/**
 * Schema elements whose decoded cells can be `Date` instances under the
 * reader's default parsers: legacy INT96 timestamps, the `converted_type`
 * DATE/TIMESTAMP encodings, and the `logicalType` TIMESTAMP superset (any
 * unit). Everything else decodes to numbers, strings, or bytes.
 */
function isDateCapableElement(element: SchemaElement): boolean {
  if (element.type === 'INT96')
    return true
  const converted = element.converted_type
  if (converted === 'DATE' || converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS')
    return true
  return element.logical_type?.type === 'TIMESTAMP'
}

/**
 * Normalise any `Date`-valued cell back to an ISO `YYYY-MM-DD` string, the form
 * the codec contract carries (and that JSON / Workers RPC round-trips cleanly).
 * A native parquet DATE column decodes to a JS `Date` (hyparquet's
 * `dateFromDays`); legacy string-`date` files already hold strings and pass
 * through. Share repeated date strings within this decode. Bound the cache
 * so files with many distinct dates cannot retain a second copy of every day.
 * `dateColumns` narrows the scan to the schema's Date-capable columns; `null`
 * scans every key (nested schemas).
 */
function normalizeDecodedDates(rows: Row[], dateColumns: readonly string[] | null): Row[] {
  // No Date-capable column means no cell can hold a Date; skip the scan.
  if (dateColumns !== null && dateColumns.length === 0)
    return rows
  const dates = new Map<number, string>()
  for (const row of rows) {
    const r = row as Record<string, unknown>
    for (const k of dateColumns ?? Object.keys(r)) {
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
