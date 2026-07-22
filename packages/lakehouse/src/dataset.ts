/**
 * `defineIcebergDataset` — the dataset registry's authoring surface
 * (ADR-0021, as amended). Consumers declare a dataset def; the package
 * derives the Iceberg schema/partition/sort-order, dedupe key, INT32 guard,
 * append path, and reader helpers from it.
 *
 * A dataset is exactly one Iceberg table (`namespace.table`). Multi-table
 * buffering (GSC's `createIcebergAppendSink`) is a SEPARATE, engine-owned
 * concern layered on top of several datasets — not something this module
 * needs to model.
 */

import type {
  CommitRetryOptions,
  ConnectIcebergOptions,
  IcebergCatalogConfig,
  IcebergConnection,
  IcebergListedDataFile,
  IcebergPartitionSpec,
  IcebergSchema,
  IcebergSortOrder,
  IcebergTableOpResult,
  QueryProfiler,
} from './catalog'
import type { CatalogCache } from './catalog-cache'
import type { ManifestPartitionFilter, PartitionValueMatch } from './partition-prune'
import type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergTableSpec,
} from './schema'
import { icebergCreateTable } from 'icebird'
import { coerceBigIntToNumber } from './bigint'
import {
  connectIcebergCatalog,
  ensureIcebergNamespace,
  ICEBERG_TYPE_MAP,
  icebergAppendRetrying,
  resolveIcebergDataFiles,
} from './catalog'
import { buildManifestPartitionFilter } from './partition-prune'

const INT32_MIN = -2_147_483_648
const INT32_MAX = 2_147_483_647
const DAY_MILLIS = 86_400_000

/**
 * Closed identity shapes (ADR-0021 amendments 2 + 4). `'site-int'` is the
 * team-scoped numeric Catalog Site Id (nuxtseo ADR-0091) stored under the
 * fixed column name `site_id`. `'columns'` is the general N-column identity
 * with per-column encoding, replacing the original opaque `'custom'` shape.
 */
export type DatasetIdentity
  = | { kind: 'site-int', encoding?: 'int' | 'string' }
    | { kind: 'columns', columns: readonly { name: string, encoding: 'int32' | 'string' }[] }

/** A per-slice dimension (GSC's `searchType`). Absent for plain snapshot datasets. */
export interface DatasetDim {
  toPartitionValue: (v: string) => string | number
  /** Required (amendment 5) — how the reader decodes this column's manifest bounds. */
  boundEncoding: 'int32' | 'string'
}

export interface IcebergDatasetColumnDef {
  name: string
  type: IcebergColumnType
  required: boolean
}

export interface IcebergDatasetLedger {
  key: readonly string[]
}

export interface IcebergDatasetDef {
  namespace: string
  table: string
  identity: DatasetIdentity
  /** Extra per-slice dimensions; absent for snapshot datasets. */
  dims?: Record<string, DatasetDim>
  /** Data columns (non-identity, non-dims) — includes any partition source column (e.g. `date`). */
  columns: readonly IcebergDatasetColumnDef[]
  /** Partition fields; identity columns must appear here. */
  partition: readonly IcebergPartitionField[]
  /** Natural-key columns. Full dedupe key = identity + dims + naturalKey (amendment 3). */
  naturalKey: readonly string[]
  clusterKey?: readonly string[]
  /** Consumer-owned exactly-once ledger shape — folded into `appendSink().close()` (amendment 6). */
  ledger?: IcebergDatasetLedger
}

/** Stored column name(s) an identity shape occupies, in field-id order. */
function identityColumnNames(identity: DatasetIdentity): string[] {
  return identity.kind === 'site-int' ? ['site_id'] : identity.columns.map(c => c.name)
}

/** Per-column encoding for identity columns, keyed by stored column name. */
function identityEncodings(identity: DatasetIdentity): Map<string, 'int32' | 'string'> {
  const map = new Map<string, 'int32' | 'string'>()
  if (identity.kind === 'site-int') {
    map.set('site_id', (identity.encoding ?? 'int') === 'int' ? 'int32' : 'string')
  }
  else {
    for (const c of identity.columns) map.set(c.name, c.encoding)
  }
  return map
}

