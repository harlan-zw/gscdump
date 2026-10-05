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
import { restCatalogLoadTable } from 'icebird/src/catalog/rest.js'
import { icebergCreateTable } from 'icebird/src/write/write.js'
import {
  connectIcebergCatalog,
  ensureIcebergNamespace,
  icebergAppendBatchesRetrying,
  icebergAppendRetrying,
  resolveIcebergDataFiles,
} from './catalog'

export { resolveIcebergAppendFiles as resolveDatasetAppendFiles } from './catalog'
export { createIcebergAppendFileResolver as createDatasetAppendFileResolver } from './catalog'

interface PreparedRows {
  records: Record<string, unknown>[]
  skipped: number
}

/** Provisioning must inspect the actual current schema, not a cached table name. */
export async function verifyDatasetTable(
  conn: IcebergConnection,
  table: string,
  schema: IcebergSchema,
  partitionSpec: IcebergPartitionSpec,
): Promise<{ _tag: 'Ok' } | { _tag: 'Err', reason: 'schema-mismatch' | 'partition-mismatch' }> {
  const { metadata } = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })
  const currentSchema = metadata.schemas?.find(s => s['schema-id'] === metadata['current-schema-id'])
  if (!currentSchema || currentSchema.fields.length !== schema.fields.length
    || !schema.fields.every(expected => currentSchema.fields.some(actual =>
      actual.id === expected.id && actual.name === expected.name
      && actual.type === expected.type && actual.required === expected.required))) {
    return { _tag: 'Err', reason: 'schema-mismatch' }
  }
  const currentSpec = metadata['partition-specs']?.find(s => s['spec-id'] === metadata['default-spec-id'])
  if (!currentSpec || currentSpec.fields.length !== partitionSpec.fields.length
    || !partitionSpec.fields.every(expected => currentSpec.fields.some(actual =>
      actual['source-id'] === expected['source-id'] && actual['field-id'] === expected['field-id']
      && actual.name === expected.name && actual.transform === expected.transform))) {
    return { _tag: 'Err', reason: 'partition-mismatch' }
  }
  return { _tag: 'Ok' }
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
