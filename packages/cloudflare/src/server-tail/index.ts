// Server-tail query executor — the hybrid R2 SQL / DuckDB-over-Iceberg path
// for whale deep-history queries that exceed the browser OPFS ceiling.
//
// See architecture v4 "Read paths" and POC Spike 4: 8/10 archetypes answer in
// R2 SQL, 2 (window functions) need DuckDB over the compacted Iceberg files.

export type { ArchetypeSqlPlan } from './archetype-sql'

export type {
  ServerTailDispatcher,
  ServerTailDispatcherConfig,
  ServerTailEngine,
} from './dispatcher'
export {
  createServerTailDispatcher,
  resolveServerTailEngine,
  ServerTailRoutingError,
} from './dispatcher'

export type {
  DuckDbIcebergExecutor,
  DuckDbIcebergExecutorConfig,
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
  R2SqlResult,
  R2SqlRow,
} from './r2-sql-client'
export {
  createR2SqlClient,
  R2SqlError,
  R2SqlTimeoutError,
} from './r2-sql-client'
