import type { Row, StorageEngine, TableName } from 'gscdump/analytics/contracts'
import type { GscdumpConfig } from './config'
import path from 'node:path'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from 'gscdump/analytics'
import { createFilesystemDataSource, createFilesystemManifestStore } from 'gscdump/analytics/filesystem'
import { createNodeDuckDBHandle } from 'gscdump/analytics/node'
import { encodeSiteId } from 'gscdump/analytics/tenant'
import { resolveDataDir } from './config'

const LOCAL_USER_ID = 'local'

export { encodeSiteId }

export interface AnalyticsHarness {
  engine: StorageEngine
  dataDir: string
  userId: string
  siteIdFor: (siteUrl: string) => string
  runRawSql: (opts: { sql: string, siteUrl: string, table: TableName, params?: unknown[] }) => Promise<{ rows: Row[], sql: string, keys: string[] }>
}

export function createAnalyticsHarness(config: GscdumpConfig): AnalyticsHarness {
  const dataDir = resolveDataDir(config)
  const handle = createNodeDuckDBHandle()
  const factory = { getDuckDB: async () => handle }
  const dataSource = createFilesystemDataSource({ rootDir: dataDir })
  const manifestStore = createFilesystemManifestStore({ path: path.join(dataDir, 'manifest.json') })
  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec: createDuckDBCodec(factory),
    executor: createDuckDBExecutor(factory),
  })

  async function runRawSql(opts: { sql: string, siteUrl: string, table: TableName, params?: unknown[] }): Promise<{ rows: Row[], sql: string, keys: string[] }> {
    const result = await engine.runSQL({
      ctx: { userId: LOCAL_USER_ID, siteId: encodeSiteId(opts.siteUrl) },
      table: opts.table,
      fileSets: { FILES: { table: opts.table } },
      sql: opts.sql,
      params: opts.params ?? [],
    })
    return { rows: result.rows, sql: result.sql, keys: result.objectKeys }
  }

  return {
    engine,
    dataDir,
    userId: LOCAL_USER_ID,
    siteIdFor: encodeSiteId,
    runRawSql,
  }
}
