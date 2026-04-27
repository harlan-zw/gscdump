import type { BuilderState } from 'gscdump/query'
import type { CompactionThresholds } from './compaction'
import type { ComparisonFilter } from './resolver/types'
import type {
  ComparisonResult,
  EngineOptions,
  ExtraResult,
  GcCtx,
  ManifestEntry,
  PurgeResult,
  PurgeUrlsResult,
  QueryCtx,
  QueryResult,
  Row,
  RunSQLOptions,
  StorageEngine,
  TableName,
  TenantCtx,
  WriteCtx,
} from './storage'
import { normalizeUrl } from 'gscdump/normalize'
import { buildLogicalPlan } from 'gscdump/query/plan'
import { compactTieredImpl, enumeratePartitions } from './compaction'
import { compileLogicalQueryPlan } from './compiler'
import { gcOrphansImpl } from './gc'
import { buildExtrasQueries, buildTotalsSql, resolveComparisonSQL } from './resolver/compiler'
import { createParquetResolverAdapter } from './resolver/pg-adapter'
import { currentSchemaVersion, SCHEMAS } from './schema'
import { dayPartition, inferSearchType, objectKey, tenantPrefix } from './storage'

const URL_PURGE_TABLES: readonly TableName[] = ['pages', 'page_keywords']

export const MAX_DAY_BYTES = 100 * 1024 * 1024

const URL_COLUMNS = new Set<string>()
for (const t of Object.keys(SCHEMAS) as TableName[]) {
  for (const col of SCHEMAS[t].columns) {
    if (col.name === 'url')
      URL_COLUMNS.add(`${t}:url`)
  }
}

function normalizeRow(table: TableName, row: Row): Row {
  if (!URL_COLUMNS.has(`${table}:url`))
    return row
  const url = row.url
  if (typeof url !== 'string')
    return row
  const normalized = normalizeUrl(url)
  if (normalized === url)
    return row
  return { ...row, url: normalized }
}

