import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
  filesystemStats,
} from '../src/adapters/filesystem'
import {
  createStorageEngine,
  dayPartition,
} from '../src/index'
import { createJsonCodec, createUnionExecutor } from './helpers/in-memory'

describe('filesystemDataSource', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-fs-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes, reads, lists, and deletes bytes', async () => {
    const ds = createFilesystemDataSource({ rootDir: dir })
    const bytes = new Uint8Array([1, 2, 3, 4])
    await ds.write('u_1/pages/daily/2026-04-10__v1.parquet', bytes)

    const read = await ds.read('u_1/pages/daily/2026-04-10__v1.parquet')
    expect(Array.from(read)).toEqual([1, 2, 3, 4])

    const listed = await ds.list('u_1/')
    expect(listed).toContain('u_1/pages/daily/2026-04-10__v1.parquet')

    const slice = await ds.read('u_1/pages/daily/2026-04-10__v1.parquet', { offset: 1, length: 2 })
    expect(Array.from(slice)).toEqual([2, 3])

    await ds.delete(['u_1/pages/daily/2026-04-10__v1.parquet'])
    expect(await ds.list('u_1/')).toHaveLength(0)
  })

  it('rejects paths that escape root', async () => {
    const ds = createFilesystemDataSource({ rootDir: dir })
    await expect(ds.write('../evil.parquet', new Uint8Array([1]))).rejects.toThrow(/escapes root/)
  })
})

describe('filesystemManifestStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-manifest-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips registerVersion + listLive + listRetired through JSON file', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    await store.registerVersion({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partition: dayPartition('2026-04-10'),
      objectKey: 'u_u1/s1/pages/daily/2026-04-10__v1.parquet',
      rowCount: 3,
      bytes: 100,
      createdAt: 1000,
    })

    const live = await store.listLive({ userId: 'u1', table: 'pages' })
    expect(live).toHaveLength(1)

    // New version retires the old one
    await store.registerVersion(
      {
        userId: 'u1',
        siteId: 's1',
        table: 'pages',
        partition: dayPartition('2026-04-10'),
        objectKey: 'u_u1/s1/pages/daily/2026-04-10__v2.parquet',
        rowCount: 4,
        bytes: 120,
        createdAt: 2000,
      },
      live,
    )

    const afterLive = await store.listLive({ userId: 'u1', table: 'pages' })
    expect(afterLive).toHaveLength(1)
    expect(afterLive[0].objectKey).toContain('__v2')

    const retired = await store.listRetired(Number.MAX_SAFE_INTEGER)
    expect(retired).toHaveLength(1)
    expect(retired[0].objectKey).toContain('__v1')
    expect(retired[0].retiredAt).toBe(2000)
  })

  it('survives concurrent enqueued registerVersion calls without data loss', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const writes = Array.from({ length: 10 }, (_, i) => store.registerVersion({
      userId: 'u1',
      table: 'pages',
      partition: `daily/2026-04-${String(i + 1).padStart(2, '0')}`,
      objectKey: `u_u1/pages/daily/2026-04-${String(i + 1).padStart(2, '0')}__v1.parquet`,
      rowCount: 1,
      bytes: 50,
      createdAt: 1000 + i,
    }))
    await Promise.all(writes)

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(10)
  })

  it('tracks sync watermarks per (userId, siteId, table)', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })

    // First bump seeds both bounds
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-15', 1000)

    // Newer date extends the upper bound, preserves lower bound
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-20', 2000)

    // Older date extends the lower bound, preserves upper bound
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-10', 3000)

    // An out-of-order older timestamp must not regress lastSyncAt
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-12', 500)

    // Different table keeps its own watermark
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'keywords' }, '2026-04-01', 4000)

    const ws = await store.getWatermarks({ userId: 'u1' })
    expect(ws).toHaveLength(2)
    const pages = ws.find(w => w.table === 'pages')!
    expect(pages.oldestDateSynced).toBe('2026-03-10')
    expect(pages.newestDateSynced).toBe('2026-03-20')
    expect(pages.lastSyncAt).toBe(3000)

    const scoped = await store.getWatermarks({ userId: 'u1', table: 'keywords' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0].newestDateSynced).toBe('2026-04-01')
  })

  it('persists watermarks across manifest reloads', async () => {
    const path = join(dir, 'manifest.json')
    const a = createFilesystemManifestStore({ path })
    await a.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-04-10', 1000)

    const b = createFilesystemManifestStore({ path })
    const ws = await b.getWatermarks({ userId: 'u1' })
    expect(ws).toHaveLength(1)
    expect(ws[0].newestDateSynced).toBe('2026-04-10')
  })

  it('tracks sync state transitions per (userId, siteId, table, date)', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }

    await store.setSyncState(scope, 'inflight', { at: 1000 })
    let state = (await store.getSyncStates({ userId: 'u1' }))[0]
    expect(state.state).toBe('inflight')
    expect(state.attempts).toBe(1)

    await store.setSyncState(scope, 'failed', { at: 2000, error: 'boom' })
    state = (await store.getSyncStates({ userId: 'u1' }))[0]
    expect(state.state).toBe('failed')
    expect(state.error).toBe('boom')
    expect(state.attempts).toBe(1)

    // Re-entering inflight bumps attempts
    await store.setSyncState(scope, 'inflight', { at: 3000 })
    state = (await store.getSyncStates({ userId: 'u1' }))[0]
    expect(state.state).toBe('inflight')
    expect(state.attempts).toBe(2)
    // failed-state error is preserved while we're mid-retry
    expect(state.error).toBe('boom')

    // done clears error
    await store.setSyncState(scope, 'done', { at: 4000 })
    state = (await store.getSyncStates({ userId: 'u1' }))[0]
    expect(state.state).toBe('done')
    expect(state.error).toBeUndefined()
    expect(state.attempts).toBe(2)
  })

  it('withLock serializes two independent store instances on the same scope', async () => {
    const path = join(dir, 'manifest.json')
    const a = createFilesystemManifestStore({ path })
    const b = createFilesystemManifestStore({ path })
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, partition: 'daily/2026-04-10' }

    const log: string[] = []
    let aEntered = (): void => {}
    const aEnteredSignal = new Promise<void>((r) => {
      aEntered = r
    })

    const first = a.withLock(scope, async () => {
      log.push('a:enter')
      aEntered()
      await new Promise(r => setTimeout(r, 80))
      log.push('a:leave')
    })

    await aEnteredSignal

    const second = b.withLock(scope, async () => {
      log.push('b:enter')
    })

    await Promise.all([first, second])
    expect(log).toEqual(['a:enter', 'a:leave', 'b:enter'])
  })

  it('filters sync states by state kind and table', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' }, 'done', { at: 1 })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-11' }, 'failed', { at: 2, error: 'x' })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'keywords', date: '2026-04-10' }, 'done', { at: 3 })

    const done = await store.getSyncStates({ userId: 'u1', state: 'done' })
    expect(done).toHaveLength(2)

    const failedPages = await store.getSyncStates({ userId: 'u1', table: 'pages', state: 'failed' })
    expect(failedPages).toHaveLength(1)
    expect(failedPages[0].date).toBe('2026-04-11')
  })
})

