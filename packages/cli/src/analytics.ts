import type { DuckDBFactory, DuckDBHandle, QueryExecutor, Row, StorageEngine, TableName } from 'gscdump/analytics'
import type { GscdumpConfig } from './config'
import path from 'node:path'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
  FILES_PLACEHOLDER,
} from 'gscdump/analytics'
import { createFilesystemDataSource, createFilesystemManifestStore } from 'gscdump/analytics/filesystem'
import { createNodeDuckDBHandle } from 'gscdump/analytics/node'
import { resolveDataDir } from './config'

const LOCAL_USER_ID = 'local'
const SC_DOMAIN_RE = /^sc-domain:/
const PROTOCOL_RE = /^https?:\/\//
const NON_ID_RE = /[^\w.-]/g
const TRAILING_UNDERSCORES_RE = /_+$/

export interface AnalyticsHarness {
  engine: StorageEngine
  executor: QueryExecutor
  dataSource: ReturnType<typeof createFilesystemDataSource>
  manifestStore: ReturnType<typeof createFilesystemManifestStore>
  handle: DuckDBHandle
  factory: DuckDBFactory
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
  const executor = createDuckDBExecutor(factory)
  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec: createDuckDBCodec(factory),
    executor,
  })

  async function runRawSql(opts: { sql: string, siteUrl: string, table: TableName, params?: unknown[] }): Promise<{ rows: Row[], sql: string, keys: string[] }> {
    const entries = await manifestStore.listLive({
      userId: LOCAL_USER_ID,
      siteId: encodeSiteId(opts.siteUrl),
      table: opts.table,
    })
    const files = await Promise.all(entries.map(async e => ({
      key: e.objectKey,
      bytes: await dataSource.read(e.objectKey),
    })))
    const finalSql = substituteFilesToken(opts.sql, files.map(f => f.key))
    const rows = await executor.execute({
      sql: finalSql,
      params: opts.params ?? [],
      files,
      table: opts.table,
    })
    return { rows, sql: finalSql, keys: files.map(f => f.key) }
  }

  return {
    engine,
    executor,
    dataSource,
    manifestStore,
    handle,
    factory,
    dataDir,
    userId: LOCAL_USER_ID,
    siteIdFor: encodeSiteId,
    runRawSql,
  }
}

function substituteFilesToken(sql: string, keys: string[]): string {
  const list = keys.length === 0 ? '[]' : `[${keys.map(k => `'${k.replace(/'/g, '\'\'')}'`).join(', ')}]`
  return sql.replace(new RegExp(escapeRegExp(FILES_PLACEHOLDER), 'g'), list)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// GSC site URLs like `sc-domain:example.com` or `https://example.com/` contain
// characters that collide with path separators in object keys. Keep the
// mapping deterministic and reversible enough for debugging.
export function encodeSiteId(siteUrl: string): string {
  return siteUrl
    .replace(SC_DOMAIN_RE, 'd_')
    .replace(PROTOCOL_RE, 'h_')
    .replace(NON_ID_RE, '_')
    .replace(TRAILING_UNDERSCORES_RE, '')
}
