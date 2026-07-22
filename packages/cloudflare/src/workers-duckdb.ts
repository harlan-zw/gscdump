// Workers-only codec + executor for the analytics engine.
//
// Writes + compaction: hyparquet-writer encodes rows directly in this Worker
//         and R2.put's the bytes. DuckDB-WASM is bypassed because each
//         write/compaction grows linear memory monotonically and cannot shrink,
//         OOMing after a handful of month-sized compactions.
// Reads: fetched from R2 via binding in this Worker, decoded with hyparquet,
//         encoded into Arrow IPC stream buffers (see `./arrow`), then handed to
//         the duckdb Worker as pre-materialized temp tables either inline via
//         `runSQL({sql, tables})` or through staged chunk uploads. Bypasses
//         ducklings' R2 httpfs path entirely because it has a stateful cache bug
//         on small parquets (see docs/repros/ducklings-r2-httpfs.md). Arrow IPC
//         — not JS row objects — crosses the service binding: columnar, compact,
//         and ingested by the sibling without a row→column rebuild.

import type { ParquetCodec, QueryExecutor, Row } from '@gscdump/engine'
import type { ColumnDef } from '@gscdump/engine/schema'
import type { AnalyticsEnv } from './env'
import { coerceRow } from '@gscdump/engine'
import { createHyparquetCodec, decodeParquetToRows } from '@gscdump/engine/hyparquet'
import { SCHEMAS } from '@gscdump/engine/schema'
import { bindLiterals } from '@gscdump/engine/sql'
import { rowsToArrowIPC } from './arrow'

interface RunSQLTableSpec {
  /** Arrow IPC stream buffer the sibling materialises as a temp table. */
  ipc: Uint8Array
}

interface DuckDBServiceRPC {
  runSQL: (args: { sql: string, tables?: Record<string, RunSQLTableSpec>, deadlineAt?: number }) => Promise<{ rows: Row[], sql: string }>
  stageArrowTable?: (args: { table: string, ipc: Uint8Array }) => Promise<void>
  dropTables?: (args: { tables: string[] }) => Promise<void>
  ping: () => Promise<string>
}

function resolveSvc(env: AnalyticsEnv): DuckDBServiceRPC {
  const svc = env.DUCKDB_SVC as DuckDBServiceRPC | undefined
  if (!svc)
    throw new Error('DUCKDB_SVC service binding is not configured')
  return svc
}

/**
 * Deadline for a single `DUCKDB_SVC.runSQL` RPC. A service-binding call to a
 * sibling Worker has no implicit client timeout: if the sibling stalls (OOM
 * mid-query, deadlock), the caller awaits up to Cloudflare's ~15-min wall
 * ceiling and dies as `exceededCpu` with ~2ms CPU. 22s sits under the 25s
 * job/request CPU budget so a stalled query rejects cleanly and identifiably.
 */
const DUCKDB_RPC_TIMEOUT_MS = 22_000
const WORKER_R2_MAX_FILES = 96
const WORKER_R2_MAX_BYTES = 64 * 1024 * 1024
const WORKER_R2_DECODE_CONCURRENCY = 2
const WORKER_R2_HEAD_CONCURRENCY = 4

// Arrow IPC budgets for the service-binding RPC. Cloudflare caps serialized
// RPC arguments at 32MiB; keep each chunk and any direct `{sql, tables}` call
// below that, while still bounding the total staged upload for one query.
const IPC_CHUNK_BUDGET = 8 * 1024 * 1024
const IPC_DIRECT_CALL_BUDGET = 30 * 1024 * 1024
const IPC_STAGED_TOTAL_BUDGET = 64 * 1024 * 1024

export class DuckDBServiceTimeoutError extends Error {
  override name = 'DuckDBServiceTimeoutError'
  constructor(timeoutMs: number) {
    super(`DUCKDB_SVC.runSQL exceeded ${timeoutMs}ms deadline`)
  }
}

/**
 * Race a `DUCKDB_SVC` RPC against a wall-clock deadline. The RPC itself isn't
 * abortable (service-binding RPCs have no AbortSignal channel), so the loser
 * promise simply stops being awaited; this bounds *our* latency, not the
 * sibling's work. An optional caller `signal` rejects the race early.
 */
export function withDuckDBDeadline<T>(
  op: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cleanup = (): void => {
      if (timer !== undefined)
        clearTimeout(timer)
      if (onAbort)
        signal?.removeEventListener('abort', onAbort)
    }
    const settle = <V>(complete: (value: V) => void, value: V): void => {
      if (settled)
        return
      settled = true
      cleanup()
      complete(value)
    }
    onAbort = () => settle(reject, signal!.reason ?? new DOMException('Aborted', 'AbortError'))
    timer = setTimeout(
      () => settle(reject, new DuckDBServiceTimeoutError(timeoutMs)),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    op.then(
      value => settle(resolve, value),
      error => settle(reject, error),
    )
  })
}