describe('integration: filesystem + JSON codec (no DuckDB)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-int-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('happy path: writeDay → query → compactOlderThan → query', async () => {
    const codec = createJsonCodec()
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    // writeDay for three days in March
    for (const day of ['2026-03-01', '2026-03-15', '2026-03-31']) {
      await engine.writeDay(
        { userId: 'u1', siteId: 's1', table: 'pages', date: day },
        [{ url: `/p${day}`, date: day, clicks: 1, impressions: 10, sum_position: 50 }],
      )
    }

    const state = {
      dimensions: ['page'],
      filter: {
        _filters: [{ dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' }],
      },
    } as any

    const q1 = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(q1.rows).toHaveLength(3)
    expect(q1.objectKeys).toHaveLength(3)

    // Roll March dailies into the monthly partition (days=1 so any past day qualifies)
    await engine.compactOlderThan(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      1,
    )

    const q3 = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(q3.rows).toHaveLength(3)
    expect(q3.objectKeys).toHaveLength(1)
    expect(q3.objectKeys[0]).toContain('monthly/2026-03')

    // GC has a 1h grace, immediate GC should leave retired entries in place
    const gc1 = await engine.gcOrphans({ now: () => Date.now() }, 60 * 60 * 1000)
    expect(gc1.deleted).toBe(0)

    // Force GC with 0 grace
    const gc2 = await engine.gcOrphans({ now: () => Date.now() + 1 }, 0)
    expect(gc2.deleted).toBeGreaterThan(0)

    const stats = await filesystemStats(dir)
    expect(stats.files).toBeGreaterThan(0)
  })
})
