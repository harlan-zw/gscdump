import type { SyncStateScope } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function makeEngine(now?: () => number) {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now })
  return { engine, dataSource, manifestStore }
}

function scope(date: string): SyncStateScope {
  return { userId: 'u1', siteId: 's1', table: 'pages', date }
}

describe('sync state machine', () => {
  it('records pending → inflight → done transitions', async () => {
    const { engine } = makeEngine()
    const s = scope('2026-04-10')

    await engine.setSyncState(s, 'pending')
    let states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe('pending')
    expect(states[0].attempts).toBe(0)

    await engine.setSyncState(s, 'inflight')
    states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states[0].state).toBe('inflight')
    expect(states[0].attempts).toBe(1)

    await engine.setSyncState(s, 'done')
    states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states[0].state).toBe('done')
    expect(states[0].attempts).toBe(1) // only inflight bumps attempts
    expect(states[0].error).toBeUndefined()
  })

  it('records failure with an error string and preserves attempt count on retry', async () => {
    const { engine } = makeEngine()
    const s = scope('2026-04-10')

    await engine.setSyncState(s, 'inflight')
    await engine.setSyncState(s, 'failed', { error: 'boom' })
    let states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states[0]).toMatchObject({ state: 'failed', attempts: 1, error: 'boom' })

    // Retry: inflight bumps attempts again
    await engine.setSyncState(s, 'inflight')
    states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states[0]).toMatchObject({ state: 'inflight', attempts: 2 })

    // Success clears the carried error
    await engine.setSyncState(s, 'done')
    states = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(states[0]).toMatchObject({ state: 'done', attempts: 2, error: undefined })
  })

  it('filters by state kind for idempotent resume', async () => {
    const { engine } = makeEngine()
    await engine.setSyncState(scope('2026-04-08'), 'done')
    await engine.setSyncState(scope('2026-04-09'), 'failed', { error: 'quota' })
    await engine.setSyncState(scope('2026-04-10'), 'pending')

    const done = await engine.getSyncStates({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      state: 'done',
    })
    expect(done.map(s => s.date)).toEqual(['2026-04-08'])

    const notDone = (await engine.getSyncStates({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
    })).filter(s => s.state !== 'done').map(s => s.date).sort()
    expect(notDone).toEqual(['2026-04-09', '2026-04-10'])
  })

  it('scopes state to (userId, siteId, table, date) — no cross-tenant bleed', async () => {
    const { engine } = makeEngine()
    await engine.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' }, 'done')
    await engine.setSyncState({ userId: 'u2', siteId: 's1', table: 'pages', date: '2026-04-10' }, 'pending')
    await engine.setSyncState({ userId: 'u1', siteId: 's1', table: 'keywords', date: '2026-04-10' }, 'failed')

    const u1Pages = await engine.getSyncStates({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(u1Pages).toHaveLength(1)
    expect(u1Pages[0].state).toBe('done')

    const u2 = await engine.getSyncStates({ userId: 'u2' })
    expect(u2).toHaveLength(1)
    expect(u2[0].state).toBe('pending')
  })

  it('writeDay bumps the watermark atomically', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
    )
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-08' },
      [{ url: '/', date: '2026-04-08', clicks: 1, impressions: 10, sum_position: 50 }],
    )

    const wms = await manifestStore.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(wms).toHaveLength(1)
    expect(wms[0].newestDateSynced).toBe('2026-04-10')
    expect(wms[0].oldestDateSynced).toBe('2026-04-08')
  })
})

describe('cross-process locking', () => {
  it('serializes concurrent writeDay for the same (userId, siteId, table, partition)', async () => {
    // Monotonic clock ensures each writeDay produces a distinct objectKey
    // (key includes the version timestamp); otherwise concurrent writes at the
    // same ms would collide at the same key and the retired-entries assertion
    // would be meaningless.
    let clock = 1_000_000
    const { engine, manifestStore } = makeEngine(() => clock++)
    const ctx = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }

    const runs = await Promise.all([
      engine.writeDay(ctx, [{ url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }]),
      engine.writeDay(ctx, [{ url: '/b', date: '2026-04-10', clicks: 2, impressions: 20, sum_position: 100 }]),
      engine.writeDay(ctx, [{ url: '/c', date: '2026-04-10', clicks: 3, impressions: 30, sum_position: 150 }]),
    ])
    expect(runs).toHaveLength(3)

    // Only the final writer's manifest entry is live; earlier ones retired.
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    const all = manifestStore.all()
    expect(all.filter(e => e.retiredAt !== undefined)).toHaveLength(2)
  })

  it('different partitions do not block each other', async () => {
    const { engine, manifestStore } = makeEngine()
    const order: string[] = []

    // Two parallel writes to different dates — should both land, order irrelevant.
    await Promise.all([
      engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
        [{ url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
      ).then(() => order.push('d1')),
      engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-11' },
        [{ url: '/b', date: '2026-04-11', clicks: 1, impressions: 10, sum_position: 50 }],
      ).then(() => order.push('d2')),
    ])

    expect(order).toHaveLength(2)
    expect(manifestStore.snapshot()).toHaveLength(2)
  })
})
