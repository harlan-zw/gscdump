// Thin facade around the engine for CLI-local use. Commands should import
// from this module rather than reaching into `@gscdump/engine/*` subpaths
// directly — keeps the "what does the CLI need from storage?" surface in
// one place and makes future backend swaps a factory change, not a sweep
// across every command file.

import type { DataSource, StorageEngine } from '@gscdump/engine/contracts'
import { createNodeHarness } from '@gscdump/engine/node'

export type {
  DataSource,
  ManifestEntry,
  Row,
  StorageEngine,
  SyncState,
  SyncStateKind,
  SyncStateScope,
  TableName,
  TenantCtx,
  Watermark,
  WriteCtx,
} from '@gscdump/engine/contracts'
export { TABLE_DIMS, transformGscRow } from '@gscdump/engine/ingest'
export { allTables, inferTable } from '@gscdump/engine/schema'

/**
 * CLI-facing store facade. Narrower than `NodeHarness` — exposes only the
 * fields commands actually touch. The full engine handle is re-exposed under
 * `engine` because the CLI currently calls engine methods directly; when we
 * want to sever that link, this is the single chokepoint to add wrapper
 * methods.
 */
export interface LocalStore {
  readonly engine: StorageEngine
  readonly dataSource: DataSource
  readonly dataDir: string
  readonly userId: string
  siteIdFor: (siteUrl: string) => string
  withSitemapMutation: <T>(
    ctx: import('@gscdump/engine/contracts').TenantCtx,
    mutate: () => Promise<T>,
  ) => Promise<T>
  runRawSql: (opts: {
    sql: string
    siteUrl: string
    table: import('@gscdump/engine/contracts').TableName
    params?: unknown[]
    searchType?: import('gscdump/query').SearchType
  }) => Promise<{
    rows: import('@gscdump/engine/contracts').Row[]
    sql: string
    keys: string[]
  }>
}

export interface CreateLocalStoreOptions {
  dataDir: string
  userId?: string
  manifestFilename?: string
}

export function createLocalStore(opts: CreateLocalStoreOptions): LocalStore {
  return createNodeHarness(opts)
}
