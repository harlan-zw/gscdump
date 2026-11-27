import type { DataFile, Manifest, PartitionSpec, Schema, SortOrder, TableMetadata } from 'icebird/src/types.js'
import type { CommitRetryOptions, IcebergConnection } from './catalog'
import type { CatalogCache } from './catalog-cache'
import { parquetMetadataAsync } from 'hyparquet'
import { restCatalogLoadTable, restCatalogUpdateTable } from 'icebird/src/catalog/rest.js'
import { typeName, validateSchemaForVersion } from 'icebird/src/schema.js'
import { uuid4 } from 'icebird/src/utils.js'
import { writeDataManifest } from 'icebird/src/write/manifest.js'
import { compare, compareStringsCodePoint, serializeValue } from 'icebird/src/write/serde.js'
import { buildPartitionSummaries, buildSnapshotUpdate, currentSnapshot } from 'icebird/src/write/snapshot.js'
import { newSnapshotId } from 'icebird/src/write/stage.js'
import { transformResultType } from 'icebird/src/write/transform.js'
import { invalidateSnapshotRef, isCommitTransient } from './catalog'
import { toIcebergDayCount } from './date'

const APPEND_ID_SUMMARY_KEY = 'lakehouse.append-id'
const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
const INT64_MIN = -9_223_372_036_854_775_808n
const INT64_MAX = 9_223_372_036_854_775_807n
const DEFAULT_MAX_CONFLICT_RETRIES = 20
const DEFAULT_CONFLICT_MIN_WAIT_MS = 50
const DEFAULT_CONFLICT_MAX_WAIT_MS = 3_000
const PARQUET_STRING_BOUND_TRUNCATE_CODEPOINTS = 64
const PARQUET_BINARY_BOUND_TRUNCATE_BYTES = 64

const RESERVED_SUMMARY_KEYS = new Set([
  'operation',
  'added-data-files',
  'added-records',
  'added-files-size',
  'changed-partition-count',
  'total-records',
  'total-files-size',
  'total-data-files',
  'total-delete-files',
  'total-position-deletes',
  'total-equality-deletes',
  APPEND_ID_SUMMARY_KEY,
])

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()
const DATE_STRING_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const UUID_STRING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Primitive Iceberg types supported for single-value binary bound encoding. */
export type IcebergBoundType
  = | 'boolean'
    | 'int'
    | 'long'
    | 'float'
    | 'double'
    | 'date'
    | 'time'
    | 'timestamp'
    | 'timestamptz'
    | 'timestamp_ns'
    | 'timestamptz_ns'
    | 'string'
    | 'binary'
    | 'uuid'
    | `fixed[${number}]`

/** Supported scalar values for Iceberg single-value binary bound encoding. */
export type IcebergBoundScalar = boolean | number | bigint | string | Date | Uint8Array

/**
 * Optional per-column statistics for one pre-written Parquet data file.
 * Map keys accept either Iceberg schema column names (e.g. `'date'`) or numeric
 * Iceberg field IDs. Bound values accept typed JS values (encoded per Iceberg
 * v2 single-value binary serialization) or pre-encoded `Uint8Array` bytes.
 */
export interface ParquetFileColumnStats {
  columnSizes?: Readonly<Record<string | number, number | bigint>>
  valueCounts?: Readonly<Record<string | number, number | bigint>>
  nullValueCounts?: Readonly<Record<string | number, number | bigint>>
  nanValueCounts?: Readonly<Record<string | number, number | bigint>>
  lowerBounds?: Readonly<Record<string | number, IcebergBoundScalar>>
  upperBounds?: Readonly<Record<string | number, IcebergBoundScalar>>
  splitOffsets?: readonly (number | bigint)[]
}

/** Descriptor for one already-written Parquet data file in warehouse storage. */
export interface ParquetFileDescriptor {
  /** Full Iceberg file URI (e.g. `s3://bucket/warehouse/data/2026-03.zstd.parquet`). */
  path: string
  /** Exact file size in bytes (positive safe integer). */
  fileSizeBytes: number
  /** Exact row count in the file (positive safe integer). */
  recordCount: number
  /**
   * Partition tuple keyed by partition field name (e.g. `{ site_id: 42, date_month: 674 }`).
   * Values must already be in the partition transform's result domain.
   */
  partition: Readonly<Record<string, unknown>>
  /**
   * Per-column statistics. When omitted and `readParquetMetadata: true`, footer
   * statistics are read directly from the Parquet file via `conn.resolver.reader`
   * without decompressing data pages.
   */
  columnStats?: ParquetFileColumnStats
  /** Optional Iceberg sort order ID that this file's rows satisfy. Defaults to 0. */
  sortOrderId?: number
}

/** Options for {@link registerIcebergParquetFiles} and `dataset.registerParquetFiles`. */
export interface RegisterParquetFilesOptions {
  /**
   * Required idempotency token stamped into `snapshot.summary['lakehouse.append-id']`.
   * Re-running with the same token returns `{ _tag: 'AlreadyApplied', snapshotId }`
   * without writing duplicate manifest entries or snapshots.
   */
  appendId: string
  /**
   * Read Parquet footer metadata (`hyparquet` `parquetMetadataAsync`) for files
   * that omit `columnStats`. Reads only footer bytes; works with ZSTD Parquets.
   * Defaults to `false`.
   */
  readParquetMetadata?: boolean
  /** Default Iceberg sort order ID for files that omit `sortOrderId`. Defaults to `0`. */
  sortOrderId?: number
  /** Extra string properties to record in the committed snapshot summary. */
  snapshotProperties?: Readonly<Record<string, string>>
  /** Transient (429 / 5xx) retry policy and injectable `sleep` / `random`. */
  commitRetry?: Omit<CommitRetryOptions, 'appendId'>
  /** Maximum optimistic-concurrency (`409` / `412`) rebase attempts. */
  maxConflictRetries?: number
  /** Optional reader cache whose snapshot pointer is invalidated after a commit. */
  cache?: CatalogCache
  /** Injectable clock (ms epoch) for snapshot `timestamp-ms`. Defaults to `Date.now`. */
  clock?: () => number
}

export type RegisterParquetFilesErrorReason
  = | 'empty-files'
    | 'invalid-append-id'
    | 'invalid-descriptor'
    | 'invalid-partition'
    | 'invalid-column-stats'
    | 'unsupported-format'

export type RegisterParquetFilesResult
  = | {
    _tag: 'Registered'
    snapshotId: string
    manifestPath: string
    fileCount: number
    recordCount: number
    totalBytes: number
  }
  | {
    _tag: 'AlreadyApplied'
    snapshotId: string
  }
  | {
    _tag: 'Err'
    reason: RegisterParquetFilesErrorReason
    message: string
    fileIndex?: number
  }

/** Minimal structural shape of `hyparquet`'s `FileMetaData` needed for stats extraction. */
export interface ParquetFileMetadataLike {
  readonly num_rows: bigint
  readonly schema: readonly {
    readonly name: string
    readonly type?: string
    readonly field_id?: number
    readonly converted_type?: string
    readonly logical_type?: { readonly type: string, readonly unit?: string }
  }[]
  readonly row_groups: readonly {
    readonly num_rows: bigint
    readonly file_offset?: bigint
    readonly columns: readonly {
      readonly file_offset: bigint
      readonly meta_data?: {
        readonly path_in_schema: readonly string[]
        readonly num_values: bigint
        readonly total_compressed_size: bigint
        readonly data_page_offset: bigint
        readonly dictionary_page_offset?: bigint
        readonly statistics?: {
          readonly min?: unknown
          readonly max?: unknown
          readonly min_value?: unknown
          readonly max_value?: unknown
          readonly null_count?: bigint
        }
      }
    }[]
  }[]
}

