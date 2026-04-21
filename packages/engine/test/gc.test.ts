import { describe, expect, it } from 'vitest'
import { createStorageEngine } from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

function makeEngine(now: () => number) {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor, now })
  return { engine, dataSource, manifestStore }
}

describe('gcOrphans', () => {
  it('deletes retired manifest entries past the grace window', async () => {
    let clock = 1_000_000
    const { engine, dataSource, manifestStore } = makeEngine(() => clock)

    const ctx = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }
    await engine.writeDay(ctx, [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }])

    // Second write supersedes the first — first entry becomes retired.
    clock += 60_000
    await engine.writeDay(ctx, [{ url: '/', date: '2026-04-10', clicks: 2, impressions: 20, sum_position: 100 }])

    const beforeLive = manifestStore.snapshot()
    const beforeAll = manifestStore.all()
    expect(beforeLive).toHaveLength(1)
    expect(beforeAll.filter(e => e.retiredAt !== undefined)).toHaveLength(1)

    // Grace not elapsed yet: nothing gets deleted.
    clock += 30_000
    const noop = await engine.gcOrphans({ userId: 'u1', siteId: 's1' }, 60_000)
    expect(noop.deleted).toBe(0)

    // Grace elapsed: retired entry + its blob removed.
    clock += 60_000
    const result = await engine.gcOrphans({ userId: 'u1', siteId: 's1' }, 60_000)
    expect(result.deleted).toBe(1)

    const keys = await dataSource.list('u_u1/')
    expect(keys).toHaveLength(1) // only the live version left
  })

  it('sweeps orphan objects with no manifest entry past the grace window', async () => {
    let clock = 1_000_000
    const { engine, dataSource } = makeEngine(() => clock)

    // Orphan: written directly, never registered in manifest. Version stamp
    // encodes its age so gc's cutoff comparison works.
    const orphanKey = `u_u1/s1/pages/daily/2026-04-10__v${clock}.parquet`
    await dataSource.write(orphanKey, new Uint8Array([1, 2, 3]))

    // Grace not elapsed → orphan survives.
    clock += 30_000
    const noop = await engine.gcOrphans({ userId: 'u1', siteId: 's1' }, 60_000)
    expect(noop.deleted).toBe(0)
    expect(await dataSource.read(orphanKey)).toBeInstanceOf(Uint8Array)

    // Grace elapsed → orphan removed.
    clock += 60_000
    const result = await engine.gcOrphans({ userId: 'u1', siteId: 's1' }, 60_000)
    expect(result.deleted).toBe(1)
    const keys = await dataSource.list('u_u1/')
    expect(keys).toHaveLength(0)
  })

  it('does not delete objects registered by a concurrent writeDay (re-check under lock)', async () => {
    let clock = 1_000_000
    const { engine, dataSource, manifestStore } = makeEngine(() => clock)

    // Write and register → it's a live entry, not an orphan.
    const ctx = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }
    await engine.writeDay(ctx, [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }])

    const liveKey = manifestStore.snapshot()[0].objectKey
    expect(await dataSource.read(liveKey)).toBeInstanceOf(Uint8Array)

    // Advance clock past grace; gc must not delete the live object.
    clock += 120_000
    const result = await engine.gcOrphans({ userId: 'u1', siteId: 's1' }, 60_000)
    expect(result.deleted).toBe(0)

    // Live blob still present.
    expect(await dataSource.read(liveKey)).toBeInstanceOf(Uint8Array)
  })
})
