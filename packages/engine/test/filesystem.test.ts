import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
  filesystemStats,
  renameWithRetry,
  writeFileAtomic,
} from '../src/adapters/filesystem'
import { createStorageEngine } from '../src/index'
import { createJsonCodec, createUnionExecutor } from './helpers/in-memory'

describe('filesystemDataSource', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump Store 日本語 '))
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
    const streamed: string[] = []
    for await (const key of ds.streamList!('u_1/'))
      streamed.push(key)
    expect(streamed).toEqual(listed)
    expect(await ds.head!('u_1/pages/daily/2026-04-10__v1.parquet')).toEqual({ bytes: 4 })

    const slice = await ds.read('u_1/pages/daily/2026-04-10__v1.parquet', { offset: 1, length: 2 })
    expect(Array.from(slice)).toEqual([2, 3])
    const tail = await ds.read('u_1/pages/daily/2026-04-10__v1.parquet', { offset: 2, length: 8 })
    expect(Array.from(tail)).toEqual([3, 4])

    await ds.delete(['u_1/pages/daily/2026-04-10__v1.parquet'])
    expect(await ds.list('u_1/')).toHaveLength(0)
  })

  it('reads and lists files when the Store uses a filesystem root', async () => {
    const root = parse(dir).root
    const prefix = relative(root, dir).split(sep).join('/')
    const key = `${prefix}/pages/data.parquet`
    const ds = createFilesystemDataSource({ rootDir: root })
    const bytes = new Uint8Array([7, 8, 9])

    await ds.write(key, bytes)

    expect(await ds.read(key)).toEqual(bytes)
    expect(await ds.list(prefix)).toEqual([key])
    const streamed: string[] = []
    for await (const entry of ds.streamList!(prefix))
      streamed.push(entry)
    expect(streamed).toEqual([key])
  })

  it('rejects paths that escape root', async () => {
    const ds = createFilesystemDataSource({ rootDir: dir })
    await expect(ds.write('../evil.parquet', new Uint8Array([1]))).rejects.toThrow(/escapes root/)
    await expect(ds.list('../')).rejects.toThrow(/escapes root/)
    await expect(async () => {
      for await (const _ of ds.streamList!('../')) {
        void _
        // Consume the iterator so path validation runs.
      }
    }).rejects.toThrow(/escapes root/)
  })

  it.skipIf(sep !== '/').each(['pages\\day.parquet', '..\\outside.parquet'])('preserves literal POSIX backslashes in %s', async (key) => {
    const rootDir = join(dir, 'store\\folder')
    const ds = createFilesystemDataSource({ rootDir })
    const bytes = new Uint8Array([4, 5, 6])

    await ds.write(key, bytes)

    expect(ds.uri!(key)).toBe(join(rootDir, key))
    expect(new Uint8Array(await readFile(ds.uri!(key)!))).toEqual(bytes)
    expect(await ds.list('')).toEqual([key])
    const streamed: string[] = []
    for await (const entry of ds.streamList!(''))
      streamed.push(entry)
    expect(streamed).toEqual([key])
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

  it('sets one state on many dates in one write', async () => {
    const path = join(dir, 'manifest.json')
    const store = createFilesystemManifestStore({ path })
    const scope = (date: string) => ({ userId: 'u1', siteId: 's1', table: 'pages' as const, date })
    await store.setSyncState(scope('2026-04-10'), 'done', { at: 1000 })

    await store.setSyncStates([scope('2026-04-11'), scope('2026-04-12')], 'pending', { at: 2000 })

    const reopened = createFilesystemManifestStore({ path })
    const states = await reopened.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(states.map(s => [s.date, s.state]).sort()).toEqual([
      ['2026-04-10', 'done'],
      ['2026-04-11', 'pending'],
      ['2026-04-12', 'pending'],
    ])
  })

  it('round-trips registerVersion + listLive + listRetired through JSON file', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    await store.registerVersion({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partition: 'daily/2026-04-10',
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
        partition: 'daily/2026-04-10',
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
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'queries' }, '2026-04-01', 4000)

    const ws = await store.getWatermarks({ userId: 'u1' })
    expect(ws).toHaveLength(2)
    const pages = ws.find(w => w.table === 'pages')!
    expect(pages.oldestDateSynced).toBe('2026-03-10')
    expect(pages.newestDateSynced).toBe('2026-03-20')
    expect(pages.lastSyncAt).toBe(3000)

    const scoped = await store.getWatermarks({ userId: 'u1', table: 'queries' })
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

  it('tracks sync watermarks per searchType with legacy web compatibility', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })

    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-04-10', 1000)
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'discover' }, '2026-04-11', 2000)

    const all = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(all).toHaveLength(2)

    const web = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'web' })
    expect(web).toHaveLength(1)
    expect(web[0].newestDateSynced).toBe('2026-04-10')

    const discover = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'discover' })
    expect(discover).toHaveLength(1)
    expect(discover[0].newestDateSynced).toBe('2026-04-11')
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

  it('sync state is keyed per searchType — different types do not collide', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const baseScope = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }

    await store.setSyncState({ ...baseScope, searchType: 'web' }, 'done', { at: 1000 })
    await store.setSyncState({ ...baseScope, searchType: 'discover' }, 'inflight', { at: 2000 })

    const all = await store.getSyncStates({ userId: 'u1' })
    expect(all).toHaveLength(2)

    const web = await store.getSyncStates({ userId: 'u1', searchType: 'web' })
    expect(web).toHaveLength(1)
    expect(web[0].state).toBe('done')

    const discover = await store.getSyncStates({ userId: 'u1', searchType: 'discover' })
    expect(discover).toHaveLength(1)
    expect(discover[0].state).toBe('inflight')

    // Updating discover does not touch web.
    await store.setSyncState({ ...baseScope, searchType: 'discover' }, 'done', { at: 3000 })
    const webAfter = (await store.getSyncStates({ userId: 'u1', searchType: 'web' }))[0]
    expect(webAfter.state).toBe('done')
    expect(webAfter.updatedAt).toBe(1000)
  })

  it('sync state with omitted searchType matches an explicit `web` filter (legacy compat)', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }
    // Pre-#5 sync state: no searchType field.
    await store.setSyncState(scope, 'done', { at: 1000 })

    const web = await store.getSyncStates({ userId: 'u1', searchType: 'web' })
    expect(web).toHaveLength(1)
    expect(web[0].state).toBe('done')

    const discover = await store.getSyncStates({ userId: 'u1', searchType: 'discover' })
    expect(discover).toHaveLength(0)
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

  it('withLock queues in-process writers for one partition beyond the file-lock retry budget', async () => {
    // A full sync writes every search type of one table and date into the same
    // partition. Their combined hold time exceeds the ~8s file-lock retry
    // budget, which failed writes with "Lock file is already being held".
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, partition: 'daily/2026-04-10' }
    let active = 0
    let peak = 0
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => store.withLock(scope, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 300))
      active--
    })))
    expect(results.filter(result => result.status === 'rejected').map(result => String((result as PromiseRejectedResult).reason))).toEqual([])
    expect(peak).toBe(1)
  }, 30_000)

  it('filters sync states by state kind and table', async () => {
    const store = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' }, 'done', { at: 1 })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-11' }, 'failed', { at: 2, error: 'x' })
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'queries', date: '2026-04-10' }, 'done', { at: 3 })

    const done = await store.getSyncStates({ userId: 'u1', state: 'done' })
    expect(done).toHaveLength(2)

    const failedPages = await store.getSyncStates({ userId: 'u1', table: 'pages', state: 'failed' })
    expect(failedPages).toHaveLength(1)
    expect(failedPages[0].date).toBe('2026-04-11')
  })

  it('retries transient Windows rename failures when replacing manifest.json', async () => {
    const manifestPath = join(dir, 'manifest.json')
    let renameAttempts = 0
    const sleeps: number[] = []
    const store = createFilesystemManifestStore({
      path: manifestPath,
      renameRetry: {
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        random: () => 0.5,
        rename: async (src, dst) => {
          renameAttempts++
          if (renameAttempts <= 2) {
            const code = renameAttempts === 1 ? 'EPERM' : 'EBUSY'
            throw Object.assign(new Error(`${code}: operation not permitted, rename '${src}' -> '${dst}'`), { code })
          }
          await rename(src, dst)
        },
      },
    })

    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'dates', date: '2026-04-10' }, 'done', { at: 1000 })

    expect(renameAttempts).toBe(3)
    expect(sleeps).toHaveLength(2)
    expect(await store.getSyncStates({ userId: 'u1' })).toHaveLength(1)
    const files = await readdir(dir)
    expect(files).toEqual(['manifest.json'])
  })

  it('serializes manifest reads and writes for the same path so reads never overlap rename', async () => {
    const manifestPath = join(dir, 'manifest.json')
    const events: string[] = []
    const enteredRename = Promise.withResolvers<void>()
    const releaseRename = Promise.withResolvers<void>()
    let gated = false

    const writer = createFilesystemManifestStore({
      path: manifestPath,
      renameRetry: {
        rename: async (src, dst) => {
          if (!gated) {
            gated = true
            events.push('write:rename-start')
            enteredRename.resolve()
            await releaseRename.promise
          }
          await rename(src, dst)
          events.push('write:rename-done')
        },
      },
    })
    const reader = createFilesystemManifestStore({ path: manifestPath })

    const writePromise = writer.setSyncState(
      { userId: 'u1', siteId: 's1', table: 'dates', date: '2026-04-10' },
      'done',
      { at: 1000 },
    )
    await enteredRename.promise

    const readPromise = reader.getSyncStates({ userId: 'u1' }).then((states) => {
      events.push(`read:done(${states.length})`)
      return states
    })

    // Give the event loop a turn to confirm the read waits until rename finishes.
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['write:rename-start'])

    releaseRename.resolve()
    const [, states] = await Promise.all([writePromise, readPromise])
    expect(states).toHaveLength(1)
    expect(events).toEqual(['write:rename-start', 'write:rename-done', 'read:done(1)'])
  })

  it('survives parallel reads and writes across search types on the same manifest', async () => {
    const manifestPath = join(dir, 'manifest.json')
    const store = createFilesystemManifestStore({ path: manifestPath })
    const searchTypes = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const

    await Promise.all(searchTypes.map(async (searchType, typeIdx) => {
      for (let day = 1; day <= 8; day++) {
        const date = `2026-04-${String(day).padStart(2, '0')}`
        const scope = { userId: 'u1', siteId: 's1', table: 'dates' as const, date, searchType }
        await store.setSyncState(scope, 'inflight', { at: typeIdx * 100 + day })
        await store.listLive({ userId: 'u1', siteId: 's1', table: 'dates', searchType })
        await store.registerVersion({
          userId: 'u1',
          siteId: 's1',
          table: 'dates',
          searchType,
          partition: `daily/${date}`,
          objectKey: `u_u1/s1/dates/daily/${date}__${searchType}.parquet`,
          rowCount: 1,
          bytes: 64,
          createdAt: typeIdx * 100 + day,
        })
        await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'dates', searchType }, date, typeIdx * 100 + day)
        await store.setSyncState(scope, 'done', { at: typeIdx * 100 + day + 1 })
      }
    }))

    expect(await store.listLive({ userId: 'u1', siteId: 's1', table: 'dates' })).toHaveLength(searchTypes.length * 8)
    expect(await store.getSyncStates({ userId: 'u1', siteId: 's1', state: 'done' })).toHaveLength(searchTypes.length * 8)
    const files = await readdir(dir)
    expect(files.filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('renameWithRetry and writeFileAtomic', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-atomic-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'] as const)('retries transient %s rename errors with bounded backoff until rename succeeds', async (code) => {
    let attempts = 0
    const sleeps: number[] = []
    await renameWithRetry('a.tmp', 'a.json', {
      maxAttempts: 5,
      baseDelayMs: 20,
      maxDelayMs: 50,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      rename: async () => {
        attempts++
        if (attempts < 4)
          throw Object.assign(new Error(`${code}: busy`), { code })
      },
    })

    expect(attempts).toBe(4)
    expect(sleeps).toEqual([20, 40, 50])
  })

  it.each(['ENOENT', 'EXDEV', 'ENOSPC', 'EISDIR'] as const)('does not retry non-transient %s rename errors', async (code) => {
    let attempts = 0
    const sleeps: number[] = []
    await expect(renameWithRetry('a.tmp', 'a.json', {
      maxAttempts: 5,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      rename: async () => {
        attempts++
        throw Object.assign(new Error(`${code}: permanent`), { code })
      },
    })).rejects.toMatchObject({ code })

    expect(attempts).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('rethrows the last transient error after maxAttempts', async () => {
    let attempts = 0
    const sleeps: number[] = []
    await expect(renameWithRetry('a.tmp', 'a.json', {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 100,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      rename: async () => {
        attempts++
        throw Object.assign(new Error(`attempt ${attempts}`), { code: 'EPERM' })
      },
    })).rejects.toThrow('attempt 4')

    expect(attempts).toBe(4)
    // Equal jitter with random() = 0 yields half of each exponential ceiling.
    expect(sleeps).toEqual([5, 10, 20])
  })

  it('writeFileAtomic creates parent dirs, retries transient rename, and leaves no temp file', async () => {
    const target = join(dir, 'nested', 'state.json')
    let attempts = 0
    await writeFileAtomic(target, '{"ok":true}', {
      retry: {
        sleep: async () => {},
        rename: async (src, dst) => {
          attempts++
          if (attempts === 1)
            throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' })
          await rename(src, dst)
        },
      },
    })

    expect(attempts).toBe(2)
    expect(await readFile(target, 'utf8')).toBe('{"ok":true}')
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json'])
  })

  it('writeFileAtomic cleans up the temp file and preserves the prior target when rename fails', async () => {
    const target = join(dir, 'state.json')
    await writeFileAtomic(target, '{"v":1}')

    await expect(writeFileAtomic(target, '{"v":2}', {
      retry: {
        maxAttempts: 2,
        sleep: async () => {},
        rename: async () => {
          throw Object.assign(new Error('EPERM: still locked'), { code: 'EPERM' })
        },
      },
    })).rejects.toThrow('EPERM: still locked')

    expect(await readFile(target, 'utf8')).toBe('{"v":1}')
    expect(await readdir(dir)).toEqual(['state.json'])
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

  it('happy path: writeDay → query → compactTiered → query', async () => {
    const codec = createJsonCodec()
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    // Three contiguous days within ISO week starting Mon 2026-03-09. Tiered
    // compaction promotes them through raw→d7 (one weekly) then d7→d30
    // (single weekly bucket per month → one monthly file).
    for (const day of ['2026-03-09', '2026-03-10', '2026-03-11']) {
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

    // Force every tier transition by collapsing all cutoffs to 1 day.
    await engine.compactTiered(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      { raw: 1, d7: 1, d30: 999 },
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

  it('purgeTenant deletes bytes + manifest records for a tenant', async () => {
    const codec = createJsonCodec()
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    for (const userId of ['u1', 'u2']) {
      await engine.writeDay(
        { userId, siteId: 's1', table: 'pages', date: '2026-03-09' },
        [{ url: '/p', date: '2026-03-09', clicks: 1, impressions: 10, sum_position: 50 }],
      )
    }

    expect((await dataSource.list('u_u1/')).length).toBeGreaterThan(0)

    const result = await engine.purgeTenant({ userId: 'u1' })
    expect(result.userId).toBe('u1')
    expect(result.prefix).toBe('u_u1/')
    expect(result.objectsDeleted).toBeGreaterThan(0)
    expect(result.entriesRemoved).toBe(1)

    expect(await dataSource.list('u_u1/')).toEqual([])
    expect(await engine.listLive({ userId: 'u1' })).toEqual([])

    expect(await engine.listLive({ userId: 'u2' })).toHaveLength(1)
    expect((await dataSource.list('u_u2/')).length).toBeGreaterThan(0)
  })

  it('purgeTenant scoped to siteId spares sibling sites', async () => {
    const codec = createJsonCodec()
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    for (const siteId of ['s1', 's2']) {
      await engine.writeDay(
        { userId: 'u1', siteId, table: 'pages', date: '2026-03-09' },
        [{ url: '/p', date: '2026-03-09', clicks: 1, impressions: 10, sum_position: 50 }],
      )
    }

    const result = await engine.purgeTenant({ userId: 'u1', siteId: 's1' })
    expect(result.entriesRemoved).toBe(1)

    const live = await engine.listLive({ userId: 'u1' })
    expect(live).toHaveLength(1)
    expect(live[0]!.siteId).toBe('s2')
    expect((await dataSource.list('u_u1/s2/')).length).toBeGreaterThan(0)
    expect(await dataSource.list('u_u1/s1/')).toEqual([])
  })

  it('does not delete tenant bytes when manifest purge fails', async () => {
    const dataSource = {
      read: vi.fn(),
      write: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => ['u_u1/s1/pages/daily/2026-03-09__v1.parquet']),
    }
    const manifestStore = {
      listLive: vi.fn(),
      listAll: vi.fn(),
      registerVersion: vi.fn(),
      registerVersions: vi.fn(),
      listRetired: vi.fn(),
      delete: vi.fn(),
      getWatermarks: vi.fn(),
      bumpWatermark: vi.fn(),
      getSyncStates: vi.fn(),
      setSyncState: vi.fn(),
      setSyncStates: vi.fn(),
      withLock: vi.fn(async (_scope: unknown, fn: () => Promise<unknown>) => fn()),
      purgeTenant: vi.fn(async () => {
        throw new Error('manifest unavailable')
      }),
    }
    const engine = createStorageEngine({
      dataSource: dataSource as never,
      manifestStore: manifestStore as never,
      codec: createJsonCodec(),
      executor: createUnionExecutor(createJsonCodec()),
    })

    await expect(engine.purgeTenant({ userId: 'u1', siteId: 's1' })).rejects.toThrow('manifest unavailable')
    expect(dataSource.delete).not.toHaveBeenCalled()
  })
})