function runSQLWithDeadline(
  svc: DuckDBServiceRPC,
  args: { sql: string, tables?: Record<string, RunSQLTableSpec> },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ rows: Row[], sql: string }> {
  // Carry the same wall deadline into the sibling. If this caller times out,
  // stale work still waiting in the sibling's serial queue is rejected before
  // it pays a cold bootstrap or starts DuckDB execution.
  const deadlineAt = Date.now() + timeoutMs
  return withDuckDBDeadline(
    svc.runSQL({ ...args, deadlineAt }),
    timeoutMs,
    signal,
  )
}

export function createDucklingsCodec(_env: AnalyticsEnv): ParquetCodec {
  // Default hyparquet `readRows` fetches bytes via `dataSource.read(key)` and
  // decodes in pure JS — no ducklings round-trip, no R2 httpfs.
  return createHyparquetCodec()
}

// Matches the exact shape the engine compiler emits:
//   `read_parquet({{NAME}}, union_by_name = true)` (compiler.ts) — plus a
// tolerance for the plain `read_parquet({{NAME}})` form in case the compiler
// ever drops the option. Captures the placeholder name.
const READ_PARQUET_PLACEHOLDER = /read_parquet\(\{\{(\w+)\}\}(?:\s*,[^)]*)?\)/g

function tmpTableName(placeholder: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, '_')
  return `tmp_${placeholder.toLowerCase()}_${uuid}`
}

export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const out = Array.from<R>({ length: items.length })
  let next = 0
  let failed = false
  let failure: unknown
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        out[index] = await fn(items[index]!, index)
      }
      catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed)
    throw failure
  return out
}

export interface WorkerReadBudgetInput {
  fileKeys: Record<string, string[]>
  sizes?: Record<string, number | undefined>
  maxFiles?: number
  maxBytes?: number
}

export function assertWorkerReadBudget(opts: WorkerReadBudgetInput): void {
  const maxFiles = opts.maxFiles ?? WORKER_R2_MAX_FILES
  const maxBytes = opts.maxBytes ?? WORKER_R2_MAX_BYTES
  const entries = Object.entries(opts.fileKeys)
  const totalFiles = entries.reduce((acc, [, keys]) => acc + keys.length, 0)
  if (totalFiles > maxFiles) {
    throw new Error(
      `createDucklingsExecutor: planned read spans ${totalFiles} files, exceeding the ${maxFiles} file Worker budget. `
      + `Narrow the date range or route through a background/windowed query.`,
    )
  }

  if (!opts.sizes)
    return
  let totalBytes = 0
  for (const [, keys] of entries) {
    for (const key of keys) {
      const bytes = opts.sizes[key]
      if (bytes !== undefined)
        totalBytes += Math.max(0, bytes)
    }
  }
  if (totalBytes > maxBytes) {
    throw new Error(
      `createDucklingsExecutor: planned read spans ${totalBytes} bytes, exceeding the ${maxBytes} byte Worker budget. `
      + `Narrow the date range or route through a background/windowed query.`,
    )
  }
}

// Decoded-row cache. R2 object keys are content-addressed (`__v<ts>` suffix),
// so the bytes — and the decoded `Row[]` — are immutable for a given key.
// That makes a per-isolate cache safe across requests: any object key the
// cache holds has the same contents as a fresh fetch+decode would produce.
//
// Bounded by total estimated bytes (rough — derived from row count × a
// per-table row size). LRU on access. Sized to comfortably fit a few months
// of partitioned data per isolate without contending with DuckDB's 48 MB
// memory limit.
const ROW_CACHE_MAX_BYTES = 16 * 1024 * 1024

function estimateRowsBytes(rows: Row[]): number {
  if (rows.length === 0)
    return 0
  // Cheap estimate: 64 bytes per column per row. Avoids JSON.stringify for
  // every cached entry, which would dominate decode cost on hits.
  const cols = Object.keys(rows[0]!).length
  return rows.length * cols * 64
}

export interface ArrowIPCChunk {
  ipc: Uint8Array
  rows: number
}

export interface ArrowIPCChunkOptions {
  maxChunkBytes?: number
  placeholder?: string
}

interface ColumnTypeInference {
  hasValue: boolean
  hasString: boolean
  hasFloat: boolean
  hasBigInt: boolean
}

