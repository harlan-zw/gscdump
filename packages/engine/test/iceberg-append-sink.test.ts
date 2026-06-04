/**
 * Unit tests for `IcebergAppendSink` — the production append write path.
 *
 * No network: `../iceberg-catalog` is mocked so `connectIcebergCatalog` returns
 * a fake connection and `icebergAppendRetrying` records the records it would
 * commit. Covers: per-table buffering, site_id/search_type injection,
 * date→day-count conversion, BigInt→Number coercion, per-table failure
 * partitioning, connect-failure-fails-all, close() idempotency, and the
 * malformed-date guard.
 */

import type { IcebergAppendSinkOptions, SinkSlice } from '../src/sink'
import type { Row } from '../src/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Captures every icebergAppendRetrying call so assertions can inspect the
// records that would have been committed per table.
interface AppendCall {
  table: string
  records: Record<string, unknown>[]
}
const appendCalls: AppendCall[] = []
const connectIcebergCatalog = vi.fn()
const icebergAppendRetrying = vi.fn(async (args: { table: string, records: Record<string, unknown>[] }) => {
  appendCalls.push({ table: args.table, records: args.records })
})

vi.mock('../src/iceberg/catalog', () => ({
  connectIcebergCatalog,
  icebergAppendRetrying,
}))

const { createIcebergAppendSink } = await import('../src/iceberg/append-sink')

const CATALOG = {
  catalogUri: 'https://catalog.example/acct/wh',
  warehouse: 'acct_gscdump-analytics',
  namespace: 'gsc',
  catalogToken: 'tok',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'k', secretAccessKey: 's' },
}

const FAKE_CONN = { catalog: { type: 'rest' }, resolver: { signed: true }, namespace: 'gsc' }

function makeSink(overrides: Partial<IcebergAppendSinkOptions> = {}) {
  return createIcebergAppendSink({ catalog: CATALOG, ...overrides })
}

function slice(table: SinkSlice['table'], searchType: SinkSlice['searchType'], siteId?: string): SinkSlice {
  return { ctx: { userId: 'u1', siteId }, table, searchType, date: '2026-05-01' }
}

function callFor(table: string): AppendCall | undefined {
  return appendCalls.find(c => c.table === table)
}