function identityColumnType(encoding: 'int32' | 'string'): IcebergColumnType {
  return encoding === 'int32' ? 'INT' : 'STRING'
}

/**
 * Derive the full {@link IcebergTableSpec} from a dataset def. Field ids are
 * assigned sequentially in ONE fixed order — identity columns, then dims
 * columns, then declared data columns — starting at 1. This mirrors the
 * engine's original `icebergTableSpec` contract (identity columns first, data
 * columns from a fixed base) so a def-derived spec for an existing table
 * (`crawl.pages`, `lighthouse.scans`, `dataforseo.keywords`) is BYTE-IDENTICAL
 * to the frozen inline constants it replaces.
 */
export function deriveTableSpec(def: IcebergDatasetDef): IcebergTableSpec {
  const encodings = identityEncodings(def.identity)
  const idNames = identityColumnNames(def.identity)
  const dimNames = def.dims ? Object.keys(def.dims) : []

  let fieldId = 1
  const columns: IcebergColumn[] = []
  for (const name of idNames) {
    columns.push({ name, type: identityColumnType(encodings.get(name)!), required: true, fieldId: fieldId++ })
  }
  for (const name of dimNames) {
    const enc = def.dims![name].boundEncoding
    columns.push({ name, type: identityColumnType(enc), required: true, fieldId: fieldId++ })
  }
  for (const col of def.columns) {
    columns.push({ name: col.name, type: col.type, required: col.required, fieldId: fieldId++ })
  }

  return {
    namespace: def.namespace,
    table: def.table,
    columns,
    partitionSpec: def.partition,
    naturalKey: def.naturalKey,
    identityColumns: [...idNames, ...dimNames, ...def.naturalKey],
    clusterKey: def.clusterKey,
  }
}

function icebergSchemaFromSpec(spec: IcebergTableSpec): IcebergSchema {
  return {
    'type': 'struct',
    'schema-id': 0,
    'fields': spec.columns.map(col => ({
      id: col.fieldId,
      name: col.name,
      required: col.required,
      type: ICEBERG_TYPE_MAP[col.type],
    })),
  }
}

function icebergPartitionSpecFromSpec(spec: IcebergTableSpec): IcebergPartitionSpec {
  const fieldId = (name: string): number => {
    const col = spec.columns.find(c => c.name === name)
    if (!col)
      throw new Error(`lakehouse: table '${spec.table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'spec-id': 0,
    'fields': spec.partitionSpec.map((p, i) => ({
      'source-id': fieldId(p.sourceColumn),
      'field-id': 1000 + i,
      'name': p.name,
      'transform': p.transform,
    })),
  }
}

function icebergSortOrderFromSpec(spec: IcebergTableSpec): IcebergSortOrder | undefined {
  if (!spec.clusterKey || spec.clusterKey.length === 0)
    return undefined
  const fieldId = (name: string): number => {
    const col = spec.columns.find(c => c.name === name)
    if (!col)
      throw new Error(`lakehouse: table '${spec.table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'order-id': 1,
    'fields': spec.clusterKey.map(col => ({
      'source-id': fieldId(col),
      'transform': 'identity' as const,
      'direction': 'asc' as const,
      'null-order': 'nulls-last' as const,
    })),
  }
}

/**
 * Convert a `YYYY-MM-DD` string / `Date` / already-numeric day-count to the
 * integer "days since the Unix epoch" the Iceberg `date` type stores.
 * hyparquet-writer mis-encodes Date-valued dictionary columns, so callers
 * should feed this INTO their row before `appendRows`/`appendSink.emit` for
 * any `month`-partitioned date column.
 */
export function toIcebergDayCount(value: string | Date | number): number {
  if (typeof value === 'number')
    return value
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms))
      throw new TypeError('toIcebergDayCount: invalid Date (NaN)')
    return Math.floor(ms / DAY_MILLIS)
  }
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms))
    throw new TypeError(`toIcebergDayCount: invalid date string '${value}'`)
  return Math.floor(ms / DAY_MILLIS)
}

