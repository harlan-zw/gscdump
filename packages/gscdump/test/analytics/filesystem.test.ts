import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJsonCodec,
  createStorageEngine,
  createUnionExecutor,
  dayPartition,
} from '../../src/analytics'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
  filesystemStats,
} from '../../src/analytics/adapters/filesystem'

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
})

describe('integration: filesystem + JSON codec (no DuckDB)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-int-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('happy path: writeDay → query → compactDay → query → compactMonth → query', async () => {
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

    // Compact one day (noop for single shards)
    const dayEntries = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partitions: [dayPartition('2026-03-15')],
    })
    await engine.compactDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-03-15' },
      dayEntries,
    )

    const q2 = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(q2.rows).toHaveLength(3)

    // Compact the whole month
    await engine.compactMonth(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      '2026-03',
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