describe('icebergAppendSink', () => {
  beforeEach(() => {
    appendCalls.length = 0
    connectIcebergCatalog.mockReset().mockResolvedValue(FAKE_CONN)
    icebergAppendRetrying.mockReset().mockImplementation(async (args: { table: string, records: Record<string, unknown>[] }) => {
      appendCalls.push({ table: args.table, records: args.records })
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('does not connect when no rows are ever emitted', async () => {
    const sink = makeSink()
    const res = await sink.close()
    expect(connectIcebergCatalog).not.toHaveBeenCalled()
    expect(res).toEqual({ flushed: [], failed: [] })
  })

  it('emit buffers per table and commits one icebergAppend per table on close', async () => {
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/b', date: '2026-05-01', clicks: 4, impressions: 5, sum_position: 6 }])
    await sink.emit(slice('queries', 'web', 's1'), [{ query: 'a', date: '2026-05-01', clicks: 7, impressions: 8, sum_position: 9 }])

    // emit must NOT commit — only buffer.
    expect(icebergAppendRetrying).not.toHaveBeenCalled()

    const res = await sink.close()
    expect(icebergAppendRetrying).toHaveBeenCalledTimes(2)
    expect(res.flushed.sort()).toEqual(['pages', 'queries'])
    expect(res.failed).toEqual([])
    // pages buffered two rows into a single commit.
    expect(callFor('pages')!.records).toHaveLength(2)
    expect(callFor('queries')!.records).toHaveLength(1)
  })

  it('returns rowCount 0 and buffers nothing for an empty emit', async () => {
    const sink = makeSink()
    const res = await sink.emit(slice('pages', 'web', 's1'), [])
    expect(res).toEqual({ rowCount: 0 })
    await sink.close()
    expect(icebergAppendRetrying).not.toHaveBeenCalled()
  })

  it('injects site_id and search_type from the slice — never from the row', async () => {
    const sink = makeSink()
    await sink.emit(slice('pages', 'discover', 'my-site'), [
      { url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    await sink.close()
    const rec = callFor('pages')!.records[0]
    expect(rec.site_id).toBe('my-site')
    expect(rec.search_type).toBe('discover')
  })

  it('falls back to empty site_id when slice.ctx.siteId is absent', async () => {
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', undefined), [
      { url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    await sink.close()
    expect(callFor('pages')!.records[0].site_id).toBe('')
  })

  it('converts a YYYY-MM-DD date string to the integer day-count', async () => {
    const sink = makeSink()
    // 2026-05-01 is 20574 days after the Unix epoch.
    const expected = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 86_400_000)
    await sink.emit(slice('pages', 'web', 's1'), [
      { url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    await sink.close()
    expect(callFor('pages')!.records[0].date).toBe(expected)
  })

  it('coerces BigInt metric values to Number', async () => {
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [
      { url: '/', date: '2026-05-01', clicks: 10n, impressions: 99n, sum_position: 3 } as unknown as Row,
    ])
    await sink.close()
    const rec = callFor('pages')!.records[0]
    expect(rec.clicks).toBe(10)
    expect(rec.impressions).toBe(99)
    expect(typeof rec.clicks).toBe('number')
  })

  it('throws on a malformed date string rather than writing NaN', async () => {
    const sink = makeSink()
    await expect(
      sink.emit(slice('pages', 'web', 's1'), [
        { url: '/', date: 'not-a-date', clicks: 1, impressions: 2, sum_position: 3 },
      ]),
    ).rejects.toThrow(/invalid date string/)
  })

  it('throws on an empty date string rather than writing NaN', async () => {
    const sink = makeSink()
    await expect(
      sink.emit(slice('pages', 'web', 's1'), [
        { url: '/', date: '', clicks: 1, impressions: 2, sum_position: 3 },
      ]),
    ).rejects.toThrow(/invalid date string/)
  })

  it('partitions a per-table commit failure into failed while others land in flushed', async () => {
    icebergAppendRetrying.mockImplementation(async (args: { table: string, records: Record<string, unknown>[] }) => {
      if (args.table === 'queries')
        throw new Error('catalog 500 on queries')
      appendCalls.push({ table: args.table, records: args.records })
    })
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    await sink.emit(slice('queries', 'web', 's1'), [{ query: 'a', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])

    const res = await sink.close()
    expect(res.flushed).toEqual(['pages'])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].table).toBe('queries')
    expect(res.failed[0].error.kind).toBe('sink-table-flush-failed')
    expect(res.failed[0].error.message).toContain('catalog 500 on queries')
  })

  it('fails ALL buffered tables when the catalog connection fails', async () => {
    connectIcebergCatalog.mockRejectedValue(new Error('auth refused'))
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    await sink.emit(slice('queries', 'web', 's1'), [{ query: 'a', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])

    const res = await sink.close()
    expect(res.flushed).toEqual([])
    expect(res.failed.map(f => f.table).sort()).toEqual(['pages', 'queries'])
    for (const f of res.failed)
      expect(f.error.message).toContain('auth refused')
    expect(icebergAppendRetrying).not.toHaveBeenCalled()
  })

  it('drops the cached connection after a connect failure so a retry re-connects', async () => {
    connectIcebergCatalog
      .mockRejectedValueOnce(new Error('transient auth blip'))
      .mockResolvedValueOnce(FAKE_CONN)
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])

    const first = await sink.close()
    expect(first.failed).toHaveLength(1)

    // buffer drained by the first close; emit again then close — should reconnect and succeed.
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    const second = await sink.close()
    expect(connectIcebergCatalog).toHaveBeenCalledTimes(2)
    expect(second.flushed).toEqual(['pages'])
  })

  it('close() is idempotent — a second close after a flush reports empty', async () => {
    const sink = makeSink()
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    const first = await sink.close()
    expect(first.flushed).toEqual(['pages'])

    const second = await sink.close()
    expect(second).toEqual({ flushed: [], failed: [] })
    // No additional commit on the second close.
    expect(icebergAppendRetrying).toHaveBeenCalledTimes(1)
  })

  it('forwards the commitRetry policy to icebergAppendRetrying', async () => {
    const commitRetry = { maxAttempts: 9, baseDelayMs: 5 }
    const sink = makeSink({ commitRetry })
    await sink.emit(slice('pages', 'web', 's1'), [{ url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 }])
    await sink.close()
    expect(icebergAppendRetrying).toHaveBeenCalledWith(expect.anything(), commitRetry)
  })
})