function asInt32(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < INT32_MIN || n > INT32_MAX)
    return null
  return n
}

/** Options shared by `appendRows` / `appendSink`. */
export interface AppendCommitOptions {
  commitRetry?: CommitRetryOptions
}

export interface AppendSinkOptions extends AppendCommitOptions {
  catalog: IcebergCatalogConfig
  connect?: ConnectIcebergOptions
  /** Invoked ONLY after a successful flush (amendment 6) — never on a failed/empty close. */
  ledger?: { record: () => Promise<void> | void }
}

export interface AppendResult {
  /** Rows accepted after the identity guard + dedupe (what was actually appended). */
  accepted: number
  /** Rows dropped by the identity guard (missing/out-of-range required identity value). */
  skipped: number
}

export interface AppendSinkCloseResult extends AppendResult {
  flushed: boolean
  error?: unknown
}

export interface AppendSink {
  emit: (rows: readonly Record<string, unknown>[]) => void
  close: () => Promise<AppendSinkCloseResult>
}

export interface ResolveDataFilesOptions {
  cache?: CatalogCache
  clock?: () => number
  profiler?: QueryProfiler
}

export interface IcebergDataset {
  readonly def: IcebergDatasetDef
  readonly tableSpec: IcebergTableSpec
  icebergSchema: () => IcebergSchema
  icebergPartitionSpec: () => IcebergPartitionSpec
  icebergSortOrder: () => IcebergSortOrder | undefined
  createTable: (conn: IcebergConnection) => Promise<IcebergTableOpResult[]>
  /**
   * One-shot append over an EXISTING connection: identity INT32 guard, dedupe
   * by identity+dims+naturalKey (last-wins), cluster pre-sort (if
   * `clusterKey` is set), then a single `icebergAppendRetrying` commit. `rows`
   * must already be in final storage-column shape — identity/dims/data
   * columns keyed by their STORED column names, with any `month`-partitioned
   * date column pre-converted via {@link toIcebergDayCount}.
   */
  appendRows: (conn: IcebergConnection, rows: readonly Record<string, unknown>[], opts?: AppendCommitOptions) => Promise<AppendResult>
  /**
   * PURE row processing — the identity INT32 guard, dedupe (identity+dims+
   * naturalKey, last-wins) and cluster pre-sort `appendRows`/`appendSink`
   * apply before committing, exposed standalone with NO network/icebird call.
   * Lets a consumer that owns its own commit call-site (e.g. one still
   * calling a frozen `icebergAppendRetrying` import directly, for test-mock
   * compatibility) still route its dedupe/guard/sort logic through the
   * dataset definition.
   */
  prepareRows: (rows: readonly Record<string, unknown>[]) => { records: Record<string, unknown>[], skipped: number }
  /** Buffered multi-emit sink — owns its own connect/close lifecycle (ADR-0021's primary contract). */
  appendSink: (opts: AppendSinkOptions) => AppendSink
  /** `PartitionValueMatch[]` for one identity value (+ optional dims), for manual manifest filtering. */
  readerPredicate: (identity: string | number, dims?: Record<string, string>) => PartitionValueMatch[]
  /** A ready-to-use manifest partition filter for one identity value + wanted months. */
  partitionBoundFilter: (identity: string | number, months: ReadonlySet<number>, dims?: Record<string, string>) => ManifestPartitionFilter
  /** Resolve the data files for one identity value across a date range. */
  resolveDataFiles: (conn: IcebergConnection, identity: string | number, range: { start: string, end: string }, dims?: Record<string, string>, opts?: ResolveDataFilesOptions) => Promise<IcebergListedDataFile[]>
}