function addInferredValue(inference: ColumnTypeInference, value: unknown): void {
  if (value === null || value === undefined)
    return
  inference.hasValue = true
  if (typeof value === 'string') {
    inference.hasString = true
    return
  }
  if (typeof value === 'bigint') {
    inference.hasBigInt = true
    return
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value))
      inference.hasFloat = true
    if (value > 2_147_483_647 || value < -2_147_483_648)
      inference.hasBigInt = true
  }
}

function inferredColumnType(inference: ColumnTypeInference): ColumnDef['type'] {
  if (!inference.hasValue || inference.hasString)
    return 'VARCHAR'
  if (inference.hasFloat)
    return 'DOUBLE'
  return inference.hasBigInt ? 'BIGINT' : 'INTEGER'
}

function chunkSchemaColumns(rows: Row[], schemaColumns?: readonly ColumnDef[]): ColumnDef[] | undefined {
  const columns = schemaColumns ? [...schemaColumns] : []
  const seen = new Set(columns.map(c => c.name))
  const extraColumns = new Map<string, ColumnTypeInference>()

  for (const row of rows) {
    for (const key in row) {
      if (seen.has(key))
        continue
      let inference = extraColumns.get(key)
      if (!inference) {
        inference = { hasValue: false, hasString: false, hasFloat: false, hasBigInt: false }
        extraColumns.set(key, inference)
      }
      addInferredValue(inference, row[key])
    }
  }

  if (extraColumns.size === 0)
    return schemaColumns ? columns : undefined

  for (const [name, inference] of extraColumns) {
    columns.push({
      name,
      type: inferredColumnType(inference),
      nullable: true,
    })
  }
  return columns
}

export function rowsToArrowIPCChunks(
  rows: Row[],
  schemaColumns?: readonly ColumnDef[],
  opts: ArrowIPCChunkOptions = {},
): ArrowIPCChunk[] {
  const maxChunkBytes = Math.max(1, Math.floor(opts.maxChunkBytes ?? IPC_CHUNK_BUDGET))
  const placeholder = opts.placeholder ? `{{${opts.placeholder}}}` : 'placeholder'
  const chunkColumns = chunkSchemaColumns(rows, schemaColumns)
  if (rows.length === 0) {
    const ipc = rowsToArrowIPC([], chunkColumns)
    if (ipc.byteLength > maxChunkBytes) {
      throw new Error(
        `createDucklingsExecutor: empty ${placeholder} Arrow IPC schema encoded to ${ipc.byteLength} bytes, `
        + `exceeding the ${maxChunkBytes}-byte service-binding chunk budget.`,
      )
    }
    return [{ ipc, rows: 0 }]
  }

  const estimatedPerRow = Math.max(1, Math.ceil(estimateRowsBytes(rows) / rows.length))
  let targetRows = Math.max(1, Math.min(rows.length, Math.floor((maxChunkBytes * 0.75) / estimatedPerRow)))
  const chunks: ArrowIPCChunk[] = []
  let index = 0
  while (index < rows.length) {
    let take = Math.min(targetRows, rows.length - index)
    while (true) {
      const slice = rows.slice(index, index + take)
      const ipc = rowsToArrowIPC(slice, chunkColumns)
      if (ipc.byteLength <= maxChunkBytes) {
        chunks.push({ ipc, rows: slice.length })
        index += take
        if (ipc.byteLength < maxChunkBytes * 0.4 && take === targetRows)
          targetRows = Math.min(rows.length - index || targetRows, targetRows * 2)
        break
      }
      if (take === 1) {
        throw new Error(
          `createDucklingsExecutor: one ${placeholder} row encoded to ${ipc.byteLength} bytes of Arrow IPC, `
          + `exceeding the ${maxChunkBytes}-byte service-binding chunk budget. `
          + `Narrow the query or route through a background/windowed query.`,
        )
      }
      take = Math.max(1, Math.floor(take / 2))
    }
  }
  return chunks
}

export interface DucklingsRowCache {
  clear: () => void
  get: (key: string) => Row[] | undefined
  put: (key: string, rows: Row[]) => void
}

export function createDucklingsRowCache(maxBytes = ROW_CACHE_MAX_BYTES): DucklingsRowCache {
  let totalBytes = 0
  const entries = new Map<string, { rows: Row[], bytes: number }>()
  return {
    clear() {
      entries.clear()
      totalBytes = 0
    },
    get(key) {
      const hit = entries.get(key)
      if (!hit)
        return undefined
      entries.delete(key)
      entries.set(key, hit)
      return hit.rows
    },
    put(key, rows) {
      const bytes = estimateRowsBytes(rows)
      if (bytes > maxBytes)
        return
      const existing = entries.get(key)
      if (existing) {
        entries.delete(key)
        totalBytes -= existing.bytes
      }
      while (totalBytes + bytes > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined)
          break
        const evicted = entries.get(oldest)!
        entries.delete(oldest)
        totalBytes -= evicted.bytes
      }
      entries.set(key, { rows, bytes })
      totalBytes += bytes
    },
  }
}

