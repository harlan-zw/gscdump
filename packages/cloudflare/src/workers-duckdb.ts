// Workers-only codec + executor for the analytics engine.
//
// Writes + compaction: hyparquet-writer encodes rows directly in this Worker
//         and R2.put's the bytes. DuckDB-WASM is bypassed because each
//         write/compaction grows linear memory monotonically and cannot shrink,
//         OOMing after a handful of month-sized compactions.
// Reads: fetched from R2 via binding in this Worker, decoded with hyparquet,
//         then handed to the duckdb Worker as a pre-materialized temp table
//         via `runSQL({sql, tables})`. Bypasses ducklings' R2 httpfs path
//         entirely because it has a stateful cache bug on small parquets
//         (see docs/repros/ducklings-r2-httpfs.md).

import type {
  ParquetCodec,
  QueryExecutor,
  Row,
} from '@gscdump/engine'
import type { AnalyticsEnv } from './env'
import { bindLiterals, canonicalEmptyParquetSchema } from '@gscdump/engine'
import { createHyparquetCodec, decodeParquetToRows } from '@gscdump/engine/hyparquet'

interface RunSQLTableSpec {
  rows: Row[]
  ddl?: string
}

interface DuckDBServiceRPC {
  runSQL: (args: { sql: string, tables?: Record<string, RunSQLTableSpec> }) => Promise<{ rows: Row[], sql: string }>
  ping: () => Promise<string>
}

function resolveSvc(env: AnalyticsEnv): DuckDBServiceRPC {
  const svc = env.DUCKDB_SVC as DuckDBServiceRPC | undefined
  if (!svc)
    throw new Error('DUCKDB_SVC service binding is not configured')
  return svc
}

export function createDucklingsCodec(_env: AnalyticsEnv): ParquetCodec {
  // Default hyparquet `readRows` fetches bytes via `dataSource.read(key)` and
  // decodes in pure JS — no ducklings round-trip, no R2 httpfs.
  return createHyparquetCodec()
}

// DuckDB aggregate functions return BIGINT for SUM/COUNT over integer columns.
// The RPC boundary delivers these as JS BigInt values; JSON.stringify then
// throws (or yields null in Workers' toleranced path). Coerce numeric BigInts
// to regular numbers before the response leaves the engine so every consumer
// gets JSON-safe values. Precision loss above 2^53 is acceptable for analytics
// aggregates — individual click/impression columns never reach that range.
function coerceRow(row: Row): Row {
  let mutated: Row | null = null
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') {
      if (!mutated)
        mutated = { ...row }
      mutated[k] = Number(v)
    }
  }
  return mutated ?? row
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
let rowCacheBytes = 0
const rowCache = new Map<string, { rows: Row[], bytes: number }>()

function estimateRowsBytes(rows: Row[]): number {
  if (rows.length === 0)
    return 0
  // Cheap estimate: 64 bytes per column per row. Avoids JSON.stringify for
  // every cached entry, which would dominate decode cost on hits.
  const cols = Object.keys(rows[0]!).length
  return rows.length * cols * 64
}

function rowCacheGet(key: string): Row[] | undefined {
  const hit = rowCache.get(key)
  if (!hit)
    return undefined
  // Reinsert to move to LRU tail.
  rowCache.delete(key)
  rowCache.set(key, hit)
  return hit.rows
}

function rowCachePut(key: string, rows: Row[]): void {
  const bytes = estimateRowsBytes(rows)
  if (bytes > ROW_CACHE_MAX_BYTES)
    return
  while (rowCacheBytes + bytes > ROW_CACHE_MAX_BYTES) {
    const oldest = rowCache.keys().next().value
    if (oldest === undefined)
      break
    const evicted = rowCache.get(oldest)!
    rowCache.delete(oldest)
    rowCacheBytes -= evicted.bytes
  }
  rowCache.set(key, { rows, bytes })
  rowCacheBytes += bytes
}

export function createDucklingsExecutor(env: AnalyticsEnv): QueryExecutor {
  return {
    async execute({ sql, params, fileKeys, dataSource, signal, table }) {
      signal?.throwIfAborted()
      const svc = resolveSvc(env)

      // Fetch every parquet for every placeholder in parallel, decode in the
      // main Worker, merge into one row array per placeholder. Each becomes a
      // DuckDB temp table that the sibling materializes before running SQL.
      const tempNames: Record<string, string> = {}
      const tables: Record<string, RunSQLTableSpec> = {}

      await Promise.all(
        Object.entries(fileKeys).map(async ([placeholder, keys]) => {
          const perFile = await Promise.all(
            keys.map(async (key) => {
              const cached = rowCacheGet(key)
              if (cached)
                return cached
              const bytes = await dataSource.read(key)
              const rows = await decodeParquetToRows(bytes)
              rowCachePut(key, rows)
              return rows
            }),
          )
          const merged: Row[] = []
          for (const rows of perFile) merged.push(...rows)
          const tmp = tmpTableName(placeholder)
          tempNames[placeholder] = tmp
          // DDL used by the sibling only when `merged` is empty; we pass
          // unconditionally because it's a few bytes and keeps the contract
          // simple. (Building DDL inside the worker would tree-shake-fail and
          // bundle the whole engine package — see workers/duckdb/src/index.ts.)
          const ddl = `AS SELECT * FROM ${canonicalEmptyParquetSchema(table)} WHERE FALSE`
          tables[tmp] = { rows: merged, ddl }
        }),
      )

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

      const result = await svc.runSQL({ sql: finalSql, tables })
      return { rows: result.rows.map(coerceRow), sql: result.sql }
    },
  }
}