/** Build the dedupe key columns + per-row identity guard from a dataset def. */
function buildRowProcessor(def: IcebergDatasetDef, tableSpec: IcebergTableSpec): {
  guard: (row: Record<string, unknown>) => Record<string, unknown> | null
  dedupe: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
  sort: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
} {
  const idNames = identityColumnNames(def.identity)
  const idEncodings = identityEncodings(def.identity)
  const dimNames = def.dims ? Object.keys(def.dims) : []
  const identityColumns = tableSpec.identityColumns

  function guard(row: Record<string, unknown>): Record<string, unknown> | null {
    const out: Record<string, unknown> = {}
    for (const name of idNames) {
      const enc = idEncodings.get(name)!
      const raw = row[name]
      if (enc === 'int32') {
        const n = asInt32(raw)
        if (n === null)
          return null
        out[name] = n
      }
      else {
        if (raw == null || raw === '')
          return null
        out[name] = String(raw)
      }
    }
    for (const name of dimNames) {
      out[name] = def.dims![name].toPartitionValue(String(row[name]))
    }
    for (const col of def.columns) {
      const value = row[col.name]
      // Schema-type-aware numeric coercion. A LONG (int64) column MUST reach
      // hyparquet-writer's `writePlainInt64` as a bigint — it throws on a plain
      // number ("parquet expected bigint value"). D1 delivers int64 as bigint
      // already; coerce a plain number up so callers passing numbers also work.
      // Every other column (INT32/DATE day-count, DOUBLE, STRING, BOOLEAN) is
      // written as a JS number/primitive, and D1's large INTEGER BigInts fail
      // JSON.stringify in icebird's commit path, so coerce those DOWN.
      out[col.name] = col.type === 'LONG'
        ? (typeof value === 'number' ? BigInt(value) : value)
        : coerceBigIntToNumber(value)
    }
    return out
  }

  function dedupe(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (rows.length < 2)
      return rows
    const seen = new Map<string, Record<string, unknown>>()
    for (const rec of rows) {
      let identity = ''
      for (let index = 0; index < identityColumns.length; index++) {
        if (index > 0)
          identity += '\0'
        identity += `${rec[identityColumns[index]!] ?? ''}`
      }
      seen.set(identity, rec)
    }
    return seen.size === rows.length ? rows : [...seen.values()]
  }

  function sort(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const cols = def.clusterKey
    if (!cols || cols.length === 0 || rows.length < 2)
      return rows
    return rows.slice().sort((a, b) => {
      for (const col of cols) {
        const av = a[col]
        const bv = b[col]
        if (av === bv)
          continue
        if (av == null)
          return -1
        if (bv == null)
          return 1
        if (typeof av === 'number' && typeof bv === 'number')
          return av - bv
        const as = String(av)
        const bs = String(bv)
        if (as !== bs)
          return as < bs ? -1 : 1
      }
      return 0
    })
  }

  return { guard, dedupe, sort }
}

/**
 * Declare an Iceberg dataset — one `namespace.table` — deriving its schema,
 * partition spec, dedupe key, INT32 guard, append path, and reader helpers
 * from the def. See {@link IcebergDatasetDef}.
 */