export interface DucklingsExecutorOptions {
  ipcChunkBytes?: number
  ipcDirectCallBytes?: number
  ipcTotalBytes?: number
  /** Per-RPC wall/queue budget. Interactive default is 22 seconds. */
  rpcTimeoutMs?: number
  rowCache?: DucklingsRowCache
}

export function createDucklingsExecutor(env: AnalyticsEnv, opts: DucklingsExecutorOptions = {}): QueryExecutor {
  const rowCache = opts.rowCache ?? createDucklingsRowCache()
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? DUCKDB_RPC_TIMEOUT_MS
  if (!Number.isFinite(rpcTimeoutMs) || rpcTimeoutMs <= 0)
    throw new TypeError('createDucklingsExecutor: rpcTimeoutMs must be a positive finite number')
  return {
    async execute({ sql, params, fileKeys, placeholderTables, pushdownFilters, dataSource, signal, table }) {
      signal?.throwIfAborted()
      const svc = resolveSvc(env)
      assertWorkerReadBudget({ fileKeys })

      // Resolve decoded-cache hits before the size preflight. Cached rows do
      // not issue an R2 GET, so HEADing those immutable object keys on every
      // query defeated the cache's network-I/O benefit. Filtered decodes still
      // bypass the cache and remain in the preflight plan.
      const cachedUnfiltered = new Map<string, Row[]>()
      const scheduledUnfiltered = new Set<string>()
      const plannedReadKeys: string[] = []
      for (const [placeholder, keys] of Object.entries(fileKeys)) {
        const filter = pushdownFilters?.[placeholder]
        for (const key of keys) {
          if (filter) {
            plannedReadKeys.push(key)
            continue
          }
          const cached = cachedUnfiltered.get(key) ?? rowCache.get(key)
          if (cached !== undefined) {
            cachedUnfiltered.set(key, cached)
            continue
          }
          if (!scheduledUnfiltered.has(key)) {
            scheduledUnfiltered.add(key)
            plannedReadKeys.push(key)
          }
        }
      }
      if (dataSource.head && plannedReadKeys.length > 0) {
        const uniqueKeys = [...new Set(plannedReadKeys)]
        const sizes: Record<string, number | undefined> = {}
        await mapLimit(uniqueKeys, WORKER_R2_HEAD_CONCURRENCY, async (key) => {
          signal?.throwIfAborted()
          sizes[key] = (await dataSource.head!(key))?.bytes
        })
        assertWorkerReadBudget({ fileKeys: { READS: plannedReadKeys }, sizes })
      }

      // Fetch/decode parquet with a tiny concurrency cap in the main Worker,
      // merge into one row array per placeholder, then encode each as an Arrow
      // IPC stream the sibling materializes as a temp table before running SQL.
      const tempNames: Record<string, string> = {}
      const tableChunks: Record<string, ArrowIPCChunk[]> = {}
      let totalIpcBytes = 0
      const maxChunkBytes = opts.ipcChunkBytes ?? IPC_CHUNK_BUDGET
      const maxDirectCallBytes = opts.ipcDirectCallBytes ?? IPC_DIRECT_CALL_BUDGET
      const maxTotalBytes = opts.ipcTotalBytes ?? IPC_STAGED_TOTAL_BUDGET
      const unfilteredLoads = new Map<string, Promise<Row[]>>()
      for (const [key, rows] of cachedUnfiltered)
        unfilteredLoads.set(key, Promise.resolve(rows))

      const loadUnfiltered = (key: string): Promise<Row[]> => {
        let loading = unfilteredLoads.get(key)
        if (!loading) {
          loading = (async () => {
            signal?.throwIfAborted()
            const bytes = await dataSource.read(key, undefined, signal)
            signal?.throwIfAborted()
            const rows = await decodeParquetToRows(bytes)
            rowCache.put(key, rows)
            return rows
          })()
          unfilteredLoads.set(key, loading)
        }
        return loading
      }

      for (const [placeholder, keys] of Object.entries(fileKeys)) {
        signal?.throwIfAborted()
        // Row-group pushdown for this placeholder, if the query carried one.
        // A filtered decode yields a SUBSET of the file's rows, so it bypasses
        // the row cache entirely: caching the subset under the file key would
        // corrupt a later unfiltered read, and reading a cached full set would
        // forfeit the IPC-shrinking win. The SQL WHERE re-applies downstream,
        // so a superset filter (a dropped AND-conjunct) is still correct.
        const filter = pushdownFilters?.[placeholder]
        const perFile = await mapLimit(keys, WORKER_R2_DECODE_CONCURRENCY, async (key) => {
          if (!filter)
            return loadUnfiltered(key)
          signal?.throwIfAborted()
          const bytes = await dataSource.read(key, undefined, signal)
          signal?.throwIfAborted()
          const rows = await decodeParquetToRows(bytes, filter ? { filter } : {})
          return rows
        })
        const merged: Row[] = []
        for (const rows of perFile) merged.push(...rows)

        // Encode the merged rows as Arrow IPC. `placeholderTables` carries the
        // canonical table per placeholder (it can differ across placeholders
        // in a multi-fileSet query); its schema authoritatively types every
        // fact column. An entity-sidecar placeholder, whose `table` is a
        // placeholder lie, falls back to value inference in `rowsToArrowIPC`.
        const placeholderTable = placeholderTables?.[placeholder] ?? table
        const chunks = rowsToArrowIPCChunks(merged, SCHEMAS[placeholderTable]?.columns, {
          maxChunkBytes,
          placeholder,
        })
        signal?.throwIfAborted()

        totalIpcBytes += chunks.reduce((acc, chunk) => acc + chunk.ipc.byteLength, 0)
        if (totalIpcBytes > maxTotalBytes) {
          throw new Error(
            `createDucklingsExecutor: query encoded to ${totalIpcBytes} bytes of Arrow IPC across `
            + `${Object.keys(tableChunks).length + 1} placeholders, exceeding the ${maxTotalBytes}-byte `
            + `service-binding transport budget. Window the query (chunk partitions / narrow the range).`,
          )
        }

        const tmp = tmpTableName(placeholder)
        tempNames[placeholder] = tmp
        tableChunks[tmp] = chunks
      }

      signal?.throwIfAborted()

      // Rewrite `read_parquet({{NAME}}, ...)` → <temp table name>. Done
      // before `bindLiterals` so `?` params in the query body still bind
      // normally against the final SQL.
      const rewritten = sql.replace(READ_PARQUET_PLACEHOLDER, (_, placeholder: string) => {
        const tmp = tempNames[placeholder]
        if (!tmp)
          throw new Error(`createDucklingsExecutor: SQL references {{${placeholder}}} but no fileKeys entry provided`)
        return tmp
      })
      const finalSql = bindLiterals(rewritten, params)

      const canInlineTables = totalIpcBytes <= maxDirectCallBytes
        && Object.values(tableChunks).every(chunks => chunks.length === 1)

      let result: { rows: Row[], sql: string }
      if (canInlineTables) {
        const tables: Record<string, RunSQLTableSpec> = {}
        for (const [name, chunks] of Object.entries(tableChunks))
          tables[name] = { ipc: chunks[0]!.ipc }
        result = await runSQLWithDeadline(svc, { sql: finalSql, tables }, rpcTimeoutMs, signal)
      }
      else {
        if (!svc.stageArrowTable || !svc.dropTables) {
          throw new Error(
            'createDucklingsExecutor: DUCKDB_SVC does not support chunked Arrow IPC staging. '
            + 'Deploy the gscdump-duckdb worker with stageArrowTable/dropTables support.',
          )
        }

        const staged = new Set<string>()
        let primaryError: unknown
        let cleanupError: unknown
        try {
          for (const [name, chunks] of Object.entries(tableChunks)) {
            for (const chunk of chunks) {
              signal?.throwIfAborted()
              staged.add(name)
              await withDuckDBDeadline(
                svc.stageArrowTable({ table: name, ipc: chunk.ipc }),
                rpcTimeoutMs,
                signal,
              )
            }
          }
          result = await runSQLWithDeadline(svc, { sql: finalSql }, rpcTimeoutMs, signal)
        }
        catch (error) {
          primaryError = error
        }
        finally {
          if (staged.size > 0) {
            try {
              await withDuckDBDeadline(
                svc.dropTables({ tables: [...staged] }),
                rpcTimeoutMs,
              )
            }
            catch (error) {
              cleanupError = error
            }
          }
        }
        if (primaryError)
          throw primaryError
        if (cleanupError)
          throw cleanupError
        result = result!
      }
      return { rows: result.rows.map(coerceRow), sql: result.sql }
    },
  }
}
