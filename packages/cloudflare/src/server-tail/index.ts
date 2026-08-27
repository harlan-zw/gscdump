// Server-tail query executor — the hybrid R2 SQL / DuckDB-over-Iceberg path
// for whale deep-history queries that exceed the browser OPFS ceiling.
//
// See architecture v4 "Read paths" and POC Spike 4 for the original split.
// R2 SQL has since (2026-05-14 / 2026-06-21 CF ships, re-verified 2026-07-03)
// gained JOINs, CTEs, window functions, `COUNT(DISTINCT)`, and set operations
// — it is no longer "no window functions" vs DuckDB. `dispatcher.ts` carries
// the current, empirically-verified per-query escalation rules (`arbitrary-sql`,
// non-zero `offset`, `queryCanonical` dimension, regex facets → DuckDB;
// everything else, including `includeTotal`/`compareRange` breakdowns → R2 SQL).

export type { ArchetypeSqlPlan, BuildArchetypeSqlOptions } from './archetype-sql'
export { buildArchetypeSql, TABLE_PLACEHOLDER } from './archetype-sql'

export type {
  ServerTailDispatcher,
  ServerTailDispatcherConfig,
  ServerTailEngine,
} from './dispatcher'
export {
  createServerTailDispatcher,
  resolveServerTailEngine,
  resolveServerTailEngineResult,
  ServerTailRoutingError,
} from './dispatcher'

export type {
  DuckDbIcebergExecutor,
  DuckDbIcebergExecutorConfig,
  DuckDbIcebergQueryError,
  DuckDbIcebergResult,
  DuckDbIcebergRow,
  DuckDbSvc,
} from './duckdb-iceberg-executor'
export {
  createDuckDbIcebergExecutor,
  DuckDbIcebergError,
  DuckDbIcebergTimeoutError,
} from './duckdb-iceberg-executor'

export type {
  R2SqlClient,
  R2SqlClientConfig,
  R2SqlQueryError,
  R2SqlResult,
  R2SqlRow,
} from './r2-sql-client'
export {
  createR2SqlClient,
  inlineParams,
  R2SqlError,
  R2SqlTimeoutError,
} from './r2-sql-client'
export type {
  R2SqlTransport,
  R2SqlTransportConfig,
  R2SqlTransportMetrics,
  R2SqlTransportResult,
  R2SqlTransportRow,
} from './r2-sql-transport'
export { createR2SqlTransport } from './r2-sql-transport'
