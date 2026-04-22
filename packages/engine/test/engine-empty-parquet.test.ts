import type { BuilderState } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function stateForDay(date: string): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: date,
        expression2: date,
      }],
    } as any,
  }
}

describe('engine empty-parquet handling', () => {
  it('writeDay with [] produces a readable, schema-correct empty file', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [],
    )

    const [entry] = manifestStore.snapshot()
    expect(entry.rowCount).toBe(0)
    expect(entry.bytes).toBeGreaterThan(0)

    const result = await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(result.rows).toEqual([])
  })

  it('round-trip through compactRows preserves empty-file readability', async () => {
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const codec = createJsonCodec()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec,
      executor,
      now: () => Date.UTC(2026, 4, 1),
    })

    // An older empty day so compactOlderThan will pick it up.
    await engine.writeDay(
      {
        userId: 'u1',
        siteId: 's1',
        table: 'pages',
        date: '2026-03-01',
        now: () => Date.parse('2026-03-01T00:00:00Z'),
      },
      [],
    )

    await engine.compactTiered(
      { userId: 'u1', siteId: 's1', table: 'pages', now: () => Date.UTC(2026, 4, 1) },
      { raw: 15, d7: 15, d30: 999 },
    )

    // An empty-only month doesn't actually need compaction (one input already at monthly).
    // Force the codec path by writing two empty days and compacting both.
    await engine.writeDay(
      {
        userId: 'u1',
        siteId: 's1',
        table: 'pages',
        date: '2026-03-02',
        now: () => Date.parse('2026-03-02T00:00:00Z'),
      },
      [],
    )
    await engine.compactTiered(
      { userId: 'u1', siteId: 's1', table: 'pages', now: () => Date.UTC(2026, 4, 1) + 60_000 },
      { raw: 15, d7: 15, d30: 999 },
    )

    const live = manifestStore.snapshot()
    expect(live.length).toBeGreaterThanOrEqual(1)

    const res = await engine.query(
      { userId: 'u1', siteId: 's1' },
      {
        dimensions: ['page'],
        filter: {
          _filters: [{
            dimension: 'date',
            operator: 'between',
            expression: '2026-03-01',
            expression2: '2026-03-31',
          }],
        } as any,
      },
    )
    expect(res.rows).toEqual([])
  })
})
