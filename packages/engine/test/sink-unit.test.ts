/**
 * Unit tests for the `Sink` storage layer — the in-memory fake and the
 * `IcebergAppendSink` (against a mocked `icebird`). No I/O, no docker.
 *
 * Ingest is 100% append-only (design v5): there is no overwrite path. `emit`
 * appends; re-emitting a slice accumulates duplicates. Exactly-once is the
 * D1 ingested-days ledger's job, not the sink's.
 */

import type { IcebergCatalogConfig } from '../src/iceberg/catalog'
import type { SinkSlice } from '../src/sink'
import type { Row } from '../src/storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `IcebergAppendSink` (and `connectIcebergCatalog`) talk to the R2 Data
// Catalog through `icebird`. Mock the whole module so the unit tests stay
// network-free; the real append path is covered by the local-Iceberg test
// and the synthetic end-to-end script.
const icebergAppend = vi.fn(async () => ({}))
const restCatalogConnect = vi.fn(async () => ({ type: 'rest', prefix: '' }))
const s3SignedResolver = vi.fn(() => ({ reader: vi.fn() }))
// `cachingResolver` wraps the signed resolver in `connectIcebergCatalog`; mock
// it as an identity passthrough so the mocked resolver flows through unchanged.
vi.mock('icebird', () => ({ icebergAppend, restCatalogConnect, s3SignedResolver, cachingResolver: (r: unknown) => r }))

const { createInMemorySink } = await import('../src/sinks/in-memory-sink')
const { createIcebergAppendSink } = await import('../src/iceberg/append-sink')

const CTX = { userId: 'u1', siteId: 'site-1' }

function slice(over: Partial<SinkSlice> = {}): SinkSlice {
  return {
    ctx: CTX,
    table: 'pages',
    searchType: 'web',
    date: '2026-04-01',
    ...over,
  }
}

function pageRow(url: string, clicks: number): Row {
  return { url, date: '2026-04-01', clicks, impressions: clicks * 10, sum_position: clicks * 5 }
}

describe('createInMemorySink', () => {
  it('declares append-only capabilities', () => {
    const sink = createInMemorySink()
    expect(sink.capabilities).toEqual({ appendOnly: true })
  })

  it('emit appends rows and reports the accepted count', async () => {
    const sink = createInMemorySink()
    const res = await sink.emit(slice(), [pageRow('/', 10), pageRow('/about', 5)])
    expect(res.rowCount).toBe(2)
    expect(sink.rows).toHaveLength(2)
  })

  it('injects site_id and search_type identity columns the caller must not pre-populate', async () => {
    const sink = createInMemorySink()
    await sink.emit(slice({ searchType: 'discover' }), [pageRow('/', 10)])
    expect(sink.rows[0]).toMatchObject({ site_id: 'site-1', search_type: 'discover', url: '/' })
  })

  it('emit is append: re-emitting the same slice accumulates duplicates', async () => {
    const sink = createInMemorySink()
    await sink.emit(slice(), [pageRow('/', 10)])
    await sink.emit(slice(), [pageRow('/', 10)])
    expect(sink.rowsForSlice(slice())).toHaveLength(2)
  })

  it('rowsFor filters by table', async () => {
    const sink = createInMemorySink()
    await sink.emit(slice({ table: 'pages' }), [pageRow('/', 1)])
    await sink.emit(slice({ table: 'queries' }), [{ query: 'nuxt', date: '2026-04-01', clicks: 2, impressions: 20, sum_position: 7 }])
    expect(sink.rowsFor('pages')).toHaveLength(1)
    expect(sink.rowsFor('queries')).toHaveLength(1)
  })

  it('close is idempotent and sets closed', async () => {
    const sink = createInMemorySink()
    await sink.close()
    await sink.close()
    expect(sink.closed).toBe(true)
  })

  it('reset drops all rows', async () => {
    const sink = createInMemorySink()
    await sink.emit(slice(), [pageRow('/', 10)])
    sink.reset()
    expect(sink.rows).toHaveLength(0)
  })
})

const CATALOG: IcebergCatalogConfig = {
  catalogUri: 'https://catalog.example/acct/wh',
  warehouse: 'acct_wh',
  namespace: 'gsc',
  catalogToken: 'tok',
  s3: { endpoint: 'https://acct.r2.example', accessKeyId: 'ak', secretAccessKey: 'sk' },
}

