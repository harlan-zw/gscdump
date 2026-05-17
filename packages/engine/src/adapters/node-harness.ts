// Node-only convenience: wire the storage engine against the filesystem
// DataSource + ManifestStore + the blocking DuckDB handle in one call.
//
// Consumers that want a different combination (e.g. R2 DataSource + D1
// ManifestStore) compose `createStorageEngine` directly. This helper exists
// so the CLI, tests, and any downstream Node consumer don't rewrite the
// 20-line wiring block.

import type { Row, TableName } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { DataSource, StorageEngine } from '../storage'
import path from 'node:path'
import { encodeSiteId } from 'gscdump/tenant'
import { createDuckDBCodec, createDuckDBExecutor } from '../duckdb'
import { createStorageEngine } from '../engine'
import { createNodeDuckDBHandle } from './duckdb-node'
import { createFilesystemDataSource, createFilesystemManifestStore } from './filesystem'

export interface NodeHarnessOptions {
  dataDir: string
  /** Tenant user id. Defaults to `'local'` for single-user CLI installs. */
  userId?: string
  /** Name of the manifest file under `dataDir`. Defaults to `manifest.json`. */
  manifestFilename?: string
}

export interface NodeHarness {
  engine: StorageEngine
  /**
   * Underlying filesystem-backed DataSource. Exposed so commands that write
   *  derivative artifacts (rollups, exports) don't have to re-instantiate it.
   */
  dataSource: DataSource
  dataDir: string
  userId: string
  siteIdFor: (siteUrl: string) => string
  runRawSql: (opts: {
    sql: string
    siteUrl: string
    table: TableName
    params?: unknown[]
    /**
     * Restrict the underlying manifest lookup to a single GSC search-type
     * slice. Undefined keeps the legacy cross-type union.
     */
    searchType?: SearchType
  }) => Promise<{ rows: Row[], sql: string, keys: string[] }>
}

export function createNodeHarness(opts: NodeHarnessOptions): NodeHarness {
  const dataDir = opts.dataDir
  const userId = opts.userId ?? 'local'
  const manifestFilename = opts.manifestFilename ?? 'manifest.json'

  const handle = createNodeDuckDBHandle()
  const factory = { getDuckDB: async () => handle }
  const dataSource = createFilesystemDataSource({ rootDir: dataDir })
  const manifestStore = createFilesystemManifestStore({ path: path.join(dataDir, manifestFilename) })
  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec: createDuckDBCodec(factory),
    executor: createDuckDBExecutor(factory),
  })

  async function runRawSql(runOpts: {
    sql: string
    siteUrl: string
    table: TableName
    params?: unknown[]
    searchType?: SearchType
  }): Promise<{ rows: Row[], sql: string, keys: string[] }> {
    const result = await engine.runSQL({
      ctx: { userId, siteId: encodeSiteId(runOpts.siteUrl) },
      table: runOpts.table,
      fileSets: { FILES: { table: runOpts.table } },
      sql: runOpts.sql,
      params: runOpts.params ?? [],
      ...(runOpts.searchType !== undefined ? { searchType: runOpts.searchType } : {}),
    })
    return { rows: result.rows, sql: result.sql, keys: result.objectKeys }
  }

  return {
    engine,
    dataSource,
    dataDir,
    userId,
    siteIdFor: encodeSiteId,
    runRawSql,
  }
}
