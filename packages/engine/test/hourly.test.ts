import type { Row, WriteCtx } from '../src/index'
import { describe, expect, it } from 'vitest'
import { gcOrphansImpl } from '../src/gc'
import { createStorageEngine, hourPartition } from '../src/index'
import { rebuildDailyFromHourly } from '../src/rollups'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function makeEngine(opts: { now?: () => number } = {}) {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now: opts.now })
  return { engine, dataSource, manifestStore, codec, executor }
}

function hourCtx(partial: Partial<WriteCtx> = {}): WriteCtx {
  return {
    userId: 'u1',
    siteId: 's1',
    table: 'hourly_pages',
    date: '2026-04-10',
    searchType: 'discover',
    ...partial,
  }
}

function hourRow(url: string, hour: string, date: string, clicks = 1, impressions = 10): Row {
  return { url, hour, date, clicks, impressions, sum_position: impressions * 5 }
}

describe('storageEngine.writeHour', () => {
  it('writes a single partition keyed by hourly/{date}', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeHour(hourCtx(), [
      hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10'),
      hourRow('/a', '2026-04-10T09:00:00-07:00', '2026-04-10'),
    ])
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].partition).toBe(hourPartition('2026-04-10'))
    expect(live[0].rowCount).toBe(2)
    expect(live[0].searchType).toBe('discover')
  })

  it('is idempotent on (url, hour) under read-merge-write', async () => {
    const { engine, manifestStore } = makeEngine()
    // First tick covers hour=08 with old metrics.
    await engine.writeHour(hourCtx(), [
      hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10', 1, 5),
    ])
    // Second tick re-sends the same (url, hour) with updated metrics + a new
    // hour. Final state should be 2 rows: updated 08, fresh 09.
    await engine.writeHour(hourCtx(), [
      hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10', 7, 70),
      hourRow('/a', '2026-04-10T09:00:00-07:00', '2026-04-10', 2, 20),
    ])
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].rowCount).toBe(2)
  })

  it('keeps daily partitions and hourly partitions distinct under the same table prefix', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeHour(hourCtx(), [hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10')])
    // A daily pages write under a different table — should coexist.
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10', searchType: 'discover' },
      [{ url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 5 }],
    )
    const live = manifestStore.snapshot()
    expect(live.map(e => e.partition).sort()).toEqual(['daily/2026-04-10', 'hourly/2026-04-10'])
  })
})

describe('gcOrphansImpl hourly retention', () => {
  it('retires hourly entries older than the retention window', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)

    let now = 1_700_000_000_000
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now: () => now })
    await engine.writeHour(hourCtx(), [hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10')])

    // Advance 100 days; default 90d retention should expire the entry.
    now += 100 * 24 * 60 * 60 * 1000
    const res = await gcOrphansImpl(
      { dataSource, manifestStore },
      now,
      24 * 60 * 60 * 1000,
      { userId: 'u1', siteId: 's1' },
    )
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    expect(manifestStore.snapshot().filter(e => e.partition.startsWith('hourly/'))).toHaveLength(0)
  })

  it('keeps hourly entries inside the retention window', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)

    let now = 1_700_000_000_000
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now: () => now })
    await engine.writeHour(hourCtx(), [hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10')])

    now += 30 * 24 * 60 * 60 * 1000
    await gcOrphansImpl(
      { dataSource, manifestStore },
      now,
      24 * 60 * 60 * 1000,
      { userId: 'u1', siteId: 's1' },
    )
    expect(manifestStore.snapshot().filter(e => e.partition.startsWith('hourly/'))).toHaveLength(1)
  })

  it('honors hourlyRetentionMs override', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)

    let now = 1_700_000_000_000
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now: () => now })
    await engine.writeHour(hourCtx(), [hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10')])

    now += 8 * 24 * 60 * 60 * 1000
    // 7-day retention — entry is 8d old, should expire.
    await gcOrphansImpl(
      { dataSource, manifestStore },
      now,
      24 * 60 * 60 * 1000,
      { userId: 'u1', siteId: 's1', hourlyRetentionMs: 7 * 24 * 60 * 60 * 1000 },
    )
    expect(manifestStore.snapshot().filter(e => e.partition.startsWith('hourly/'))).toHaveLength(0)
  })
})

describe('rebuildDailyFromHourly', () => {
  it('aggregates hourly rows into one daily row per url', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeHour(hourCtx(), [
      hourRow('/a', '2026-04-10T08:00:00-07:00', '2026-04-10', 1, 10),
      hourRow('/a', '2026-04-10T09:00:00-07:00', '2026-04-10', 2, 20),
      hourRow('/b', '2026-04-10T08:00:00-07:00', '2026-04-10', 5, 50),
    ])

    const result = await rebuildDailyFromHourly({
      engine: engine as unknown as Parameters<typeof rebuildDailyFromHourly>[0]['engine'],
      ctx: { userId: 'u1', siteId: 's1' },
      date: '2026-04-10',
      searchType: 'discover',
    })

    // The in-memory executor unions rather than aggregates, so we assert
    // orchestration (writeDay invoked under pages/discover/daily) rather than
    // GROUP BY semantics — those are exercised by the duckdb-node contract.
    expect(result.rowsWritten).toBeGreaterThanOrEqual(2)
    const pagesEntries = manifestStore.snapshot().filter(e => e.table === 'pages')
    expect(pagesEntries).toHaveLength(1)
    expect(pagesEntries[0]!.partition).toBe('daily/2026-04-10')
    expect(pagesEntries[0]!.searchType).toBe('discover')
  })
})