describe('createIcebergAppendSink', () => {
  beforeEach(() => {
    // Reset implementations too — tests below install per-table failure /
    // 429 / connection-failure behaviours that must not leak across cases.
    icebergAppend.mockReset().mockResolvedValue({})
    restCatalogConnect.mockReset().mockResolvedValue({ type: 'rest', prefix: '' })
    s3SignedResolver.mockReset().mockReturnValue({ reader: vi.fn() })
  })

  it('declares append-only capabilities', () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    expect(sink.capabilities).toEqual({ appendOnly: true })
  })

  it('emit buffers without touching the network; nothing is written before close', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    const res = await sink.emit(slice(), [pageRow('/', 10)])
    expect(res.rowCount).toBe(1)
    expect(restCatalogConnect).not.toHaveBeenCalled()
    expect(icebergAppend).not.toHaveBeenCalled()
  })

  it('emit of an empty slice buffers nothing', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    const res = await sink.emit(slice(), [])
    expect(res.rowCount).toBe(0)
    await sink.close()
    expect(icebergAppend).not.toHaveBeenCalled()
  })

  it('close flushes one icebergAppend per table with identity columns + date encoded', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ searchType: 'discover' }), [pageRow('/', 10), pageRow('/about', 5)])
    await sink.close()

    expect(icebergAppend).toHaveBeenCalledTimes(1)
    const args = icebergAppend.mock.calls[0][0] as { namespace: string, table: string, records: Record<string, unknown>[] }
    expect(args.namespace).toBe('gsc')
    expect(args.table).toBe('pages')
    expect(args.records).toHaveLength(2)
    expect(args.records[0]).toMatchObject({ site_id: 'site-1', search_type: 'discover', url: '/' })
    // `date` is encoded as the integer day-count the Iceberg `date` type
    // stores (days since the Unix epoch). icebird's `month(date)` partition
    // transform accepts the integer; a JS `Date` would trip a hyparquet-writer
    // dictionary-encoding bug that NULLs the column on read-back.
    expect(args.records[0].date).toBe(Math.floor(Date.parse('2026-04-01T00:00:00Z') / 86_400_000))
  })

  it('batches many emits for one table into a single commit, connecting the catalog once', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ date: '2026-04-01' }), [pageRow('/', 10)])
    await sink.emit(slice({ date: '2026-04-02' }), [pageRow('/', 20)])
    await sink.close()
    expect(restCatalogConnect).toHaveBeenCalledTimes(1)
    expect(icebergAppend).toHaveBeenCalledTimes(1)
    const args = icebergAppend.mock.calls[0][0] as { records: unknown[] }
    expect(args.records).toHaveLength(2)
  })

  it('flushes a separate icebergAppend for each table touched', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ table: 'pages' }), [pageRow('/', 1)])
    await sink.emit(slice({ table: 'queries' }), [{ query: 'nuxt', date: '2026-04-01', clicks: 2, impressions: 20, sum_position: 7 }])
    await sink.close()
    expect(icebergAppend).toHaveBeenCalledTimes(2)
    expect(icebergAppend.mock.calls.map(c => (c[0] as { table: string }).table).sort()).toEqual(['pages', 'queries'])
  })

  it('close is idempotent — a second close after a flush is a no-op', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice(), [pageRow('/', 10)])
    await sink.close()
    await sink.close()
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('close reports each flushed table — the ledger ordering signal', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ table: 'pages' }), [pageRow('/', 1)])
    await sink.emit(slice({ table: 'queries' }), [{ query: 'nuxt', date: '2026-04-01', clicks: 2, impressions: 20, sum_position: 7 }])
    const result = await sink.close()
    expect(result.flushed.sort()).toEqual(['pages', 'queries'])
    expect(result.failed).toEqual([])
  })

  it('an empty close reports nothing flushed and nothing failed', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    expect(await sink.close()).toEqual({ flushed: [], failed: [] })
  })

  it('a per-table commit failure lands in `failed` while the others still flush', async () => {
    // `keywords` commit rejects with a non-429 error; `pages` commits fine.
    icebergAppend.mockImplementation(async (args: { table: string }) => {
      if (args.table === 'queries')
        throw new Error('catalog 500')
      return {}
    })
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ table: 'pages' }), [pageRow('/', 1)])
    await sink.emit(slice({ table: 'queries' }), [{ query: 'nuxt', date: '2026-04-01', clicks: 2, impressions: 20, sum_position: 7 }])
    const result = await sink.close()
    expect(result.flushed).toEqual(['pages'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.table).toBe('queries')
    expect(result.failed[0]!.error.kind).toBe('sink-table-flush-failed')
    expect(result.failed[0]!.error.message).toBe('Error: catalog 500')
  })

  it('a 429 is retried and the table recovers — close reports it flushed', async () => {
    let calls = 0
    icebergAppend.mockImplementation(async () => {
      calls++
      if (calls === 1)
        throw new Error('429 too many commits to this table')
      return {}
    })
    const sink = createIcebergAppendSink({
      catalog: CATALOG,
      commitRetry: { sleep: async () => {}, random: () => 0 },
    })
    await sink.emit(slice(), [pageRow('/', 10)])
    const result = await sink.close()
    expect(calls).toBe(2)
    expect(result.flushed).toEqual(['pages'])
    expect(result.failed).toEqual([])
  })

  it('a catalog connection failure marks every buffered table failed', async () => {
    restCatalogConnect.mockRejectedValueOnce(new Error('catalog unreachable'))
    const sink = createIcebergAppendSink({ catalog: CATALOG })
    await sink.emit(slice({ table: 'pages' }), [pageRow('/', 1)])
    await sink.emit(slice({ table: 'queries' }), [{ query: 'nuxt', date: '2026-04-01', clicks: 2, impressions: 20, sum_position: 7 }])
    const result = await sink.close()
    expect(result.flushed).toEqual([])
    expect(result.failed.map(f => f.table).sort()).toEqual(['pages', 'queries'])
    expect(icebergAppend).not.toHaveBeenCalled()
  })
})
