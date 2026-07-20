import type { ManifestEntry, SearchType } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/engine'
import { createInMemoryDataSource, createInMemoryManifestStore, createJsonCodec, createUnionExecutor } from './helpers/in-memory'

function entry(partition: string, opts: { searchType?: SearchType, createdAt?: number } = {}): ManifestEntry {
  return {
    userId: '1',
    siteId: 's',
    table: 'pages',
    partition,
    objectKey: `key/${opts.searchType ?? 'web'}/${partition}`,
    rowCount: 1,
    bytes: 1,
    createdAt: opts.createdAt ?? 1,
    ...(opts.searchType ? { searchType: opts.searchType } : {}),
  }
}

function makeEngine(seed: ManifestEntry[]) {
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const dataSource = createInMemoryDataSource()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })
  // Seed via the retire primitive so entries land live.
  return manifestStore.registerVersions(seed, []).then(() => ({ engine, manifestStore }))
}

const ctx = { userId: '1', siteId: 's', table: 'pages' as const }

describe('reconcileSubsumed', () => {
  it('retires exactly the subsumed set, leaving the kept set live', async () => {
    // monthly/2026-04 is fully covered by the four weeklies — it must be retired.
    const { engine, manifestStore } = await makeEngine([
      entry('monthly/2026-04'),
      entry('weekly/2026-03-30'),
      entry('weekly/2026-04-06'),
      entry('weekly/2026-04-13'),
      entry('weekly/2026-04-20'),
      entry('weekly/2026-04-27'),
    ])

    const result = await engine.reconcileSubsumed(ctx)

    expect(result.retired).toBe(1)
    expect(result.partitions).toEqual(['monthly/2026-04'])
    const live = await manifestStore.listLive({ userId: '1', siteId: 's', table: 'pages' })
    expect(live.map(e => e.partition).sort()).toEqual([
      'weekly/2026-03-30',
      'weekly/2026-04-06',
      'weekly/2026-04-13',
      'weekly/2026-04-20',
      'weekly/2026-04-27',
    ])
  })

  it('is idempotent — a second pass retires nothing', async () => {
    const { engine } = await makeEngine([
      entry('monthly/2026-04'),
      entry('weekly/2026-03-30'),
      entry('weekly/2026-04-06'),
      entry('weekly/2026-04-13'),
      entry('weekly/2026-04-20'),
      entry('weekly/2026-04-27'),
    ])

    const first = await engine.reconcileSubsumed(ctx)
    expect(first.retired).toBe(1)
    const second = await engine.reconcileSubsumed(ctx)
    expect(second).toEqual({ retired: 0, partitions: [] })
  })

  it('evaluates subsumption per searchType — a web monthly never cancels a discover weekly', async () => {
    // Both slices have a monthly + covering weeklies. Each slice's monthly is
    // subsumed only by its own weeklies; cross-slice coverage must not count.
    const { engine, manifestStore } = await makeEngine([
      entry('monthly/2026-04', { searchType: 'web' }),
      entry('weekly/2026-03-30', { searchType: 'web' }),
      entry('weekly/2026-04-06', { searchType: 'web' }),
      entry('weekly/2026-04-13', { searchType: 'web' }),
      entry('weekly/2026-04-20', { searchType: 'web' }),
      entry('weekly/2026-04-27', { searchType: 'web' }),
      // discover slice: a lone monthly with no covering finer files — must stay.
      entry('monthly/2026-04', { searchType: 'discover' }),
    ])

    const result = await engine.reconcileSubsumed(ctx)

    expect(result.retired).toBe(1)
    const live = await manifestStore.listLive({ userId: '1', siteId: 's', table: 'pages', searchType: 'discover' })
    expect(live.map(e => e.partition)).toEqual(['monthly/2026-04'])
  })
})
