import type {
  CommitRetryOptions,
  ConnectIcebergOptions,
  IcebergCatalogConfig,
  IcebergConnection,
  IcebergListedDataFile,
  IcebergPartitionSpec,
  IcebergSchema,
  IcebergSortOrder,
  IcebergTableOpResult,
  ResolveIcebergDataFilesOptions,
} from './catalog'
import type {
  AppendBatchesOptions,
  AppendBatchesResult,
  AppendBatchSource,
} from './dataset'
import { icebergCreateTable } from 'icebird/src/write/write.js'
import {
  connectIcebergCatalog,
  ensureIcebergNamespace,
  icebergAppendBatchesRetrying,
  icebergAppendRetrying,
  resolveIcebergDataFiles,
} from './catalog'

interface PreparedRows {
  records: Record<string, unknown>[]
  skipped: number
}

export async function createDatasetTable(
  conn: IcebergConnection,
  table: string,
  schema: IcebergSchema,
  partitionSpec: IcebergPartitionSpec,
  sortOrder: IcebergSortOrder | undefined,
): Promise<IcebergTableOpResult[]> {
  const results: IcebergTableOpResult[] = []
  await icebergCreateTable({
    catalog: conn.catalog,
    namespace: conn.namespace,
    table,
    schema,
    partitionSpec,
    ...(sortOrder ? { sortOrder } : {}),
  }).then(
    () => results.push({ table, ok: true }),
    (error: unknown) => results.push({
      table,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return results
}

export async function appendDatasetRows(
  conn: IcebergConnection,
  table: string,
  records: Record<string, unknown>[],
  commitRetry?: CommitRetryOptions,
): Promise<void> {
  await icebergAppendRetrying({
    catalog: conn.catalog,
    namespace: conn.namespace,
    table,
    resolver: conn.resolver,
    records,
  }, commitRetry)
}

export async function appendDatasetBatches(
  conn: IcebergConnection,
  table: string,
  source: AppendBatchSource,
  prepare: (rows: readonly Record<string, unknown>[]) => PreparedRows,
  opts: AppendBatchesOptions,
): Promise<AppendBatchesResult> {
  let accepted = 0
  let skipped = 0
  const batchFactory = async function* (): AsyncGenerator<Record<string, unknown>[]> {
    accepted = 0
    skipped = 0
    for await (const rows of source()) {
      const prepared = prepare(rows)
      accepted += prepared.records.length
      skipped += prepared.skipped
      if (prepared.records.length > 0)
        yield prepared.records
    }
  }
  const committed = await icebergAppendBatchesRetrying({
    catalog: conn.catalog,
    namespace: conn.namespace,
    table,
    resolver: conn.resolver,
    batchFactory,
  }, { ...opts.commitRetry, appendId: opts.appendId })
  return { accepted, skipped, committed }
}

export async function connectDatasetCatalog(
  config: IcebergCatalogConfig,
  opts?: ConnectIcebergOptions,
): Promise<IcebergConnection> {
  const conn = await connectIcebergCatalog(config, opts)
  await ensureIcebergNamespace(conn)
  return conn
}

export async function resolveDatasetDataFiles(
  conn: IcebergConnection,
  opts: ResolveIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  return resolveIcebergDataFiles(conn, opts)
}
