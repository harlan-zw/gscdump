/**
 * Browser / parquet-dialect {@link ResolverAdapter}. The canonical
 * implementation lives in `@gscdump/engine/resolver` as `pgResolverAdapter`
 * — DuckDB-WASM and DuckDB-Node both consume it unchanged. This file is
 * a thin alias preserved for ergonomics and existing call-sites.
 */

export { pgResolverAdapter as browserResolverAdapter } from '@gscdump/engine/resolver'
export type { PgTableKey as TableKey } from '@gscdump/engine/resolver'
