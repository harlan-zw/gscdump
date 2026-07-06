import type { BuilderState } from 'gscdump/query'
import type { CompactionThresholds } from './compaction'
import type {
  EngineOptions,
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
import { compactTieredImpl, dedupeOverlappingTiers, splitOverlappingTiers } from './compaction'
import { gcOrphansImpl } from './gc'
import { dayPartition, hourPartition, inferSearchType, objectKey, tenantPrefix } from './layout'
import { compileLogicalQueryPlan } from './parquet-plan'
import { extractParquetPushdown } from './parquet-pushdown'
import { currentSchemaVersion, dedupeByNaturalKey, SCHEMAS } from './schema'

const URL_PURGE_TABLES: readonly TableName[] = ['pages', 'page_queries']

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

const DAILY_PARTITION_RE = /^daily\/(\d{4}-\d{2}-\d{2})$/

/**
 * Derive the query date window from an enumerated partition list. The planner
 * emits a `daily/` partition for every day in range, so the min/max daily
 * bounds the window — used to scope tier-subsumption to what the query reads.
 */
function queryRangeOf(partitions?: string[]): { start: string, end: string } | undefined {
  if (!partitions)
    return undefined
  let min: string | undefined
  let max: string | undefined
  for (const p of partitions) {
    const m = DAILY_PARTITION_RE.exec(p)
    if (!m)
      continue
    const d = m[1]!
    if (min === undefined || d < min)
      min = d
    if (max === undefined || d > max)
      max = d
  }
  return min !== undefined ? { start: min, end: max! } : undefined
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
        // Only fetch the slice we'll supersede — different search types
        // coexist in the same date partition and must not retire each other.
        const superseding = await manifestStore.listLive({
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partitions: [partition],
          searchType: inferSearchType({ searchType }),
        })

        // Dedupe by natural key before writing: a day file holds one row per
        // (date, dimension) tuple. Source rows should already be unique, but
        // collapsing here keeps a duplicated-source regression from being
        // persisted and then doubled again by downstream compaction.
        const normalizedRows = dedupeByNaturalKey(
          ctx.table,
          rows.map(r => normalizeRow(ctx.table, r)),
        )
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
          { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, ...(searchType !== undefined ? { searchType } : {}) },
          date,
          now,
        )
      },
    )
  }

  async function writeHour(ctx: WriteCtx, rows: Row[]): Promise<void> {
    if (!ctx.date)
      throw new Error('writeHour requires ctx.date (the PT calendar day)')
    const date = ctx.date
    const now = (ctx.now ?? defaultNow)()
    const partition = hourPartition(date)
    const searchType = ctx.searchType

    return manifestStore.withLock(
      { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, partition },
      async () => {
        const live = await manifestStore.listLive({
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partitions: [partition],
          searchType: inferSearchType({ searchType }),
        })

        // Read-merge-write: each tick reads existing rows for the day,
        // overwrites buckets on (url, hour), and rewrites the parquet.
        const existing: Row[] = []
        for (const entry of live) {
          const rs = await codec.readRows({ table: ctx.table }, entry.objectKey, dataSource)
          existing.push(...rs)
        }
        const dedup = new Map<string, Row>()
        for (const r of existing) {
          const k = `${String(r.url ?? '')}\0${String(r.hour ?? '')}`
          dedup.set(k, r)
        }
        for (const r of rows) {
          const normalized = normalizeRow(ctx.table, r)
          const k = `${String(normalized.url ?? '')}\0${String(normalized.hour ?? '')}`
          dedup.set(k, normalized)
        }
        const merged = [...dedup.values()]

        const key = objectKey(ctx, ctx.table, partition, now, searchType)
        const { bytes: writtenBytes, rowCount } = await codec.writeRows(
          { table: ctx.table },
          merged,
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
            `writeHour payload ${bytes} bytes exceeds ${MAX_DAY_BYTES} hard ceiling (table=${ctx.table}, key=${key})`,
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
        await manifestStore.registerVersion(entry, live)
        await manifestStore.bumpWatermark(
          { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, ...(searchType !== undefined ? { searchType } : {}) },
          date,
          now,
        )
      },
    )
  }

  async function runSQL(opts: RunSQLOptions): Promise<QueryResult> {
    opts.signal?.throwIfAborted()
    const profiler = opts.profiler
    const entries = Object.entries(opts.fileSets)
    const endList = profiler?.start('manifest.list', { fileSets: entries.length })
    const perSet = await Promise.all(
      entries.map(async ([name, ref]) => {
        // Direct-key path: skip manifest entirely. Used by entity-store
        // sidecars (inspections.parquet, sitemap urls.parquet).
        if (ref.keys !== undefined)
          return [name, ref.keys] as const
        const list = await manifestStore.listLive({
          userId: opts.ctx.userId,
          siteId: opts.ctx.siteId,
          table: ref.table,
          partitions: ref.partitions,
          // Without this, a tenant with mixed-searchType writes would union
          // web + Discover (etc.) parquet into the same query — clicks /
          // impressions double, CTR smears. Undefined preserves the legacy
          // cross-type behaviour for web-only tenants.
          ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
        })
        // A coarse tier (monthly/quarterly) can outlive the finer files it was
        // meant to supersede — backfill writes coarse partitions directly and
        // re-sync writes fresh daily/weekly for the same dates. union_by_name
        // would then sum the overlap. Drop fully-subsumed coarse files first,
        // scoped to the query window: `ref.partitions` is enumerated for the
        // query range, so a coarse file's days past that window must not count
        // against subsumption (the finer file covering them isn't enumerated).
        return [name, dedupeOverlappingTiers(list, queryRangeOf(ref.partitions)).map(e => e.objectKey)] as const
      }),
    )

    opts.signal?.throwIfAborted()
    const fileKeys: Record<string, string[]> = {}
    for (const [name, keys] of perSet)
      fileKeys[name] = keys

    const uniqueKeys = [...new Set(perSet.flatMap(([, keys]) => keys))]
    endList?.({ files: uniqueKeys.length })
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

    const placeholderTables: Record<string, TableName> = {}
    for (const [name, ref] of entries)
      placeholderTables[name] = ref.table

    const endExec = profiler?.start('executor.execute', { files: uniqueKeys.length })
    const result = await executor.execute({
      sql: opts.sql,
      params: opts.params ?? [],
      fileKeys,
      placeholderTables,
      dataSource,
      table,
      signal: opts.signal,
      ...(opts.pushdownFilters ? { pushdownFilters: opts.pushdownFilters } : {}),
      ...(profiler ? { profiler } : {}),
    })
    endExec?.({ rows: result.rows.length })

    return { rows: result.rows, sql: result.sql, objectKeys: uniqueKeys }
  }

  async function query(ctx: QueryCtx, state: BuilderState): Promise<QueryResult> {
    const plan = buildLogicalPlan(state, { regex: true })
    const table: TableName = ctx.table ?? plan.dataset
    const resolved = compileLogicalQueryPlan(plan, table)
    // Prune row groups in the pure-JS decode path (ignored by SQL-native
    // executors). The `FILES` placeholder is the only fileSet this path emits.
    const pushdown = extractParquetPushdown(state, table)
    return runSQL({
      ctx: { userId: ctx.userId, siteId: ctx.siteId },
      table,
      fileSets: { FILES: { table, partitions: resolved.partitions } },
      sql: resolved.sql,
      params: resolved.params,
      signal: ctx.signal,
      ...(pushdown ? { pushdownFilters: { FILES: pushdown } } : {}),
      ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
      ...(ctx.profiler ? { profiler: ctx.profiler } : {}),
    })
  }

  async function compactTiered(ctx: WriteCtx, thresholds?: CompactionThresholds): Promise<void> {
    return compactTieredImpl(
      { dataSource, manifestStore, codec },
      ctx,
      (ctx.now ?? defaultNow)(),
      thresholds,
    )
  }

  async function reconcileSubsumed(ctx: WriteCtx): Promise<{ retired: number, partitions: string[] }> {
    // Full live set — splitOverlappingTiers groups subsumption per searchType
    // internally, so no searchType filter here.
    const live = await manifestStore.listLive({
      userId: ctx.userId,
      siteId: ctx.siteId,
      table: ctx.table,
    })
    const { subsumed } = splitOverlappingTiers(live)
    if (subsumed.length === 0)
      return { retired: 0, partitions: [] }
    // registerVersions([], superseding) retires `superseding` atomically with
    // no inserts — the manifest's retire primitive, same one compactTiered uses.
    await manifestStore.registerVersions([], subsumed)
    return { retired: subsumed.length, partitions: subsumed.map(e => e.partition) }
  }

  async function gcOrphans(ctx: GcCtx, graceMs: number): Promise<{ deleted: number }> {
    return gcOrphansImpl(
      { dataSource, manifestStore },
      (ctx.now ?? defaultNow)(),
      graceMs,
      {
        userId: ctx.userId,
        siteId: ctx.siteId,
        ...(ctx.hourlyRetentionMs !== undefined ? { hourlyRetentionMs: ctx.hourlyRetentionMs } : {}),
      },
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
    const manifestResult = await manifestStore.purgeTenant({
      userId: ctx.userId,
      siteId: ctx.siteId,
    })
    if (keys.length > 0)
      await dataSource.delete(keys)
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
      // Intentionally unfiltered by searchType — a GDPR URL takedown must
      // scrub the URL from every slice (web, discover, ...). Each rewritten
      // entry carries its source `entry.searchType` so types stay separated.
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
    writeHour,
    query,
    runSQL,
    compactTiered,
    reconcileSubsumed,
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
