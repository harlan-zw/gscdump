import type { BuilderState } from 'gscdump/query'
import type {
  EngineOptions,
  GcCtx,
  ManifestEntry,
  QueryCtx,
  QueryResult,
  Row,
  RunSQLOptions,
  StorageEngine,
  TableName,
  WriteCtx,
} from './storage'
import { normalizeUrl } from 'gscdump/normalize'
import { buildLogicalPlan } from 'gscdump/query/plan'
import { compactOlderThanImpl } from './compaction'
import { compileLogicalQueryPlan } from './compiler'
import { gcOrphansImpl } from './gc'
import { currentSchemaVersion, SCHEMAS } from './schema'
import { dayPartition, objectKey } from './storage'

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

    return manifestStore.withLock(
      { userId: ctx.userId, siteId: ctx.siteId, table: ctx.table, partition },
      async () => {
        const superseding = await manifestStore.listLive({
          userId: ctx.userId,
          siteId: ctx.siteId,
          table: ctx.table,
          partitions: [partition],
        })

        const normalizedRows = rows.map(r => normalizeRow(ctx.table, r))
        const key = objectKey(ctx, ctx.table, partition, now)
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

  async function compactOlderThan(ctx: WriteCtx, days: number): Promise<void> {
    return compactOlderThanImpl(
      { dataSource, manifestStore, codec },
      ctx,
      days,
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

  return {
    writeDay,
    query,
    runSQL,
    compactOlderThan,
    gcOrphans,
    listLive: filter => manifestStore.listLive(filter),
    listAll: filter => manifestStore.listAll(filter),
    getWatermarks: filter => manifestStore.getWatermarks(filter),
    getSyncStates: filter => manifestStore.getSyncStates(filter),
    setSyncState: (scope, state, detail) => manifestStore.setSyncState(scope, state, detail),
    readObject: key => dataSource.read(key),
  }
}