/** Minimal Iceberg schema shape accepted by pure stats helpers. */
export interface IcebergSchemaLike {
  readonly fields: readonly {
    readonly id: number
    readonly name: string
    readonly type: string | { readonly type: string }
  }[]
}

type BoundEncodeResult = { _tag: 'Ok', bytes: Uint8Array } | { _tag: 'Err', message: string }

function err(reason: RegisterParquetFilesErrorReason, message: string, fileIndex?: number): Extract<RegisterParquetFilesResult, { _tag: 'Err' }> {
  return fileIndex === undefined
    ? { _tag: 'Err', reason, message }
    : { _tag: 'Err', reason, message, fileIndex }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function parseStrictDateString(value: string): number | null {
  const m = DATE_STRING_RE.exec(value)
  if (!m)
    return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const ms = Date.UTC(year, month - 1, day)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return null
  return toIcebergDayCount(value)
}

function parseIsoTimestampToUnits(value: string, unit: 'micros' | 'nanos'): bigint | null {
  const m = ISO_TIMESTAMP_RE.exec(value)
  if (!m)
    return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  const fracRaw = m[7] ?? ''
  const tz = m[8]!
  // Reject rolled-over calendar dates such as 2026-02-30.
  const dateCheck = new Date(Date.UTC(year, month - 1, day))
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day)
    return null
  if (hour > 23 || minute > 59 || second > 59)
    return null
  const baseMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`)
  if (Number.isNaN(baseMs))
    return null
  if (unit === 'micros') {
    const fracMicros = BigInt(fracRaw.slice(0, 6).padEnd(6, '0'))
    return BigInt(baseMs) * 1000n + fracMicros
  }
  const fracNanos = BigInt(fracRaw.padEnd(9, '0'))
  return BigInt(baseMs) * 1_000_000n + fracNanos
}

function normalizeDateScalar(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? value : null
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      return null
    const days = Math.floor(ms / 86_400_000)
    return days >= INT32_MIN && days <= INT32_MAX ? days : null
  }
  if (typeof value === 'string')
    return parseStrictDateString(value)
  return null
}

function normalizeInt64Scalar(value: unknown): bigint | null {
  if (typeof value === 'bigint')
    return value >= INT64_MIN && value <= INT64_MAX ? value : null
  if (typeof value === 'number')
    return Number.isSafeInteger(value) ? BigInt(value) : null
  return null
}

function normalizeTimestampScalar(value: unknown, unit: 'micros' | 'nanos'): bigint | null {
  if (typeof value === 'bigint')
    return value >= INT64_MIN && value <= INT64_MAX ? value : null
  if (typeof value === 'number')
    return Number.isSafeInteger(value) ? BigInt(value) : null
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      return null
    const factor = unit === 'micros' ? 1000n : 1_000_000n
    const scaled = BigInt(ms) * factor
    return scaled >= INT64_MIN && scaled <= INT64_MAX ? scaled : null
  }
  if (typeof value === 'string') {
    const parsed = parseIsoTimestampToUnits(value, unit)
    return parsed !== null && parsed >= INT64_MIN && parsed <= INT64_MAX ? parsed : null
  }
  return null
}

function fixedByteLength(name: string): number | null {
  const match = /^fixed\[(\d+)\]$/.exec(name)
  if (!match)
    return null
  const len = Number.parseInt(match[1]!, 10)
  return Number.isSafeInteger(len) && len > 0 ? len : null
}

function expectedPreEncodedLength(name: string): number | null {
  const fixedLen = fixedByteLength(name)
  if (fixedLen !== null)
    return fixedLen
  switch (name) {
    case 'boolean': return 1
    case 'int':
    case 'float':
    case 'date': return 4
    case 'long':
    case 'double':
    case 'time':
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp_ns':
    case 'timestamptz_ns': return 8
    case 'uuid': return 16
    default: return null
  }
}

/**
 * Encode one scalar value using Iceberg v2 single-value binary serialization
 * (Apache Iceberg spec Appendix D) for `lower_bounds` / `upper_bounds`.
 *
 * Pre-encoded `Uint8Array` values are validated for exact byte length on
 * fixed-width types and copied through unchanged.
 */
export function encodeIcebergBoundValue(
  value: IcebergBoundScalar,
  type: IcebergBoundType | string,
): BoundEncodeResult {
  const name = typeof type === 'string' ? type : ''
  if (value instanceof Uint8Array) {
    const expected = expectedPreEncodedLength(name)
    if (expected !== null) {
      if (value.byteLength !== expected)
        return { _tag: 'Err', message: `Expected ${expected} bytes for '${name}' bound, got ${value.byteLength}.` }
      return { _tag: 'Ok', bytes: new Uint8Array(value) }
    }
    if (name === 'binary' || name === 'string')
      return { _tag: 'Ok', bytes: new Uint8Array(value) }
    return { _tag: 'Err', message: `Unsupported Iceberg bound type '${name}'.` }
  }

  switch (name) {
    case 'boolean': {
      if (typeof value !== 'boolean')
        return { _tag: 'Err', message: `Expected boolean value for 'boolean' bound.` }
      return { _tag: 'Ok', bytes: new Uint8Array([value ? 1 : 0]) }
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < INT32_MIN || value > INT32_MAX)
        return { _tag: 'Err', message: `Expected 32-bit signed integer for 'int' bound.` }
      const buf = new ArrayBuffer(4)
      new DataView(buf).setInt32(0, value, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'long': {
      const n = normalizeInt64Scalar(value)
      if (n === null)
        return { _tag: 'Err', message: `Expected 64-bit signed integer for 'long' bound.` }
      const buf = new ArrayBuffer(8)
      new DataView(buf).setBigInt64(0, n, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'float': {
      if (typeof value !== 'number' || Number.isNaN(value))
        return { _tag: 'Err', message: `Expected non-NaN number for 'float' bound.` }
      const buf = new ArrayBuffer(4)
      new DataView(buf).setFloat32(0, value, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'double': {
      if (typeof value !== 'number' || Number.isNaN(value))
        return { _tag: 'Err', message: `Expected non-NaN number for 'double' bound.` }
      const buf = new ArrayBuffer(8)
      new DataView(buf).setFloat64(0, value, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'date': {
      const days = normalizeDateScalar(value)
      if (days === null)
        return { _tag: 'Err', message: `Expected day count, Date, or YYYY-MM-DD string for 'date' bound.` }
      const buf = new ArrayBuffer(4)
      new DataView(buf).setInt32(0, days, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'time': {
      const micros = normalizeInt64Scalar(value)
      if (micros === null || micros < 0n)
        return { _tag: 'Err', message: `Expected non-negative microsecond integer for 'time' bound.` }
      const buf = new ArrayBuffer(8)
      new DataView(buf).setBigInt64(0, micros, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'timestamp':
    case 'timestamptz': {
      const micros = normalizeTimestampScalar(value, 'micros')
      if (micros === null)
        return { _tag: 'Err', message: `Expected microsecond integer, Date, or ISO timestamp for '${name}' bound.` }
      const buf = new ArrayBuffer(8)
      new DataView(buf).setBigInt64(0, micros, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'timestamp_ns':
    case 'timestamptz_ns': {
      const nanos = normalizeTimestampScalar(value, 'nanos')
      if (nanos === null)
        return { _tag: 'Err', message: `Expected nanosecond integer, Date, or ISO timestamp for '${name}' bound.` }
      const buf = new ArrayBuffer(8)
      new DataView(buf).setBigInt64(0, nanos, true)
      return { _tag: 'Ok', bytes: new Uint8Array(buf) }
    }
    case 'string': {
      if (typeof value !== 'string')
        return { _tag: 'Err', message: `Expected string value for 'string' bound.` }
      return { _tag: 'Ok', bytes: UTF8_ENCODER.encode(value) }
    }
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_STRING_RE.test(value))
        return { _tag: 'Err', message: `Expected canonical UUID string or 16-byte Uint8Array for 'uuid' bound.` }
      const bytes = serializeValue(value, 'uuid')
      if (!bytes)
        return { _tag: 'Err', message: `Invalid UUID bound value.` }
      return { _tag: 'Ok', bytes }
    }
    default: {
      if (name === 'binary' || fixedByteLength(name) !== null)
        return { _tag: 'Err', message: `Expected Uint8Array for '${name}' bound.` }
      return { _tag: 'Err', message: `Unsupported Iceberg bound type '${name}'.` }
    }
  }
}

function truncateLowerString(value: string, maxCodePoints: number): string {
  const cps = Array.from(value)
  return cps.length <= maxCodePoints ? value : cps.slice(0, maxCodePoints).join('')
}

function truncateUpperString(value: string, maxCodePoints: number): string | undefined {
  const cps = Array.from(value)
  if (cps.length <= maxCodePoints)
    return value
  const prefix = cps.slice(0, maxCodePoints)
  while (prefix.length > 0) {
    const cp = prefix[prefix.length - 1]!.codePointAt(0)!
    const next = cp + 1 === 0xD800 ? 0xE000 : cp + 1
    if (next <= 0x10FFFF) {
      prefix[prefix.length - 1] = String.fromCodePoint(next)
      return prefix.join('')
    }
    prefix.pop()
  }
  return undefined
}

function truncateLowerBytes(value: Uint8Array, maxBytes: number): Uint8Array {
  return value.byteLength <= maxBytes ? value : value.slice(0, maxBytes)
}

function truncateUpperBytes(value: Uint8Array, maxBytes: number): Uint8Array | undefined {
  if (value.byteLength <= maxBytes)
    return value
  const prefix = value.slice(0, maxBytes)
  for (let i = prefix.byteLength - 1; i >= 0; i--) {
    if (prefix[i]! < 0xFF) {
      const out = prefix.slice(0, i + 1)
      out[i] = out[i]! + 1
      return out
    }
  }
  return undefined
}

function floorDivBigInt(n: bigint, d: bigint): bigint {
  return n >= 0n ? n / d : -((-n + d - 1n) / d)
}

function ceilDivBigInt(n: bigint, d: bigint): bigint {
  return n >= 0n ? (n + d - 1n) / d : -((-n) / d)
}

function coerceParquetStatScalar(
  raw: unknown,
  icebergTypeName: string,
  parquetCol: ParquetFileMetadataLike['schema'][number] | undefined,
  boundSide: 'lower' | 'upper',
): IcebergBoundScalar | undefined {
  if (raw === null || raw === undefined)
    return undefined
  switch (icebergTypeName) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined
    case 'int':
      return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= INT32_MIN && raw <= INT32_MAX ? raw : undefined
    case 'long':
      return normalizeInt64Scalar(raw) ?? undefined
    case 'float':
    case 'double':
      return typeof raw === 'number' && !Number.isNaN(raw) ? raw : undefined
    case 'date':
      return normalizeDateScalar(raw) ?? undefined
    case 'time':
      return normalizeInt64Scalar(raw) ?? undefined
    case 'timestamp':
    case 'timestamptz': {
      const isParquetNanos = parquetCol?.logical_type?.type === 'TIMESTAMP' && parquetCol.logical_type.unit === 'NANOS'
      if (isParquetNanos && typeof raw === 'bigint')
        return boundSide === 'lower' ? floorDivBigInt(raw, 1000n) : ceilDivBigInt(raw, 1000n)
      return normalizeTimestampScalar(raw, 'micros') ?? undefined
    }
    case 'timestamp_ns':
    case 'timestamptz_ns': {
      const isParquetNanos = parquetCol?.logical_type?.type === 'TIMESTAMP' && parquetCol.logical_type.unit === 'NANOS'
      if (isParquetNanos)
        return normalizeTimestampScalar(raw, 'nanos') ?? undefined
      const micros = normalizeTimestampScalar(raw, 'micros')
      return micros !== null ? micros * 1000n : undefined
    }
    case 'string': {
      if (typeof raw === 'string')
        return raw
      if (raw instanceof Uint8Array)
        return UTF8_DECODER.decode(raw)
      return undefined
    }
    case 'binary':
      return raw instanceof Uint8Array ? raw : undefined
    case 'uuid':
      if (raw instanceof Uint8Array && raw.byteLength === 16)
        return raw
      if (typeof raw === 'string' && UUID_STRING_RE.test(raw))
        return raw
      return undefined
    default: {
      const fixedLen = fixedByteLength(icebergTypeName)
      if (fixedLen !== null && raw instanceof Uint8Array && raw.byteLength === fixedLen)
        return raw
      return undefined
    }
  }
}

/**
 * Extract Iceberg column statistics (column sizes, value/null counts,
 * lower/upper bounds, and split offsets) from a parsed Parquet footer.
 *
 * Matches Parquet columns to Iceberg fields by `field_id` first, falling back
 * to top-level column name (the default output of DuckDB `COPY ... TO ... (FORMAT PARQUET)`).
 * Unsound partial bounds (where a non-all-null row group lacks min/max) are
 * omitted so readers always fail open rather than falsely pruning data.
 */
export function extractParquetColumnStats(
  fileMeta: ParquetFileMetadataLike,
  schema: IcebergSchemaLike,
): ParquetFileColumnStats {
  const leafFieldsById = new Map<number, { id: number, name: string, type: string }>()
  const leafFieldsByName = new Map<string, { id: number, name: string, type: string }>()
  for (const field of schema.fields) {
    const tName = typeof field.type === 'string' ? field.type : field.type.type
    if (tName === 'struct' || tName === 'list' || tName === 'map' || tName === 'unknown')
      continue
    const entry = { id: field.id, name: field.name, type: tName }
    leafFieldsById.set(field.id, entry)
    leafFieldsByName.set(field.name, entry)
  }

  // Leaf schema elements in Parquet column-chunk order.
  const parquetLeafCols = fileMeta.schema.filter(el => el.type !== undefined)
  const parquetColByName = new Map<string, ParquetFileMetadataLike['schema'][number]>()
  for (const col of parquetLeafCols)
    parquetColByName.set(col.name, col)

  interface ColumnAccumulator {
    field: { id: number, name: string, type: string }
    size: bigint
    values: bigint
    nulls: bigint
    hasAllNullCounts: boolean
    min?: IcebergBoundScalar
    max?: IcebergBoundScalar
    missingMin: boolean
    missingMax: boolean
  }

  const accByFieldId = new Map<number, ColumnAccumulator>()
  const splitOffsetSet = new Set<bigint>()

  for (const rg of fileMeta.row_groups) {
    let rgSplitOffset: bigint | undefined
    for (let colIdx = 0; colIdx < rg.columns.length; colIdx++) {
      const chunk = rg.columns[colIdx]!
      const meta = chunk.meta_data
      if (!meta)
        continue
      const firstOffset = meta.dictionary_page_offset !== undefined && meta.dictionary_page_offset < meta.data_page_offset
        ? meta.dictionary_page_offset
        : meta.data_page_offset
      if (rgSplitOffset === undefined || firstOffset < rgSplitOffset)
        rgSplitOffset = firstOffset

      if (meta.path_in_schema.length !== 1)
        continue
      const colName = meta.path_in_schema[0]!
      const parquetCol = parquetLeafCols[colIdx]?.name === colName
        ? parquetLeafCols[colIdx]
        : parquetColByName.get(colName)
      const icebergField = (parquetCol?.field_id !== undefined ? leafFieldsById.get(parquetCol.field_id) : undefined)
        ?? leafFieldsByName.get(colName)
      if (!icebergField)
        continue

      let acc = accByFieldId.get(icebergField.id)
      if (!acc) {
        acc = {
          field: icebergField,
          size: 0n,
          values: 0n,
          nulls: 0n,
          hasAllNullCounts: true,
          missingMin: false,
          missingMax: false,
        }
        accByFieldId.set(icebergField.id, acc)
      }

      acc.size += meta.total_compressed_size
      acc.values += meta.num_values

      const stats = meta.statistics
      if (stats?.null_count !== undefined) {
        acc.nulls += stats.null_count
      }
      else {
        acc.hasAllNullCounts = false
      }

      // An all-null row group contributes no non-null min/max and must not invalidate
      // bounds computed from other row groups.
      const allNullRowGroup = stats?.null_count !== undefined && stats.null_count === meta.num_values
      if (allNullRowGroup || meta.num_values === 0n)
        continue

      // Per Parquet/Iceberg spec, deprecated `min`/`max` on BYTE_ARRAY used signed
      // byte ordering and must NOT be trusted for string/binary/uuid/fixed bounds.
      const useUnsignedOnly = icebergField.type === 'string'
        || icebergField.type === 'binary'
        || icebergField.type === 'uuid'
        || icebergField.type.startsWith('fixed[')
      const rawMin = useUnsignedOnly ? stats?.min_value : (stats?.min_value ?? stats?.min)
      const rawMax = useUnsignedOnly ? stats?.max_value : (stats?.max_value ?? stats?.max)

      const coercedMin = coerceParquetStatScalar(rawMin, icebergField.type, parquetCol, 'lower')
      const coercedMax = coerceParquetStatScalar(rawMax, icebergField.type, parquetCol, 'upper')

      if (coercedMin === undefined) {
        acc.missingMin = true
      }
      else if (!acc.missingMin) {
        if (acc.min === undefined || compare(coercedMin, acc.min, icebergField.type as never) < 0)
          acc.min = coercedMin
      }

      if (coercedMax === undefined) {
        acc.missingMax = true
      }
      else if (!acc.missingMax) {
        if (acc.max === undefined || compare(coercedMax, acc.max, icebergField.type as never) > 0)
          acc.max = coercedMax
      }
    }
    if (rgSplitOffset !== undefined)
      splitOffsetSet.add(rgSplitOffset)
  }

  const columnSizes: Record<number, bigint> = {}
  const valueCounts: Record<number, bigint> = {}
  const nullValueCounts: Record<number, bigint> = {}
  const lowerBounds: Record<number, IcebergBoundScalar> = {}
  const upperBounds: Record<number, IcebergBoundScalar> = {}

  for (const acc of accByFieldId.values()) {
    columnSizes[acc.field.id] = acc.size
    valueCounts[acc.field.id] = acc.values
    if (acc.hasAllNullCounts)
      nullValueCounts[acc.field.id] = acc.nulls

    if (!acc.missingMin && acc.min !== undefined) {
      if (acc.field.type === 'string' && typeof acc.min === 'string')
        lowerBounds[acc.field.id] = truncateLowerString(acc.min, PARQUET_STRING_BOUND_TRUNCATE_CODEPOINTS)
      else if (acc.field.type === 'binary' && acc.min instanceof Uint8Array)
        lowerBounds[acc.field.id] = truncateLowerBytes(acc.min, PARQUET_BINARY_BOUND_TRUNCATE_BYTES)
      else
        lowerBounds[acc.field.id] = acc.min
    }

    if (!acc.missingMax && acc.max !== undefined) {
      if (acc.field.type === 'string' && typeof acc.max === 'string') {
        const truncated = truncateUpperString(acc.max, PARQUET_STRING_BOUND_TRUNCATE_CODEPOINTS)
        if (truncated !== undefined)
          upperBounds[acc.field.id] = truncated
      }
      else if (acc.field.type === 'binary' && acc.max instanceof Uint8Array) {
        const truncated = truncateUpperBytes(acc.max, PARQUET_BINARY_BOUND_TRUNCATE_BYTES)
        if (truncated !== undefined)
          upperBounds[acc.field.id] = truncated
      }
      else {
        upperBounds[acc.field.id] = acc.max
      }
    }
  }

  const splitOffsets = [...splitOffsetSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return {
    ...(Object.keys(columnSizes).length > 0 ? { columnSizes } : {}),
    ...(Object.keys(valueCounts).length > 0 ? { valueCounts } : {}),
    ...(Object.keys(nullValueCounts).length > 0 ? { nullValueCounts } : {}),
    ...(Object.keys(lowerBounds).length > 0 ? { lowerBounds } : {}),
    ...(Object.keys(upperBounds).length > 0 ? { upperBounds } : {}),
    ...(splitOffsets.length > 0 ? { splitOffsets } : {}),
  }
}

function validateBasicInputs(
  files: readonly ParquetFileDescriptor[],
  opts: RegisterParquetFilesOptions,
): Extract<RegisterParquetFilesResult, { _tag: 'Err' }> | null {
  if (typeof opts.appendId !== 'string' || opts.appendId.trim().length === 0)
    return err('invalid-append-id', 'appendId must be a non-empty string.')
  if (!Array.isArray(files) || files.length === 0)
    return err('empty-files', 'files must contain at least one Parquet file descriptor.')
  if (opts.sortOrderId !== undefined && (!Number.isSafeInteger(opts.sortOrderId) || opts.sortOrderId < 0))
    return err('invalid-descriptor', 'Default sortOrderId must be a non-negative safe integer.')

  const seenPaths = new Set<string>()
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    if (!file || typeof file !== 'object')
      return err('invalid-descriptor', `Descriptor at index ${i} must be an object.`, i)
    if (typeof file.path !== 'string' || file.path.length === 0 || file.path.trim() !== file.path)
      return err('invalid-descriptor', `Descriptor at index ${i} has an invalid path.`, i)
    if (seenPaths.has(file.path))
      return err('invalid-descriptor', `Duplicate Parquet file path '${file.path}'.`, i)
    seenPaths.add(file.path)
    if (!Number.isSafeInteger(file.fileSizeBytes) || file.fileSizeBytes <= 0)
      return err('invalid-descriptor', `Descriptor '${file.path}' must have a positive safe integer fileSizeBytes.`, i)
    if (!Number.isSafeInteger(file.recordCount) || file.recordCount <= 0)
      return err('invalid-descriptor', `Descriptor '${file.path}' must have a positive safe integer recordCount.`, i)
    if (!isPlainRecord(file.partition))
      return err('invalid-descriptor', `Descriptor '${file.path}' must supply a partition object.`, i)
    if (file.sortOrderId !== undefined && (!Number.isSafeInteger(file.sortOrderId) || file.sortOrderId < 0))
      return err('invalid-descriptor', `Descriptor '${file.path}' has an invalid sortOrderId.`, i)
  }
  return null
}

function coercePartitionFieldValue(
  value: unknown,
  resultType: string,
): { _tag: 'Ok', value: unknown } | { _tag: 'Err', message: string } {
  switch (resultType) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { _tag: 'Ok', value }
        : { _tag: 'Err', message: `Expected boolean value.` }
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX
        ? { _tag: 'Ok', value }
        : { _tag: 'Err', message: `Expected 32-bit signed integer value.` }
    case 'long': {
      const n = normalizeInt64Scalar(value)
      return n !== null
        ? { _tag: 'Ok', value: n }
        : { _tag: 'Err', message: `Expected 64-bit signed integer value.` }
    }
    case 'float':
    case 'double':
      return typeof value === 'number' && !Number.isNaN(value)
        ? { _tag: 'Ok', value }
        : { _tag: 'Err', message: `Expected non-NaN number value.` }
    case 'date': {
      const days = normalizeDateScalar(value)
      return days !== null
        ? { _tag: 'Ok', value: days }
        : { _tag: 'Err', message: `Expected day count, Date, or YYYY-MM-DD string.` }
    }
    case 'time': {
      const micros = normalizeInt64Scalar(value)
      return micros !== null && micros >= 0n
        ? { _tag: 'Ok', value: micros }
        : { _tag: 'Err', message: `Expected non-negative microsecond integer.` }
    }
    case 'timestamp':
    case 'timestamptz': {
      const micros = normalizeTimestampScalar(value, 'micros')
      return micros !== null
        ? { _tag: 'Ok', value: micros }
        : { _tag: 'Err', message: `Expected microsecond integer, Date, or ISO timestamp.` }
    }
    case 'timestamp_ns':
    case 'timestamptz_ns': {
      const nanos = normalizeTimestampScalar(value, 'nanos')
      return nanos !== null
        ? { _tag: 'Ok', value: nanos }
        : { _tag: 'Err', message: `Expected nanosecond integer, Date, or ISO timestamp.` }
    }
    case 'string':
      return typeof value === 'string'
        ? { _tag: 'Ok', value }
        : { _tag: 'Err', message: `Expected string value.` }
    case 'binary':
      return value instanceof Uint8Array
        ? { _tag: 'Ok', value }
        : { _tag: 'Err', message: `Expected Uint8Array value.` }
    case 'uuid':
      if (value instanceof Uint8Array && value.byteLength === 16)
        return { _tag: 'Ok', value }
      if (typeof value === 'string' && UUID_STRING_RE.test(value))
        return { _tag: 'Ok', value }
      return { _tag: 'Err', message: `Expected canonical UUID string or 16-byte Uint8Array.` }
    default: {
      const fixedLen = fixedByteLength(resultType)
      if (fixedLen !== null) {
        return value instanceof Uint8Array && value.byteLength === fixedLen
          ? { _tag: 'Ok', value }
          : { _tag: 'Err', message: `Expected ${fixedLen}-byte Uint8Array.` }
      }
      return { _tag: 'Err', message: `Unsupported partition type '${resultType}'.` }
    }
  }
}

function parseNonNegativeBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint')
    return value >= 0n && value <= INT64_MAX ? value : null
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  return null
}

function partitionSignature(partition: Record<string, unknown>, partitionSpec: PartitionSpec): string {
  return JSON.stringify(partitionSpec.fields.map((pf) => {
    const v = partition[pf.name]
    if (v === null || v === undefined)
      return null
    if (typeof v === 'bigint')
      return `b:${v.toString()}`
    if (v instanceof Uint8Array)
      return `x:${Array.from(v, byte => byte.toString(16).padStart(2, '0')).join('')}`
    return `${typeof v}:${String(v)}`
  }))
}

interface BuiltDataFiles {
  dataFiles: DataFile[]
  totalRecords: number
  totalBytes: number
  changedPartitionCount: number
}

function validateAndBuildDataFiles(
  files: readonly ParquetFileDescriptor[],
  schema: Schema,
  partitionSpec: PartitionSpec,
  sortOrders: readonly SortOrder[],
  defaultSortOrderId: number,
): { _tag: 'Ok', value: BuiltDataFiles } | Extract<RegisterParquetFilesResult, { _tag: 'Err' }> {
  const fieldsById = new Map<number, Schema['fields'][number]>()
  const fieldsByName = new Map<string, Schema['fields'][number]>()
  for (const field of schema.fields) {
    fieldsById.set(field.id, field)
    fieldsByName.set(field.name, field)
  }

  const validSortOrderIds = new Set<number>([0, ...sortOrders.map(order => order['order-id'])])
  if (!validSortOrderIds.has(defaultSortOrderId))
    return err('invalid-descriptor', `Sort order ${defaultSortOrderId} not found in table metadata.`)

  const partitionFieldMeta = partitionSpec.fields.map((pf) => {
    const sourceId = pf['source-id']
    const sourceField = sourceId !== undefined ? fieldsById.get(sourceId) : undefined
    if (!sourceField)
      return null
    const resultType = typeName(transformResultType(pf.transform, sourceField.type))
    return {
      name: pf.name,
      transform: pf.transform,
      required: sourceField.required && pf.transform !== 'void',
      resultType,
    }
  })
  if (partitionFieldMeta.includes(null))
    return err('unsupported-format', 'Table default partition spec references a missing schema field.')

  const resolvedPartitionFields = partitionFieldMeta as NonNullable<(typeof partitionFieldMeta)[number]>[]
  const allowedPartitionNames = new Set(resolvedPartitionFields.map(f => f.name))

  const resolveColumnField = (key: string): Schema['fields'][number] | null => {
    const byName = fieldsByName.get(key)
    if (byName)
      return byName
    if (/^\d+$/.test(key)) {
      const id = Number(key)
      return fieldsById.get(id) ?? null
    }
    return null
  }

  const parseStatCountMap = (
    raw: Readonly<Record<string | number, number | bigint>> | undefined,
    statName: string,
    fileIndex: number,
  ): { _tag: 'Ok', map?: Record<number, bigint> } | Extract<RegisterParquetFilesResult, { _tag: 'Err' }> => {
    if (!raw)
      return { _tag: 'Ok' }
    const out: Record<number, bigint> = {}
    for (const [key, value] of Object.entries(raw)) {
      const field = resolveColumnField(key)
      if (!field)
        return err('invalid-column-stats', `${statName} references unknown column '${key}'.`, fileIndex)
      const fType = typeName(field.type)
      if (fType === 'struct' || fType === 'list' || fType === 'map' || fType === 'unknown')
        return err('invalid-column-stats', `${statName} cannot target non-leaf column '${field.name}'.`, fileIndex)
      if (field.id in out)
        return err('invalid-column-stats', `${statName} specifies column '${field.name}' (field id ${field.id}) more than once.`, fileIndex)
      const count = parseNonNegativeBigInt(value)
      if (count === null)
        return err('invalid-column-stats', `${statName} for column '${field.name}' must be a non-negative integer.`, fileIndex)
      out[field.id] = count
    }
    return Object.keys(out).length > 0 ? { _tag: 'Ok', map: out } : { _tag: 'Ok' }
  }

  const parseBoundsMap = (
    raw: Readonly<Record<string | number, IcebergBoundScalar>> | undefined,
    statName: string,
    fileIndex: number,
  ): {
    _tag: 'Ok'
    bytes?: Record<number, Uint8Array>
    scalars?: Map<number, { value: IcebergBoundScalar, type: Schema['fields'][number]['type'], name: string }>
  } | Extract<RegisterParquetFilesResult, { _tag: 'Err' }> => {
    if (!raw)
      return { _tag: 'Ok' }
    const bytes: Record<number, Uint8Array> = {}
    const scalars = new Map<number, { value: IcebergBoundScalar, type: Schema['fields'][number]['type'], name: string }>()
    for (const [key, value] of Object.entries(raw)) {
      const field = resolveColumnField(key)
      if (!field)
        return err('invalid-column-stats', `${statName} references unknown column '${key}'.`, fileIndex)
      const fType = typeName(field.type)
      if (fType === 'struct' || fType === 'list' || fType === 'map' || fType === 'unknown')
        return err('invalid-column-stats', `${statName} cannot target non-leaf column '${field.name}'.`, fileIndex)
      if (field.id in bytes)
        return err('invalid-column-stats', `${statName} specifies column '${field.name}' (field id ${field.id}) more than once.`, fileIndex)
      const encoded = encodeIcebergBoundValue(value, fType)
      if (encoded._tag === 'Err')
        return err('invalid-column-stats', `${statName} for column '${field.name}': ${encoded.message}`, fileIndex)
      bytes[field.id] = encoded.bytes
      if (!(value instanceof Uint8Array))
        scalars.set(field.id, { value, type: field.type, name: field.name })
    }
    return Object.keys(bytes).length > 0 ? { _tag: 'Ok', bytes, scalars } : { _tag: 'Ok' }
  }

  const dataFiles: DataFile[] = []
  const distinctPartitions = new Set<string>()
  let totalRecords = 0
  let totalBytes = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    const sortOrderId = file.sortOrderId ?? defaultSortOrderId
    if (!validSortOrderIds.has(sortOrderId))
      return err('invalid-descriptor', `Descriptor '${file.path}' references unknown sort order ${sortOrderId}.`, i)

    for (const key of Object.keys(file.partition)) {
      if (!allowedPartitionNames.has(key))
        return err('invalid-partition', `Unknown partition field '${key}' for '${file.path}'.`, i)
    }

    const normalizedPartition: Record<string, unknown> = {}
    for (const pf of resolvedPartitionFields) {
      const hasField = Object.hasOwn(file.partition, pf.name)
      if (!hasField) {
        if (pf.transform === 'void') {
          normalizedPartition[pf.name] = null
          continue
        }
        return err('invalid-partition', `Missing required partition field '${pf.name}' for '${file.path}'.`, i)
      }
      const rawVal = file.partition[pf.name]
      if (rawVal === null || rawVal === undefined) {
        if (pf.required)
          return err('invalid-partition', `Partition field '${pf.name}' cannot be null for '${file.path}'.`, i)
        normalizedPartition[pf.name] = null
        continue
      }
      if (pf.transform === 'void') {
        normalizedPartition[pf.name] = null
        continue
      }
      const coerced = coercePartitionFieldValue(rawVal, pf.resultType)
      if (coerced._tag === 'Err')
        return err('invalid-partition', `Invalid partition field '${pf.name}' for '${file.path}': ${coerced.message}`, i)
      normalizedPartition[pf.name] = coerced.value
    }

    const stats = file.columnStats
    const columnSizes = parseStatCountMap(stats?.columnSizes, 'columnSizes', i)
    if (columnSizes._tag === 'Err')
      return columnSizes
    const valueCounts = parseStatCountMap(stats?.valueCounts, 'valueCounts', i)
    if (valueCounts._tag === 'Err')
      return valueCounts
    const nullValueCounts = parseStatCountMap(stats?.nullValueCounts, 'nullValueCounts', i)
    if (nullValueCounts._tag === 'Err')
      return nullValueCounts
    const nanValueCounts = parseStatCountMap(stats?.nanValueCounts, 'nanValueCounts', i)
    if (nanValueCounts._tag === 'Err')
      return nanValueCounts
    const lowerBounds = parseBoundsMap(stats?.lowerBounds, 'lowerBounds', i)
    if (lowerBounds._tag === 'Err')
      return lowerBounds
    const upperBounds = parseBoundsMap(stats?.upperBounds, 'upperBounds', i)
    if (upperBounds._tag === 'Err')
      return upperBounds

    // Verify lowerBound <= upperBound whenever both typed scalars were supplied.
    if (lowerBounds.scalars && upperBounds.scalars) {
      for (const [fieldId, lo] of lowerBounds.scalars) {
        const hi = upperBounds.scalars.get(fieldId)
        if (!hi)
          continue
        const t = typeName(lo.type)
        const cmp = compareNormalizedBounds(lo.value, hi.value, t, lo.type)
        if (cmp > 0)
          return err('invalid-column-stats', `lowerBounds exceeds upperBounds for column '${lo.name}'.`, i)
      }
    }

    let splitOffsets: bigint[] | undefined
    if (stats?.splitOffsets && stats.splitOffsets.length > 0) {
      const parsed: bigint[] = []
      for (const offset of stats.splitOffsets) {
        const n = parseNonNegativeBigInt(offset)
        if (n === null)
          return err('invalid-column-stats', `splitOffsets for '${file.path}' must contain non-negative integers.`, i)
        parsed.push(n)
      }
      parsed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      splitOffsets = parsed
    }

    distinctPartitions.add(partitionSignature(normalizedPartition, partitionSpec))
    totalRecords += file.recordCount
    totalBytes += file.fileSizeBytes

    const dataFile: DataFile = {
      content: 0,
      file_path: file.path,
      file_format: 'parquet',
      partition: normalizedPartition,
      record_count: BigInt(file.recordCount),
      file_size_in_bytes: BigInt(file.fileSizeBytes),
      ...(columnSizes.map ? { column_sizes: columnSizes.map } : {}),
      ...(valueCounts.map ? { value_counts: valueCounts.map } : {}),
      ...(nullValueCounts.map ? { null_value_counts: nullValueCounts.map } : {}),
      ...(nanValueCounts.map ? { nan_value_counts: nanValueCounts.map } : {}),
      ...(lowerBounds.bytes ? { lower_bounds: lowerBounds.bytes } : {}),
      ...(upperBounds.bytes ? { upper_bounds: upperBounds.bytes } : {}),
      ...(splitOffsets ? { split_offsets: splitOffsets } : {}),
      sort_order_id: sortOrderId,
    }
    dataFiles.push(dataFile)
  }

  return {
    _tag: 'Ok',
    value: {
      dataFiles,
      totalRecords,
      totalBytes,
      changedPartitionCount: distinctPartitions.size,
    },
  }
}

function compareNormalizedBounds(
  a: IcebergBoundScalar,
  b: IcebergBoundScalar,
  tName: string,
  icebergType: Schema['fields'][number]['type'],
): number {
  if (tName === 'string' && typeof a === 'string' && typeof b === 'string')
    return compareStringsCodePoint(a, b)
  if (tName === 'date') {
    const ad = normalizeDateScalar(a)!
    const bd = normalizeDateScalar(b)!
    return ad < bd ? -1 : ad > bd ? 1 : 0
  }
  if (tName === 'timestamp' || tName === 'timestamptz') {
    const at = normalizeTimestampScalar(a, 'micros')!
    const bt = normalizeTimestampScalar(b, 'micros')!
    return at < bt ? -1 : at > bt ? 1 : 0
  }
  if (tName === 'timestamp_ns' || tName === 'timestamptz_ns') {
    const at = normalizeTimestampScalar(a, 'nanos')!
    const bt = normalizeTimestampScalar(b, 'nanos')!
    return at < bt ? -1 : at > bt ? 1 : 0
  }
  return compare(a, b, icebergType)
}

function findSnapshotByAppendId(metadata: TableMetadata, appendId: string): NonNullable<TableMetadata['snapshots']>[number] | undefined {
  return metadata.snapshots?.find(
    snapshot => (snapshot.summary as Record<string, string> | undefined)?.[APPEND_ID_SUMMARY_KEY] === appendId,
  )
}

function isCommitConflict(error: unknown): boolean {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return status === 409 || status === 412
}

function parseTablePropNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '')
    return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0)
    return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildAppendSummary(
  metadata: TableMetadata,
  built: BuiltDataFiles,
  appendId: string,
  extraProperties: Readonly<Record<string, string>> | undefined,
): NonNullable<TableMetadata['snapshots']>[number]['summary'] {
  const prevSummary = currentSnapshot(metadata)?.summary
  const prevTotals = {
    records: BigInt(prevSummary?.['total-records'] ?? '0'),
    size: BigInt(prevSummary?.['total-files-size'] ?? '0'),
    files: BigInt(prevSummary?.['total-data-files'] ?? '0'),
    deleteFiles: BigInt(prevSummary?.['total-delete-files'] ?? '0'),
    positionDeletes: BigInt(prevSummary?.['total-position-deletes'] ?? '0'),
    equalityDeletes: BigInt(prevSummary?.['total-equality-deletes'] ?? '0'),
  }
  const safeExtra: Record<string, string> = {}
  if (extraProperties) {
    for (const [key, value] of Object.entries(extraProperties)) {
      if (!RESERVED_SUMMARY_KEYS.has(key))
        safeExtra[key] = value
    }
  }
  const summary: Record<string, string> = {
    ...safeExtra,
    'operation': 'append',
    'added-data-files': String(built.dataFiles.length),
    'added-records': String(built.totalRecords),
    'added-files-size': String(built.totalBytes),
    'changed-partition-count': String(built.changedPartitionCount),
    'total-records': String(prevTotals.records + BigInt(built.totalRecords)),
    'total-files-size': String(prevTotals.size + BigInt(built.totalBytes)),
    'total-data-files': String(prevTotals.files + BigInt(built.dataFiles.length)),
    'total-delete-files': String(prevTotals.deleteFiles),
    'total-position-deletes': String(prevTotals.positionDeletes),
    'total-equality-deletes': String(prevTotals.equalityDeletes),
    [APPEND_ID_SUMMARY_KEY]: appendId,
  }
  return summary as NonNullable<TableMetadata['snapshots']>[number]['summary']
}

/**
 * Register already-written Parquet data files (including ZSTD-compressed DuckDB
 * Parquets) directly into an Iceberg table as ONE atomic append snapshot and
 * ONE Avro data manifest, without reading or re-encoding row data in JS.
 *
 * Guarantees:
 * - **Idempotent**: stamps `summary['lakehouse.append-id'] = appendId`. If the
 *   token already exists before staging, after a conflict reload, or after an
 *   ambiguous transient failure, returns `{ _tag: 'AlreadyApplied', snapshotId }`
 *   (or `{ _tag: 'Registered', ... }` when this call's own snapshot landed)
 *   without duplicating manifest entries.
 * - **Atomic multi-file commit**: every file in `files` is written into a single
 *   Avro data manifest and committed in a single Iceberg REST update.
 * - **Optimistic concurrency rebase**: on `409` / `412` conflicts, reloads fresh
 *   table metadata and re-stages only the manifest list, reusing the already-written
 *   data manifest per Iceberg v2 Manifest Inheritance.
 * - **Transient retry**: retries `429` rate limits and `5xx` blips with full-jitter
 *   exponential backoff and landed-check protection.
 */
export async function registerIcebergParquetFiles(
  conn: IcebergConnection,
  table: string,
  files: readonly ParquetFileDescriptor[],
  opts: RegisterParquetFilesOptions,
): Promise<RegisterParquetFilesResult> {
  const basicErr = validateBasicInputs(files, opts)
  if (basicErr)
    return basicErr
  if (!conn.resolver.writer)
    throw new Error('registerIcebergParquetFiles requires conn.resolver.writer')
  const writerFn = conn.resolver.writer

  const appendId = opts.appendId
  const maxTransientAttempts = opts.commitRetry?.maxAttempts ?? 6
  const baseDelayMs = opts.commitRetry?.baseDelayMs ?? 1000
  const maxDelayMs = opts.commitRetry?.maxDelayMs ?? 20_000
  const sleep = opts.commitRetry?.sleep ?? defaultSleep
  const random = opts.commitRetry?.random ?? Math.random
  const clock = opts.clock ?? Date.now

  let workingMetadata = (await restCatalogLoadTable(conn.catalog, {
    namespace: conn.namespace,
    table,
  })).metadata

  const preExisting = findSnapshotByAppendId(workingMetadata, appendId)
  if (preExisting)
    return { _tag: 'AlreadyApplied', snapshotId: String(preExisting['snapshot-id']) }

  const rawFormatVersion = workingMetadata['format-version']
  if (rawFormatVersion !== 2 && rawFormatVersion !== 3)
    return err('unsupported-format', `Unsupported Iceberg format-version: ${String(rawFormatVersion)}.`)
  const formatVersion = rawFormatVersion as 2 | 3

  const schema = workingMetadata.schemas?.find(s => s['schema-id'] === workingMetadata['current-schema-id'])
  if (!schema)
    return err('unsupported-format', 'Current schema not found in table metadata.')
  validateSchemaForVersion(schema, formatVersion)

  const partitionSpec = workingMetadata['partition-specs']?.find(s => s['spec-id'] === workingMetadata['default-spec-id'])
  if (!partitionSpec)
    return err('unsupported-format', 'Default partition spec not found in table metadata.')

  // Optional Parquet footer metadata extraction for files that omit columnStats.
  const enrichedFiles: ParquetFileDescriptor[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    if (file.columnStats !== undefined || !opts.readParquetMetadata) {
      enrichedFiles.push(file)
      continue
    }
    const asyncBuffer = await conn.resolver.reader(file.path, file.fileSizeBytes)
    const fileMeta = await parquetMetadataAsync(asyncBuffer, {
      geoparquet: false,
      parsers: {
        dateFromDays: days => days,
        timestampFromMilliseconds: millis => millis * 1000n,
        timestampFromMicroseconds: micros => micros,
        timestampFromNanoseconds: nanos => nanos,
        stringFromBytes: bytes => bytes,
      },
    })
    if (fileMeta.num_rows !== BigInt(file.recordCount)) {
      return err(
        'invalid-descriptor',
        `Descriptor '${file.path}' declared recordCount=${file.recordCount}, but Parquet footer reports ${fileMeta.num_rows}.`,
        i,
      )
    }
    enrichedFiles.push({
      ...file,
      columnStats: extractParquetColumnStats(fileMeta, schema),
    })
  }

  const builtResult = validateAndBuildDataFiles(
    enrichedFiles,
    schema,
    partitionSpec,
    workingMetadata['sort-orders'] ?? [],
    opts.sortOrderId ?? 0,
  )
  if (builtResult._tag === 'Err')
    return builtResult
  const built = builtResult.value

  // Phase 1 (once, outside retry loop): write ONE Avro data manifest covering all files.
  // Manifest Inheritance (Iceberg v2) leaves sequence_number = null on ADDED entries,
  // so 409/412 conflict rebases reuse this exact manifest without rewriting it.
  const tableUrl = workingMetadata.location
  const snapshotId = newSnapshotId(workingMetadata)
  const manifestUuid = uuid4()
  const manifestPath = `${tableUrl}/metadata/${manifestUuid}-m0.avro`

  let manifestLength = 0n
  for (let attempt = 0; attempt < maxTransientAttempts; attempt++) {
    const manifestWriter = writerFn(manifestPath)
    const writeErr = await Promise.resolve()
      .then(() => writeDataManifest({
        writer: manifestWriter,
        schema,
        partitionSpec,
        snapshotId,
        dataFiles: built.dataFiles,
        formatVersion,
      }))
      .then(() => undefined, (e: unknown) => e)
    if (writeErr === undefined) {
      manifestLength = BigInt(manifestWriter.offset)
      break
    }
    if (!isCommitTransient(writeErr) || attempt === maxTransientAttempts - 1)
      throw writeErr
    workingMetadata = (await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })).metadata
    const landed = findSnapshotByAppendId(workingMetadata, appendId)
    if (landed)
      return { _tag: 'AlreadyApplied', snapshotId: String(landed['snapshot-id']) }
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(Math.floor(random() * ceiling))
  }

  const partitions = buildPartitionSummaries(
    built.dataFiles.map(df => df.partition),
    schema,
    partitionSpec,
  )

  const props = workingMetadata.properties ?? {}
  const maxConflictRetries = opts.maxConflictRetries
    ?? parseTablePropNumber(props['commit.retry.num-retries'])
    ?? DEFAULT_MAX_CONFLICT_RETRIES
  const conflictMinWaitMs = parseTablePropNumber(props['commit.retry.min-wait-ms']) ?? DEFAULT_CONFLICT_MIN_WAIT_MS
  const conflictMaxWaitMs = parseTablePropNumber(props['commit.retry.max-wait-ms']) ?? DEFAULT_CONFLICT_MAX_WAIT_MS

  // Phase 2: stage manifest-list + atomic REST commit with 409/412 rebase and 429/5xx retry.
  let conflictAttempts = 0
  let transientAttempts = 0

  for (;;) {
    const already = findSnapshotByAppendId(workingMetadata, appendId)
    if (already)
      return { _tag: 'AlreadyApplied', snapshotId: String(already['snapshot-id']) }

    const sequenceNumber = BigInt(workingMetadata['last-sequence-number'] ?? 0) + 1n
    const newManifest: Manifest = {
      manifest_path: manifestPath,
      manifest_length: manifestLength,
      partition_spec_id: partitionSpec['spec-id'],
      content: 0,
      sequence_number: sequenceNumber,
      min_sequence_number: sequenceNumber,
      added_snapshot_id: snapshotId,
      added_files_count: built.dataFiles.length,
      existing_files_count: 0,
      deleted_files_count: 0,
      added_rows_count: BigInt(built.totalRecords),
      existing_rows_count: 0n,
      deleted_rows_count: 0n,
      partitions,
    }
    const summary = buildAppendSummary(workingMetadata, built, appendId, opts.snapshotProperties)

    const commitOutcome = await buildSnapshotUpdate({
      tableUrl,
      metadata: workingMetadata,
      resolver: conn.resolver,
      snapshotId,
      sequenceNumber,
      manifestUuid: uuid4(),
      timestampMs: clock(),
      formatVersion,
      newManifests: [newManifest],
      summary,
      writtenFiles: [manifestPath],
    })
      .then(staged => restCatalogUpdateTable(conn.catalog, {
        namespace: conn.namespace,
        table,
        requirements: staged.requirements,
        updates: staged.updates,
      }))
      .then(
        () => ({ _tag: 'Committed' as const }),
        (error: unknown) => ({ _tag: 'Failed' as const, error }),
      )

    if (commitOutcome._tag === 'Committed') {
      if (opts.cache)
        await invalidateSnapshotRef(opts.cache, conn.namespace, table, conn.cacheScope)
      return {
        _tag: 'Registered',
        snapshotId: String(snapshotId),
        manifestPath,
        fileCount: built.dataFiles.length,
        recordCount: built.totalRecords,
        totalBytes: built.totalBytes,
      }
    }

    const { error } = commitOutcome
    if (isCommitConflict(error)) {
      if (conflictAttempts >= maxConflictRetries) {
        throw new Error(
          `rest catalog commit failed after ${conflictAttempts + 1} attempts due to concurrent commits`,
          { cause: error },
        )
      }
      conflictAttempts++
      const ceiling = conflictMinWaitMs === 0 || conflictMaxWaitMs === 0
        ? 0
        : Math.min(conflictMaxWaitMs, conflictMinWaitMs * 2 ** (conflictAttempts - 1))
      await sleep(Math.floor(random() * ceiling))
      workingMetadata = (await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })).metadata
      continue
    }

    if (isCommitTransient(error)) {
      workingMetadata = (await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })).metadata
      const landed = findSnapshotByAppendId(workingMetadata, appendId)
      if (landed) {
        if (opts.cache)
          await invalidateSnapshotRef(opts.cache, conn.namespace, table, conn.cacheScope)
        if (String(landed['snapshot-id']) === String(snapshotId)) {
          return {
            _tag: 'Registered',
            snapshotId: String(snapshotId),
            manifestPath,
            fileCount: built.dataFiles.length,
            recordCount: built.totalRecords,
            totalBytes: built.totalBytes,
          }
        }
        return { _tag: 'AlreadyApplied', snapshotId: String(landed['snapshot-id']) }
      }
      transientAttempts++
      if (transientAttempts >= maxTransientAttempts)
        throw error
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (transientAttempts - 1))
      await sleep(Math.floor(random() * ceiling))
      continue
    }

    throw error
  }
}
