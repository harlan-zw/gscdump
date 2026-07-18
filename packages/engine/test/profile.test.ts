import type { BuilderState } from 'gscdump/query'
import type { QuerySpan } from '../src/index'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createDuckDBCodec, createDuckDBExecutor } from '../src/duckdb'
import { collectSpans, createQueryProfiler, createStorageEngine } from '../src/index'
import { createInMemoryDataSource, createInMemoryManifestStore } from './helpers/in-memory'

afterAll(() => {
  resetNodeDuckDB()
})

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

const names = (spans: QuerySpan[]): string[] => spans.map(s => s.name)
const span = (spans: QuerySpan[], name: string): QuerySpan | undefined => spans.find(s => s.name === name)

describe('createQueryProfiler', () => {
  it('records each closed span once, merging open-time and completion meta', () => {
    const spans: QuerySpan[] = []
    let t = 0
    // Monotonic fake clock: each read advances by 5ms, so a span opened and
    // immediately closed measures one tick.
    const profiler = createQueryProfiler(s => spans.push(s), () => (t += 5))

    const end = profiler.start('files.register', { files: 3 })
    end({ buffered: 2 })

    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe('files.register')
    expect(spans[0]!.ms).toBe(5)
    expect(spans[0]!.meta).toEqual({ files: 3, buffered: 2 })
  })

  it('omits meta entirely when neither open nor close supplies any', () => {
    const { profiler, spans } = collectSpans(() => 0)
    profiler.start('query.run')()
    expect(spans[0]).toEqual({ name: 'query.run', ms: 0 })
    expect('meta' in spans[0]!).toBe(false)
  })
})

describe('executor profiling', () => {
  it('emits files.register (with buffered count) then query.run on the buffer path', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource() // no uri() → serial buffer path

    await codec.writeRows({ table: 'pages' }, [
      { url: '/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 500 },
      { url: '/b', date: '2026-04-10', clicks: 20, impressions: 200, sum_position: 1000 },
    ], 'p.parquet', dataSource)

    const { profiler, spans } = collectSpans()
    const result = await executor.execute({
      sql: 'SELECT url, clicks FROM read_parquet({{FILES}}) ORDER BY clicks DESC',
      params: [],
      fileKeys: { FILES: ['p.parquet'] },
      dataSource,
      table: 'pages',
      profiler,
    })

    expect(result.rows).toHaveLength(2)
    expect(names(spans)).toEqual(['files.register', 'query.run'])
    // One key, no uri → it took the serial read+register path.
    expect(span(spans, 'files.register')!.meta).toEqual({ files: 1, buffered: 1 })
    expect(span(spans, 'query.run')!.meta).toEqual({ rows: 2 })
  })

  it('records buffered=0 when every key resolves to a native URI (fast path)', async () => {
    const handle = createNodeDuckDBHandle()
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    // No files → fast path, but the register span still fires with buffered 0.
    const dataSource = createInMemoryDataSource()

    const { profiler, spans } = collectSpans()
    await executor.execute({
      sql: 'SELECT url FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: [] },
      dataSource,
      table: 'pages',
      profiler,
    })

    expect(span(spans, 'files.register')!.meta).toEqual({ files: 0, buffered: 0 })
  })

  it('reads buffer-path files concurrently, not one-at-a-time', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const backing = createInMemoryDataSource()

    const keys = ['a.parquet', 'b.parquet', 'c.parquet', 'd.parquet']
    for (const k of keys) {
      await codec.writeRows({ table: 'pages' }, [
        { url: `/${k}`, date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
      ], k, backing)
    }

    // Wrap reads to record peak concurrency. A small delay holds each read open
    // long enough that a serial loop would never overlap them.
    let inFlight = 0
    let peak = 0
    const dataSource = {
      ...backing,
      async read(key: string, range?: { start: number, end: number }, signal?: AbortSignal) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 10))
        try {
          return await backing.read(key, range, signal)
        }
        finally {
          inFlight--
        }
      },
      // no uri() → buffer path
      uri: undefined,
    }

    const result = await executor.execute({
      sql: 'SELECT COUNT(*)::BIGINT AS n FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: keys },
      dataSource,
      table: 'pages',
    })

    expect(Number(result.rows[0]!.n)).toBe(keys.length)
    // All four reads overlap — a serial loop would peak at 1.
    expect(peak).toBe(keys.length)
  })

  it('accepts an explicit concurrency ceiling for large buffer-backed reads', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const backing = createInMemoryDataSource()
    const keys = Array.from({ length: 20 }, (_, i) => `bounded-${i}.parquet`)
    for (const key of keys) {
      await codec.writeRows({ table: 'pages' }, [
        { url: `/${key}`, date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
      ], key, backing)
    }

    let inFlight = 0
    let peak = 0
    const dataSource = {
      ...backing,
      async read(key: string, range?: { start: number, end: number }, signal?: AbortSignal) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        try {
          return await backing.read(key, range, signal)
        }
        finally {
          inFlight--
        }
      },
      uri: undefined,
    }
    const executor = createDuckDBExecutor(
      { getDuckDB: async () => handle },
      { bufferReadConcurrency: 4 },
    )

    await executor.execute({
      sql: 'SELECT COUNT(*)::BIGINT AS n FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: keys },
      dataSource,
      table: 'pages',
    })

    expect(peak).toBe(4)
  })

  it('applies the read ceiling globally and fetches shared placeholder keys once', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const backing = createInMemoryDataSource()
    const keys = Array.from({ length: 8 }, (_, i) => `global-${i}.parquet`)
    for (const key of keys) {
      await codec.writeRows({ table: 'pages' }, [
        { url: `/${key}`, date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
      ], key, backing)
    }

    let inFlight = 0
    let peak = 0
    let reads = 0
    const dataSource = {
      ...backing,
      async read(key: string, range?: { offset: number, length: number }, signal?: AbortSignal) {
        reads++
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        try {
          return await backing.read(key, range, signal)
        }
        finally {
          inFlight--
        }
      },
      uri: undefined,
    }
    const executor = createDuckDBExecutor(
      { getDuckDB: async () => handle },
      { bufferReadConcurrency: 3 },
    )

    await executor.execute({
      sql: 'SELECT COUNT(*)::BIGINT AS n FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: {
        FILES: keys.slice(0, 5),
        EXTRA: [keys[0]!, ...keys.slice(5)],
      },
      dataSource,
      table: 'pages',
    })

    expect(peak).toBe(3)
    expect(reads).toBe(keys.length)
  })
})

describe('engine query profiling', () => {
  it('emits the full nested breakdown via ctx.profiler in completion order', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
    )

    const { profiler, spans } = collectSpans()
    await engine.query({ userId: 'u1', siteId: 's1', profiler }, stateForDay('2026-04-10'))

    // manifest.list closes first; the executor's inner spans close before the
    // executor.execute wrapper that contains them.
    expect(names(spans)).toEqual([
      'manifest.list',
      'files.register',
      'query.run',
      'executor.execute',
    ])
    expect(span(spans, 'manifest.list')!.meta).toMatchObject({ fileSets: 1, files: 1 })
    expect(span(spans, 'executor.execute')!.meta).toMatchObject({ files: 1 })
  })

  it('omitting the profiler runs the query unchanged (zero-overhead path)', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      [{ url: '/', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 }],
    )

    const res = await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(res.rows).toHaveLength(1)
  })
})
