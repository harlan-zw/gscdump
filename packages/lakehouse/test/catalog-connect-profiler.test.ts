import type { QueryProfiler } from '../src/index'
import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const restCatalogConnect = vi.fn()
vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect, restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable: vi.fn() }))
vi.mock('icebird/src/fetch.js', () => ({ cachingResolver: (resolver: unknown) => resolver }))
vi.mock('icebird/src/s3.js', () => ({ s3SignedResolver: () => ({ reader: vi.fn(), writer: vi.fn() }) }))

const { connectIcebergCatalog } = await import('../src/index')

const CONFIG = {
  catalogUri: 'https://catalog.example/warehouse',
  warehouse: 'account_bucket',
  namespace: 'gsc',
  catalogToken: 'token',
  s3: { endpoint: 'https://r2.example', accessKeyId: 'access', secretAccessKey: 'secret' },
}

const REST = {
  type: 'rest' as const,
  url: 'https://catalog.example/warehouse',
  prefix: 'warehouse',
  defaults: {},
  overrides: {},
}

let elapsedNow = 0

function collect() {
  const spans: { name: string, ms: number, meta?: Record<string, string | number | boolean> }[] = []
  const profiler: QueryProfiler = {
    start(name) {
      const startedAt = elapsedNow
      return meta => spans.push({ name, ms: elapsedNow - startedAt, meta })
    },
  }
  return { profiler, spans }
}

describe('connectIcebergCatalog profiling', () => {
  beforeEach(() => {
    elapsedNow = 0
    restCatalogConnect.mockReset()
    restCatalogConnect.mockImplementation(async () => {
      elapsedNow += 11
      return REST
    })
  })

  it('records only the REST probe when no cache is configured', async () => {
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { profiler })

    expect(spans).toEqual([{ name: 'catalog.config.rest', ms: 11, meta: { outcome: 'ok' } }])
  })

  it('records a cache miss, REST probe, and awaited cache write', async () => {
    const storage = createStorage()
    const getItem = storage.getItem.bind(storage)
    const setItem = storage.setItem.bind(storage)
    vi.spyOn(storage, 'getItem').mockImplementation((...args) => {
      elapsedNow += 3
      return getItem(...args)
    })
    vi.spyOn(storage, 'setItem').mockImplementation(async (...args) => {
      elapsedNow += 7
      return setItem(...args)
    })
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler, clock: () => 1_000 })

    expect(spans).toEqual([
      { name: 'catalog.config.cache', ms: 3, meta: { outcome: 'miss' } },
      { name: 'catalog.config.rest', ms: 11, meta: { outcome: 'ok' } },
      { name: 'catalog.config.write', ms: 7, meta: { deferred: false } },
    ])
  })

  it('reports a warm hit without probing REST again', async () => {
    const storage = createStorage()
    await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler, clock: () => 2_000 })

    expect(restCatalogConnect).toHaveBeenCalledOnce()
    expect(spans).toEqual([{ name: 'catalog.config.cache', ms: 0, meta: { outcome: 'hit' } }])
  })

  it('distinguishes expired and invalid entries from misses', async () => {
    const storage = createStorage()
    await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    const expired = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler: expired.profiler, clock: () => 3_601_001 })

    expect(expired.spans[0]).toEqual({ name: 'catalog.config.cache', ms: 0, meta: { outcome: 'expired' } })

    vi.spyOn(storage, 'getItem').mockResolvedValueOnce({ v: REST, exp: 'invalid' } as never)
    const invalid = collect()
    await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler: invalid.profiler, clock: () => 1_000 })

    expect(invalid.spans[0]).toEqual({ name: 'catalog.config.cache', ms: 0, meta: { outcome: 'invalid' } })
  })

  it('treats a falsey cached payload as unusable without changing its REST fallback', async () => {
    const storage = createStorage()
    vi.spyOn(storage, 'getItem').mockResolvedValueOnce({ v: null, exp: Date.now() + 60_000 } as never)
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler })

    expect(restCatalogConnect).toHaveBeenCalledOnce()
    expect(spans[0]).toEqual({ name: 'catalog.config.cache', ms: 0, meta: { outcome: 'invalid' } })
  })

  it('reports a cache driver error while still probing REST', async () => {
    const storage = createStorage()
    vi.spyOn(storage, 'getItem').mockRejectedValueOnce(new Error('KV unavailable'))
    const onError = vi.fn()
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage, onError }, profiler })

    expect(onError).toHaveBeenCalledOnce()
    expect(spans.map(span => [span.name, span.meta])).toEqual([
      ['catalog.config.cache', { outcome: 'error' }],
      ['catalog.config.rest', { outcome: 'ok' }],
      ['catalog.config.write', { deferred: false }],
    ])
  })

  it('closes the REST span on rejection and does not write a cache entry', async () => {
    const error = new Error('REST unavailable')
    restCatalogConnect.mockRejectedValueOnce(error)
    const storage = createStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    const { profiler, spans } = collect()

    await expect(connectIcebergCatalog(CONFIG, { cache: { storage }, profiler })).rejects.toBe(error)

    expect(setItem).not.toHaveBeenCalled()
    expect(spans.map(span => [span.name, span.meta])).toEqual([
      ['catalog.config.cache', { outcome: 'miss' }],
      ['catalog.config.rest', { outcome: 'error' }],
    ])
  })

  it('labels deferred writes as handoff time, without waiting for the driver', async () => {
    const storage = createStorage()
    let finishWrite: (() => void) | undefined
    vi.spyOn(storage, 'setItem').mockImplementation(() => new Promise<void>((resolve) => {
      finishWrite = resolve
    }))
    const deferred: Promise<unknown>[] = []
    const { profiler, spans } = collect()

    await connectIcebergCatalog(CONFIG, { cache: { storage, defer: write => deferred.push(write) }, profiler })

    expect(deferred).toHaveLength(1)
    expect(spans.at(-1)).toEqual({ name: 'catalog.config.write', ms: 0, meta: { deferred: true } })
    finishWrite?.()
    await Promise.all(deferred)
  })

  it('ignores profiler failures without changing the connection result', async () => {
    const storage = createStorage()
    const profiler: QueryProfiler = {
      start: () => {
        throw new Error('profiler failed')
      },
    }

    const conn = await connectIcebergCatalog(CONFIG, { cache: { storage }, profiler })

    expect(conn.catalog.prefix).toBe('warehouse')
    expect(restCatalogConnect).toHaveBeenCalledOnce()
  })
})
