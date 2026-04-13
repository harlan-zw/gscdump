import type { BuilderState } from '../query/types'

export type TableName = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords'

export type Row = Record<string, unknown>

export interface TenantCtx {
  userId: string
  siteId?: string
}

export interface WriteCtx extends TenantCtx {
  table: TableName
  date?: string
  now?: () => number
}

export interface QueryCtx extends TenantCtx {
  table?: TableName
}

export interface GcCtx {
  now?: () => number
  userId?: string
  siteId?: string
}

export interface ManifestEntry {
  userId: string
  siteId?: string
  table: TableName
  partition: string
  objectKey: string
  rowCount: number
  bytes: number
  createdAt: number
  retiredAt?: number
}

export interface ListLiveFilter {
  userId: string
  siteId?: string
  table?: TableName
  partitions?: string[]
}

export interface DataSource {
  read: (key: string, range?: { offset: number, length: number }) => Promise<Uint8Array>
  write: (key: string, bytes: Uint8Array) => Promise<void>
  delete: (keys: string[]) => Promise<void>
  list: (prefix: string) => Promise<string[]>
}

export interface ManifestStore {
  listLive: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  listAll: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  registerVersion: (entry: ManifestEntry, superseding?: ManifestEntry[]) => Promise<void>
  registerVersions: (entries: ManifestEntry[], superseding?: ManifestEntry[]) => Promise<void>
  listRetired: (olderThan: number) => Promise<ManifestEntry[]>
  delete: (entries: ManifestEntry[]) => Promise<void>
}

export interface ParquetCodec {
  encode: (table: TableName, rows: Row[]) => Promise<Uint8Array>
  decode: (bytes: Uint8Array, table?: TableName) => Promise<Row[]>
}

export interface QueryResult {
  rows: Row[]
  sql: string
  objectKeys: string[]
}

export interface QueryExecuteOptions {
  sql: string
  params: unknown[]
  files: Array<{ key: string, bytes: Uint8Array }>
  table: TableName
}

export interface QueryExecutor {
  execute: (opts: QueryExecuteOptions) => Promise<Row[]>
}

export interface StorageEngine {
  writeDay: (ctx: WriteCtx, rows: Row[]) => Promise<void>
  query: (ctx: QueryCtx, state: BuilderState) => Promise<QueryResult>
  compactDay: (ctx: WriteCtx, shards: ManifestEntry[]) => Promise<void>
  compactMonth: (ctx: WriteCtx, month: string) => Promise<void>
  gcOrphans: (ctx: GcCtx, graceMs: number) => Promise<{ deleted: number }>
}

export interface EngineOptions {
  dataSource: DataSource
  manifestStore: ManifestStore
  codec: ParquetCodec
  executor: QueryExecutor
  shardBytes?: number
  now?: () => number
}

export function dayPartition(date: string): string {
  return `daily/${date}`
}

export function monthPartition(month: string): string {
  return `monthly/${month}`
}

export function objectKey(
  ctx: TenantCtx,
  table: TableName,
  partition: string,
  version: number,
  shardIndex?: number,
): string {
  const prefix = ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/${table}`
    : `u_${ctx.userId}/${table}`
  const shard = shardIndex !== undefined ? `__shard-${shardIndex}` : ''
  return `${prefix}/${partition}${shard}__v${version}.parquet`
}

export function tenantPrefix(ctx: TenantCtx): string {
  return ctx.siteId ? `u_${ctx.userId}/${ctx.siteId}/` : `u_${ctx.userId}/`
}
