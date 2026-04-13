import type { BuilderState } from '../query/types'
import type {
  EngineOptions,
  GcCtx,
  ManifestEntry,
  ParquetCodec,
  QueryCtx,
  QueryResult,
  Row,
  StorageEngine,
  TableName,
  WriteCtx,
} from './storage'
import { compactDayImpl, compactMonthImpl, enumeratePartitions } from './compaction'
import { gcOrphansImpl } from './gc'
import { resolveToSQL, substituteFiles } from './resolver'
import { inferTable } from './schema'
import { dayPartition, objectKey } from './storage'

const DEFAULT_SHARD_BYTES = 50 * 1024 * 1024

export function createStorageEngine(opts: EngineOptions): StorageEngine {
  const { dataSource, manifestStore, codec, executor } = opts
  const shardBytes = opts.shardBytes ?? DEFAULT_SHARD_BYTES
  const defaultNow = opts.now ?? (() => Date.now())

  async function writeDay(ctx: WriteCtx, rows: Row[]): Promise<void> {
    if (!ctx.date)
      throw new Error('writeDay requires ctx.date')
    const now = (ctx.now ?? defaultNow)()
    const partition = dayPartition(ctx.date)

    const superseding = await manifestStore.listLive({
      userId: ctx.userId,
      siteId: ctx.siteId,
      table: ctx.table,
      partitions: [partition],
    })

    const shards = await splitIntoShards(codec, ctx.table, rows, shardBytes)

    if (shards.length === 1) {
      const { bytes, rows: shardRows } = shards[0]
      const key = objectKey(ctx, ctx.table, partition, now)
      await dataSource.write(key, bytes)
      const entry: ManifestEntry = {
        userId: ctx.userId,
        siteId: ctx.siteId,
        table: ctx.table,
        partition,
        objectKey: key,
        rowCount: shardRows.length,
        bytes: bytes.byteLength,
        createdAt: now,
      }
      await manifestStore.registerVersion(entry, superseding)
      return
    }

    const newEntries: ManifestEntry[] = []
    for (let i = 0; i < shards.length; i++) {
      const { bytes, rows: shardRows } = shards[i]
      const key = objectKey(ctx, ctx.table, partition, now, i)
      await dataSource.write(key, bytes)
      newEntries.push({
        userId: ctx.userId,
        siteId: ctx.siteId,
        table: ctx.table,
        partition,
        objectKey: key,
        rowCount: shardRows.length,
        bytes: bytes.byteLength,
        createdAt: now,
      })
    }
    await manifestStore.registerVersions(newEntries, superseding)
  }

  async function query(ctx: QueryCtx, state: BuilderState): Promise<QueryResult> {
    const table: TableName = ctx.table ?? inferTable(state.dimensions)
    const resolved = resolveToSQL(state, table)

    const liveEntries = await manifestStore.listLive({
      userId: ctx.userId,
      siteId: ctx.siteId,
      table,
      partitions: resolved.partitions,
    })

    const keys = liveEntries.map(e => e.objectKey)
    const files = await Promise.all(
      keys.map(async key => ({ key, bytes: await dataSource.read(key) })),
    )

    const finalSql = substituteFiles(resolved.sql, keys)

    const rows = await executor.execute({
      sql: finalSql,
      params: resolved.params,
      files,
      table,
    })

    return { rows, sql: finalSql, objectKeys: keys }
  }

  async function compactDay(ctx: WriteCtx, shards: ManifestEntry[]): Promise<void> {
    return compactDayImpl(
      { dataSource, manifestStore, codec },
      ctx,
      shards,
      (ctx.now ?? defaultNow)(),
    )
  }

  async function compactMonth(ctx: WriteCtx, month: string): Promise<void> {
    return compactMonthImpl(
      { dataSource, manifestStore, codec },
      ctx,
      month,
      (ctx.now ?? defaultNow)(),
    )
  }

  async function gcOrphans(ctx: GcCtx, graceMs: number): Promise<{ deleted: number }> {
    return gcOrphansImpl(
      { dataSource, manifestStore },
      (ctx.now ?? defaultNow)(),
      graceMs,
      { userId: ctx.userId, siteId: ctx.siteId },
    )
  }

  return { writeDay, query, compactDay, compactMonth, gcOrphans }
}

export { enumeratePartitions }

interface Shard {
  rows: Row[]
  bytes: Uint8Array
}

async function splitIntoShards(
  codec: ParquetCodec,
  table: TableName,
  rows: Row[],
  maxBytes: number,
): Promise<Shard[]> {
  if (rows.length === 0) {
    const bytes = await codec.encode(table, [])
    return [{ rows: [], bytes }]
  }

  const single = await codec.encode(table, rows)
  if (single.byteLength <= maxBytes)
    return [{ rows, bytes: single }]

  const shards: Shard[] = []
  let candidate = rows
  let remaining: Row[] = []

  while (candidate.length > 0) {
    const bytes = await codec.encode(table, candidate)
    if (bytes.byteLength <= maxBytes || candidate.length === 1) {
      shards.push({ rows: candidate, bytes })
      candidate = remaining
      remaining = []
      continue
    }
    const mid = Math.ceil(candidate.length / 2)
    remaining = candidate.slice(mid).concat(remaining)
    candidate = candidate.slice(0, mid)
  }

  return shards
}
