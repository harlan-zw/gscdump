/**
 * `IcebergDataset.appendRows` / `.appendSink` — dedupe by naturalKey+identity,
 * the INT32 guard, cluster pre-sort, and the ledger-after-flush ordering
 * (ADR-0021 amendment 6: the ledger callback fires ONLY after a successful
 * flush, never before / never on an empty or failed close).
 *
 * No network: `../src/catalog` is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectIcebergCatalog = vi.fn()
const ensureIcebergNamespace = vi.fn()
const icebergAppendRetrying = vi.fn()

vi.mock('../src/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/catalog')>()
  return { ...actual, connectIcebergCatalog, ensureIcebergNamespace, icebergAppendRetrying }
})
vi.mock('icebird', () => ({ icebergCreateTable: vi.fn() }))

const { defineIcebergDataset } = await import('../src/dataset')

const DEF = {
  namespace: 'crawl',
  table: 'pages',
  identity: { kind: 'site-int' as const, encoding: 'int' as const },
  naturalKey: ['url'],
  clusterKey: ['url'],
  columns: [
    { name: 'date', type: 'DATE' as const, required: true },
    { name: 'url', type: 'STRING' as const, required: true },
    { name: 'word_count', type: 'INT' as const, required: false },
  ],
  partition: [
    { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
    { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
  ],
}

const CATALOG = {
  catalogUri: 'https://catalog.example/acct/wh',
  warehouse: 'acct_gsc-team-1',
  namespace: 'crawl',
  catalogToken: 'tok',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'k', secretAccessKey: 's' },
}

const FAKE_CONN = { catalog: { type: 'rest' }, resolver: {}, namespace: 'crawl' }

describe('icebergDataset.appendRows', () => {
  const ds = defineIcebergDataset(DEF)

  beforeEach(() => {
    icebergAppendRetrying.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('dedupes by identity + naturalKey, last-wins', async () => {
    await ds.appendRows(FAKE_CONN as never, [
      { site_id: 42, date: 100, url: '/', word_count: 1 },
      { site_id: 42, date: 100, url: '/', word_count: 99 },
    ])
    const call = icebergAppendRetrying.mock.calls[0][0] as { records: Record<string, unknown>[] }
    expect(call.records).toHaveLength(1)
    expect(call.records[0].word_count).toBe(99)
  })

  it('does not collapse the same naturalKey across different sites', async () => {
    await ds.appendRows(FAKE_CONN as never, [
      { site_id: 1, date: 100, url: '/', word_count: 1 },
      { site_id: 2, date: 100, url: '/', word_count: 2 },
    ])
    const call = icebergAppendRetrying.mock.calls[0][0] as { records: Record<string, unknown>[] }
    expect(call.records).toHaveLength(2)
  })

  it('drops rows with a missing/out-of-range INT32 site_id, reporting them as skipped', async () => {
    const result = await ds.appendRows(FAKE_CONN as never, [
      { site_id: 1, date: 100, url: '/a' },
      { site_id: Number.NaN, date: 100, url: '/b' },
      { site_id: 2_147_483_648, date: 100, url: '/c' }, // > INT32_MAX
      { site_id: undefined, date: 100, url: '/d' },
    ])
    expect(result).toEqual({ accepted: 1, skipped: 3 })
    const call = icebergAppendRetrying.mock.calls[0][0] as { records: Record<string, unknown>[] }
    expect(call.records).toHaveLength(1)
    expect(call.records[0].url).toBe('/a')
  })

  it('sorts by clusterKey before appending', async () => {
    await ds.appendRows(FAKE_CONN as never, [
      { site_id: 1, date: 100, url: '/z' },
      { site_id: 1, date: 100, url: '/a' },
    ])
    const call = icebergAppendRetrying.mock.calls[0][0] as { records: Record<string, unknown>[] }
    expect(call.records.map(r => r.url)).toEqual(['/a', '/z'])
  })

  it('is a no-op on an empty batch — never calls icebergAppendRetrying', async () => {
    const result = await ds.appendRows(FAKE_CONN as never, [])
    expect(result).toEqual({ accepted: 0, skipped: 0 })
    expect(icebergAppendRetrying).not.toHaveBeenCalled()
  })

  it('is a no-op when every row is skipped by the guard', async () => {
    const result = await ds.appendRows(FAKE_CONN as never, [{ site_id: undefined, date: 100, url: '/' }])
    expect(result).toEqual({ accepted: 0, skipped: 1 })
    expect(icebergAppendRetrying).not.toHaveBeenCalled()
  })

  it('coerces BigInt column values to Number', async () => {
    await ds.appendRows(FAKE_CONN as never, [{ site_id: 1, date: 100, url: '/', word_count: 10n as unknown as number }])
    const call = icebergAppendRetrying.mock.calls[0][0] as { records: Record<string, unknown>[] }
    expect(call.records[0].word_count).toBe(10)
    expect(typeof call.records[0].word_count).toBe('number')
  })
})

describe('icebergDataset.appendSink — ledger-after-flush ordering', () => {
  const ds = defineIcebergDataset(DEF)

  beforeEach(() => {
    connectIcebergCatalog.mockReset().mockResolvedValue(FAKE_CONN)
    ensureIcebergNamespace.mockReset().mockResolvedValue(undefined)
    icebergAppendRetrying.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('does not connect when no rows are ever emitted', async () => {
    const sink = ds.appendSink({ catalog: CATALOG })
    const res = await sink.close()
    expect(connectIcebergCatalog).not.toHaveBeenCalled()
    expect(res).toEqual({ flushed: false, accepted: 0, skipped: 0 })
  })

  it('records the ledger ONLY after a successful flush, never before', async () => {
    const events: string[] = []
    icebergAppendRetrying.mockImplementation(async () => {
      events.push('commit')
    })
    const sink = ds.appendSink({
      catalog: CATALOG,
      ledger: {
        record: () => {
          events.push('ledger')
        },
      },
    })
    sink.emit([{ site_id: 1, date: 100, url: '/' }])
    const result = await sink.close()
    expect(result.flushed).toBe(true)
    expect(events).toEqual(['commit', 'ledger'])
  })

  it('never records the ledger when the commit fails', async () => {
    const record = vi.fn()
    icebergAppendRetrying.mockRejectedValue(new Error('catalog 500'))
    const sink = ds.appendSink({ catalog: CATALOG, ledger: { record } })
    sink.emit([{ site_id: 1, date: 100, url: '/' }])
    const result = await sink.close()
    expect(result.flushed).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
    expect(record).not.toHaveBeenCalled()
  })

  it('never records the ledger when every row is guard-dropped (nothing flushed)', async () => {
    const record = vi.fn()
    const sink = ds.appendSink({ catalog: CATALOG, ledger: { record } })
    sink.emit([{ site_id: undefined, date: 100, url: '/' }])
    const result = await sink.close()
    expect(result).toEqual({ flushed: false, accepted: 0, skipped: 1 })
    expect(record).not.toHaveBeenCalled()
    expect(icebergAppendRetrying).not.toHaveBeenCalled()
  })

  it('close() is idempotent — a second close after a flush reports empty', async () => {
    const sink = ds.appendSink({ catalog: CATALOG })
    sink.emit([{ site_id: 1, date: 100, url: '/' }])
    const first = await sink.close()
    expect(first.flushed).toBe(true)
    const second = await sink.close()
    expect(second).toEqual({ flushed: false, accepted: 0, skipped: 0 })
    expect(icebergAppendRetrying).toHaveBeenCalledTimes(1)
  })

  it('ensures the namespace before the first flush', async () => {
    const sink = ds.appendSink({ catalog: CATALOG })
    sink.emit([{ site_id: 1, date: 100, url: '/' }])
    await sink.close()
    expect(ensureIcebergNamespace).toHaveBeenCalledWith(FAKE_CONN)
  })
})
