/**
 * @gscdump/cloudflare — Cloudflare-Workers-flavored helpers for the gscdump
 * analytics stack.
 *
 * Owns the `AnalyticsEnv` binding contract, the size-hint HMAC scheme, the
 * DuckDB Workers shims, and the analytics engine factory. Host apps wire their
 * Nitro server handlers using these primitives plus the D1 manifest store from
 * `@gscdump/engine-sqlite`.
 *
 * The hybrid R2-SQL / DuckDB-over-Iceberg query cluster lives behind the
 * `@gscdump/cloudflare/server-tail` subpath so consumers that only read the env
 * binding don't pull the server-tail contract/compiler graph into their Worker
 * bundle.
 */

export type { AnalyticsEngineHooks, AnalyticsEngineRuntime } from './engine'
export { createAnalyticsEngineRuntime, getAnalyticsEngine } from './engine'

export type { AnalyticsEnv } from './env'

export { useAnalyticsEnv } from './env'
export type { HostedR2QueryKeyInput, InflightDedupe } from './inflight-dedupe'
export { createInflightDedupe, getHostedR2QueryKey } from './inflight-dedupe'
export { signSizeHint, verifySizeHint } from './size-hint-sig'
export type { DucklingsRowCache } from './workers-duckdb'
export { createDucklingsCodec, createDucklingsExecutor, createDucklingsRowCache } from './workers-duckdb'