export function defineIcebergDataset(def: IcebergDatasetDef): IcebergDataset {
  const tableSpec = deriveTableSpec(def)
  const schema = icebergSchemaFromSpec(tableSpec)
  const partitionSpecIcebird = icebergPartitionSpecFromSpec(tableSpec)
  const sortOrder = icebergSortOrderFromSpec(tableSpec)
  const { guard, dedupe, sort } = buildRowProcessor(def, tableSpec)

  async function createTable(conn: IcebergConnection): Promise<IcebergTableOpResult[]> {
    const results: IcebergTableOpResult[] = []
    await icebergCreateTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table: def.table,
      schema,
      partitionSpec: partitionSpecIcebird,
      // Only pass a sortOrder when the def declares a clusterKey — matches the
      // ORIGINAL byte-for-byte create-table payload for datasets that never set
      // one (crawl/lighthouse/dataforseo never did).
      ...(sortOrder ? { sortOrder } : {}),
    }).then(
      () => results.push({ table: def.table, ok: true }),
      (e: unknown) => results.push({ table: def.table, ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
    return results
  }

  function process(rows: readonly Record<string, unknown>[]): { records: Record<string, unknown>[], skipped: number } {
    const guarded: Record<string, unknown>[] = []
    let skipped = 0
    for (const row of rows) {
      const rec = guard(row)
      if (rec === null)
        skipped++
      else
        guarded.push(rec)
    }
    return { records: sort(dedupe(guarded)), skipped }
  }

  async function appendRows(
    conn: IcebergConnection,
    rows: readonly Record<string, unknown>[],
    opts: AppendCommitOptions = {},
  ): Promise<AppendResult> {
    if (rows.length === 0)
      return { accepted: 0, skipped: 0 }
    const { records, skipped } = process(rows)
    if (records.length === 0)
      return { accepted: 0, skipped }
    await icebergAppendRetrying({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table: def.table,
      resolver: conn.resolver,
      records,
    }, opts.commitRetry)
    return { accepted: records.length, skipped }
  }

  function appendSink(opts: AppendSinkOptions): AppendSink {
    let buffer: Record<string, unknown>[] = []
    let connection: Promise<IcebergConnection> | undefined
    function connect(): Promise<IcebergConnection> {
      connection ??= connectIcebergCatalog(opts.catalog, opts.connect).then(async (conn) => {
        await ensureIcebergNamespace(conn)
        return conn
      })
      return connection
    }
    return {
      emit(rows) {
        for (const r of rows) buffer.push(r)
      },
      async close(): Promise<AppendSinkCloseResult> {
        if (buffer.length === 0)
          return { flushed: false, accepted: 0, skipped: 0 }
        const rows = buffer
        buffer = []
        try {
          const conn = await connect()
          const result = await appendRows(conn, rows, { commitRetry: opts.commitRetry })
          if (result.accepted > 0 && opts.ledger)
            await opts.ledger.record()
          return { flushed: result.accepted > 0, ...result }
        }
        catch (error) {
          return { flushed: false, accepted: 0, skipped: 0, error }
        }
      },
    }
  }

  function readerPredicate(identity: string | number, dims?: Record<string, string>): PartitionValueMatch[] {
    const idNames = identityColumnNames(def.identity)
    const idEncodings = identityEncodings(def.identity)
    const matches: PartitionValueMatch[] = idNames.map(name => ({
      field: name,
      value: idEncodings.get(name) === 'int32' ? Number(identity) : identity,
      encoding: idEncodings.get(name) === 'int32' ? 'int32' : 'string',
    }))
    if (def.dims && dims) {
      for (const [name, dim] of Object.entries(def.dims)) {
        if (name in dims) {
          matches.push({ field: name, value: dim.toPartitionValue(dims[name]), encoding: dim.boundEncoding })
        }
      }
    }
    return matches
  }

  function partitionBoundFilter(identity: string | number, months: ReadonlySet<number>, dims?: Record<string, string>): ManifestPartitionFilter {
    return buildManifestPartitionFilter(def.partition, readerPredicate(identity, dims), months)
  }

  async function resolveDataFiles(
    conn: IcebergConnection,
    identity: string | number,
    range: { start: string, end: string },
    dims?: Record<string, string>,
    opts: ResolveDataFilesOptions = {},
  ): Promise<IcebergListedDataFile[]> {
    return resolveIcebergDataFiles(conn, {
      namespace: def.namespace,
      table: def.table,
      partitionSpec: def.partition,
      matches: readerPredicate(identity, dims),
      range,
      cache: opts.cache,
      clock: opts.clock,
      profiler: opts.profiler,
    })
  }

  return {
    def,
    tableSpec,
    icebergSchema: () => schema,
    icebergPartitionSpec: () => partitionSpecIcebird,
    icebergSortOrder: () => sortOrder,
    createTable,
    appendRows,
    prepareRows: process,
    appendSink,
    readerPredicate,
    partitionBoundFilter,
    resolveDataFiles,
  }
}
