/**
 * @gscdump/cloudflare — Cloudflare-Workers-flavored helpers for the gscdump
 * analytics stack.
 *
 * Owns the `AnalyticsEnv` binding contract, R2 SigV4 presigner, the size-hint
 * HMAC scheme, the DuckDB Workers shims, and the analytics engine factory.
 * Host apps wire their Nitro server handlers using these primitives plus the
 * D1 manifest store from `@gscdump/engine-sqlite`.
 */

export type { Row } from './duckdb-wasm-handle'
export { getWasmDuckDBFactory, resetWasmDuckDB } from './duckdb-wasm-handle'

export type { AnalyticsEngineHooks } from './engine'
export { getAnalyticsEngine } from './engine'

export type { AnalyticsEnv } from './env'

export { useAnalyticsEnv } from './env'
export type { HostedR2QueryKeyInput, InflightDedupe } from './inflight-dedupe'
export { createInflightDedupe, getHostedR2QueryKey } from './inflight-dedupe'
export type { PresignOptions } from './r2-presign'

export { createR2Presigner } from './r2-presign'

export type {
  ArchetypeSqlPlan,
  DuckDbIcebergExecutor,
  DuckDbIcebergExecutorConfig,
  DuckDbIcebergResult,
  DuckDbIcebergRow,
  DuckDbSvc,
  R2SqlClient,
  R2SqlClientConfig,
  R2SqlResult,
  R2SqlRow,
  ServerTailDispatcher,
  ServerTailDispatcherConfig,
  ServerTailEngine,
} from './server-tail'
export {
  buildArchetypeSql,
  createDuckDbIcebergExecutor,
  createR2SqlClient,
  createServerTailDispatcher,
  DuckDbIcebergError,
  DuckDbIcebergTimeoutError,
  escapeSqlValue,
  inlineParams,
  R2SqlError,
  R2SqlTimeoutError,
  resolveServerTailEngine,
  ServerTailRoutingError,
  TABLE_PLACEHOLDER,
} from './server-tail'
export { signSizeHint, verifySizeHint } from './size-hint-sig'
export { createDucklingsCodec, createDucklingsExecutor } from './workers-duckdb'