export function createStorageEngine(opts: EngineOptions): StorageEngine {
  const { dataSource, manifestStore, codec, executor } = opts
  const defaultNow = opts.now ?? (() => Date.now())

  async function writeDay(ctx: WriteCtx, rows: Row[]): Promise<void> {
    if (!ctx.date)
      throw new Error('writeDay requires ctx.date')
    const date = ctx.date
    const now = (ctx.now ?? defaultNow)()
    const partition = dayPartition(date)
    const searchType = ctx.searchType

    return manifestStore.withLock(
      { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, partition },
      async () => {
        const liveForPartition = await manifestStore.listLive({
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partitions: [partition],
        })
        // Only supersede entries that share the same searchType — different
        // search types coexist in the same date partition.
        const superseding = liveForPartition.filter(
          e => inferSearchType(e) === inferSearchType({ searchType }),
        )

        const normalizedRows = rows.map(r => normalizeRow(ctx.table, r))
        const key = objectKey(ctx, ctx.table, partition, now, searchType)
        const { bytes: writtenBytes, rowCount } = await codec.writeRows(
          { table: ctx.table },
          normalizedRows,
          key,
          dataSource,
        )
        let bytes = writtenBytes

        if (bytes === 0 && rowCount > 0 && dataSource.head) {
          const probed = await dataSource.head(key)
          if (probed)
            bytes = probed.bytes
        }

        if (bytes > MAX_DAY_BYTES) {
          await dataSource.delete([key]).catch(() => {})
          throw new Error(
            `writeDay payload ${bytes} bytes exceeds ${MAX_DAY_BYTES} hard ceiling (table=${ctx.table}, key=${key})`,
          )
        }

        const entry: ManifestEntry = {
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partition,
          objectKey: key,
          rowCount,
          bytes,
          createdAt: now,
          schemaVersion: currentSchemaVersion(ctx.table),
          tier: 'raw',
          ...(searchType !== undefined ? { searchType } : {}),
        }
        await manifestStore.registerVersion(entry, superseding)
        await manifestStore.bumpWatermark(
          { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table },
          date,
          now,
        )
      },
    )
  }

  async function runSQL(opts: RunSQLOptions): Promise<QueryResult> {
    opts.signal?.throwIfAborted()
    const entries = Object.entries(opts.fileSets)
    const perSet = await Promise.all(
      entries.map(async ([name, ref]) => {
        const list = await manifestStore.listLive({
          userId: opts.ctx.userId,
          siteId: opts.ctx.siteId,
          table: ref.table,
          partitions: ref.partitions,
        })
        return [name, list.map(e => e.objectKey)] as const
      }),
    )

    opts.signal?.throwIfAborted()
    const fileKeys: Record<string, string[]> = {}
    for (const [name, keys] of perSet)
      fileKeys[name] = keys

    const uniqueKeys = [...new Set(perSet.flatMap(([, keys]) => keys))]
    let table = opts.table
    if (!table) {
      const distinctTables = new Set(entries.map(([, ref]) => ref.table))
      if (distinctTables.size > 1) {
        throw new Error(
          'runSQL requires explicit ctx.table when fileSets reference multiple tables.',
        )
      }
      table = entries[0]?.[1].table
    }
    if (!table)
      throw new Error('runSQL requires at least one fileSet or an explicit table')

    const result = await executor.execute({
      sql: opts.sql,
      params: opts.params ?? [],
      fileKeys,
      dataSource,
      table,
      signal: opts.signal,
    })

    return { rows: result.rows, sql: result.sql, objectKeys: uniqueKeys }
  }

  async function query(ctx: QueryCtx, state: BuilderState): Promise<QueryResult> {
    const plan = buildLogicalPlan(state, { regex: true })
    const table: TableName = ctx.table ?? plan.dataset
    const resolved = compileLogicalQueryPlan(plan, table)
    return runSQL({
      ctx: { userId: ctx.userId, siteId: ctx.siteId },
      table,
      fileSets: { FILES: { table, partitions: resolved.partitions } },
      sql: resolved.sql,
      params: resolved.params,
      signal: ctx.signal,
    })
  }

  async function queryComparison(
    ctx: QueryCtx,
    current: BuilderState,
    previous: BuilderState,
    filter?: ComparisonFilter,
  ): Promise<ComparisonResult> {
    const adapter = createParquetResolverAdapter()

    // Same logical plan path as `query` so partition resolution and dataset
    // inference stay in lockstep with the simple-query path.
    const currentPlan = buildLogicalPlan(current, adapter.capabilities)
    const previousPlan = buildLogicalPlan(previous, adapter.capabilities)
    if (currentPlan.dataset !== previousPlan.dataset) {
      throw new Error(
        `queryComparison: current (${currentPlan.dataset}) and previous (${previousPlan.dataset}) must resolve to the same table`,
      )
    }
    const table: TableName = ctx.table ?? currentPlan.dataset

    const comparison = resolveComparisonSQL(
      current,
      previous,
      { adapter, siteId: undefined },
      filter,
    )
    const totals = buildTotalsSql(current, { adapter, siteId: undefined })

    // Partition union spans both windows so DuckDB sees every relevant file.
    const startDate = currentPlan.dateRange.startDate < previousPlan.dateRange.startDate
      ? currentPlan.dateRange.startDate
      : previousPlan.dateRange.startDate
    const endDate = currentPlan.dateRange.endDate > previousPlan.dateRange.endDate
      ? currentPlan.dateRange.endDate
      : previousPlan.dateRange.endDate
    const partitions = enumeratePartitions(startDate, endDate)

    const fileSets = { FILES: { table, partitions } }
    const baseCtx = { userId: ctx.userId, siteId: ctx.siteId }
    const [main, count, totalsRow] = await Promise.all([
      runSQL({ ctx: baseCtx, table, fileSets, sql: comparison.sql, params: comparison.params, signal: ctx.signal }),
      runSQL({ ctx: baseCtx, table, fileSets, sql: comparison.countSql, params: comparison.countParams, signal: ctx.signal }),
      runSQL({ ctx: baseCtx, table, fileSets, sql: totals.sql, params: totals.params, signal: ctx.signal }),
    ])
    return {
      rows: main.rows,
      totalCount: Number(count.rows[0]?.total ?? 0),
      totals: (totalsRow.rows[0] ?? {}) as Record<string, unknown>,
    }
  }

  async function queryExtras(ctx: QueryCtx, state: BuilderState): Promise<ExtraResult[]> {
    const adapter = createParquetResolverAdapter()
    const extras = buildExtrasQueries(state, { adapter, siteId: undefined })
    if (extras.length === 0)
      return []

    const plan = buildLogicalPlan(state, adapter.capabilities)
    const table: TableName = ctx.table ?? plan.dataset
    const partitions = enumeratePartitions(plan.dateRange.startDate, plan.dateRange.endDate)
    const fileSets = { FILES: { table, partitions } }
    const baseCtx = { userId: ctx.userId, siteId: ctx.siteId }

    const results = await Promise.all(extras.map(e =>
      runSQL({ ctx: baseCtx, table, fileSets, sql: e.sql, params: e.params, signal: ctx.signal }),
    ))
    return extras.map((e, i) => ({ key: e.key, rows: results[i]!.rows }))
  }

  async function compactTiered(ctx: WriteCtx, thresholds?: CompactionThresholds): Promise<void> {
    return compactTieredImpl(
      { dataSource, manifestStore, codec },
      ctx,
      (ctx.now ?? defaultNow)(),
      thresholds,
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

  async function purgeTenant(ctx: TenantCtx): Promise<PurgeResult> {
    const prefix = tenantPrefix(ctx)
    const keys: string[] = []
    const keyStream = dataSource.streamList
      ? dataSource.streamList(prefix)
      : (async function* (): AsyncIterable<string> {
          for (const k of await dataSource.list(prefix)) yield k
        }())
    for await (const key of keyStream) keys.push(key)
    if (keys.length > 0)
      await dataSource.delete(keys)
    const manifestResult = await manifestStore.purgeTenant({
      userId: ctx.userId,
      siteId: ctx.siteId,
    })
    return {
      userId: ctx.userId,
      siteId: ctx.siteId,
      prefix,
      objectsDeleted: keys.length,
      entriesRemoved: manifestResult.entriesRemoved,
      watermarksRemoved: manifestResult.watermarksRemoved,
      syncStatesRemoved: manifestResult.syncStatesRemoved,
      at: defaultNow(),
    }
  }

  async function purgeUrls(ctx: TenantCtx, urls: readonly string[]): Promise<PurgeUrlsResult> {
    const now = defaultNow()
    const urlSet = new Set(urls)
    let entriesRewritten = 0
    let rowsRemoved = 0
    let bytesAfter = 0

    if (urlSet.size === 0) {
      return {
        userId: ctx.userId,
        siteId: ctx.siteId,
        urlsRequested: 0,
        entriesRewritten: 0,
        rowsRemoved: 0,
        bytesAfter: 0,
        at: now,
      }
    }

    for (const table of URL_PURGE_TABLES) {
      const entries = await manifestStore.listLive({
        userId: ctx.userId,
        siteId: ctx.siteId,
        table,
      })
      for (const entry of entries) {
        await manifestStore.withLock(
          { userId: entry.userId, siteId: entry.siteId, table, partition: entry.partition },
          async () => {
            const rows = await codec.readRows({ table }, entry.objectKey, dataSource)
            const kept = rows.filter(r => typeof r.url !== 'string' || !urlSet.has(r.url))
            const removed = rows.length - kept.length
            if (removed === 0)
              return

            const searchType = entry.searchType
            const newKey = objectKey({ userId: entry.userId, siteId: entry.siteId }, table, entry.partition, now, searchType)
            const { bytes, rowCount } = await codec.writeRows({ table }, kept, newKey, dataSource)

            const newEntry: ManifestEntry = {
              userId: entry.userId,
              siteId: entry.siteId,
              table,
              partition: entry.partition,
              objectKey: newKey,
              rowCount,
              bytes,
              createdAt: now,
              schemaVersion: entry.schemaVersion ?? currentSchemaVersion(table),
              ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
              ...(searchType !== undefined ? { searchType } : {}),
            }
            await manifestStore.registerVersion(newEntry, [entry])
            entriesRewritten++
            rowsRemoved += removed
            bytesAfter += bytes
          },
        )
      }
    }

    return {
      userId: ctx.userId,
      siteId: ctx.siteId,
      urlsRequested: urlSet.size,
      entriesRewritten,
      rowsRemoved,
      bytesAfter,
      at: now,
    }
  }

  return {
    writeDay,
    query,
    queryComparison,
    queryExtras,
    runSQL,
    compactTiered,
    gcOrphans,
    purgeTenant,
    purgeUrls,
    listLive: filter => manifestStore.listLive(filter),
    listAll: filter => manifestStore.listAll(filter),
    getWatermarks: filter => manifestStore.getWatermarks(filter),
    getSyncStates: filter => manifestStore.getSyncStates(filter),
    setSyncState: (scope, state, detail) => manifestStore.setSyncState(scope, state, detail),
    readObject: key => dataSource.read(key),
  }
}
