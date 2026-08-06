/**
 * Unit tests for the R2 Data Catalog 429 commit-retry wrapper
 * (`icebergAppendRetrying` / `isCommitRateLimited`) — ported from
 * `@gscdump/engine`'s `iceberg-catalog-retry.test.ts` now that the
 * implementation lives here (ADR-0021 C1). No network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const icebergAppend = vi.fn(async () => ({}))
const icebergAppendBatches = vi.fn(async () => ({}))
const restCatalogLoadTable = vi.fn(async () => ({ metadata: { snapshots: [] as Array<{ summary?: Record<string, string> }> } }))
vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/write/write.js', () => ({ icebergAppend, icebergAppendBatches, icebergDropTable: vi.fn() }))

const { icebergAppendBatchesRetrying, icebergAppendRetrying } = await import('../src/catalog')
const { isCommitRateLimited, isCommitServerError, isCommitTransient } = await import('../src/maintenance')

const APPEND_ARGS = {
  catalog: { type: 'rest' } as never,
  namespace: 'crawl',
  table: 'pages',
  resolver: {} as never,
  records: [{ url: '/', site_id: 1 }],
}

const FAST = { sleep: async () => {}, random: () => 0.5 }

describe('isCommitRateLimited', () => {
  it('matches a numeric 429 status', () => {
    expect(isCommitRateLimited({ status: 429 })).toBe(true)
    expect(isCommitRateLimited({ status: 409 })).toBe(false)
  })

  it('matches the R2 rate-limit message text', () => {
    expect(isCommitRateLimited(new Error('429 too many commits to this table'))).toBe(true)
    expect(isCommitRateLimited(new Error('412 conflict'))).toBe(false)
  })

  it('stays 429-ONLY — a 5xx is a server error, not a rate limit', () => {
    expect(isCommitRateLimited({ status: 500 })).toBe(false)
    expect(isCommitRateLimited({ status: 503 })).toBe(false)
    expect(isCommitRateLimited(new Error('PUT /x: 500 Internal Server Error'))).toBe(false)
  })
})

describe('isCommitServerError', () => {
  it('matches the transient 5xx statuses R2 returns on an object PUT', () => {
    expect(isCommitServerError({ status: 500 })).toBe(true)
    expect(isCommitServerError({ status: 502 })).toBe(true)
    expect(isCommitServerError({ status: 503 })).toBe(true)
    expect(isCommitServerError({ status: 504 })).toBe(true)
  })

  it('matches icebird\'s "status + statusText" message form for a re-thrown/serialized error', () => {
    expect(isCommitServerError(new Error('PUT s3://b/__r2_data_catalog/x/data/f.parquet: 500 Internal Server Error'))).toBe(true)
    expect(isCommitServerError(new Error('PUT s3://b/x/metadata/snap.avro: 503 Service Unavailable'))).toBe(true)
    expect(isCommitServerError('PUT s3://b/x: 502 Bad Gateway')).toBe(true)
    expect(isCommitServerError(new Error('504 Gateway Timeout'))).toBe(true)
  })

  it('does NOT match a bare 5xx-looking digit run — the reason phrase is required', () => {
    // Iceberg data files are named `00500-0-<uuid>.parquet`; a substring match
    // on "500" would turn every such path into an infinite retry.
    expect(isCommitServerError(new Error('PUT s3://b/data/00500-0-abc.parquet: 403 Forbidden'))).toBe(false)
    expect(isCommitServerError(new Error('validation failed: expected 500 rows, got 501'))).toBe(false)
    expect(isCommitServerError(new Error('501 Not Implemented'))).toBe(false)
  })

  it('does NOT match permanent 4xx or catalog conflicts', () => {
    expect(isCommitServerError({ status: 400 })).toBe(false)
    expect(isCommitServerError({ status: 403 })).toBe(false)
    expect(isCommitServerError({ status: 409 })).toBe(false)
    expect(isCommitServerError({ status: 412 })).toBe(false)
    expect(isCommitServerError({ status: 429 })).toBe(false)
    expect(isCommitServerError(new Error('412 conflict'))).toBe(false)
  })
})

describe('isCommitTransient', () => {
  it('is the union of the rate-limit and server-error classes', () => {
    expect(isCommitTransient({ status: 429 })).toBe(true)
    expect(isCommitTransient(new Error('429 too many commits to this table'))).toBe(true)
    expect(isCommitTransient({ status: 500 })).toBe(true)
    expect(isCommitTransient(new Error('PUT /x: 500 Internal Server Error'))).toBe(true)
  })

  it('leaves permanent failures permanent', () => {
    expect(isCommitTransient({ status: 400 })).toBe(false)
    expect(isCommitTransient({ status: 403 })).toBe(false)
    expect(isCommitTransient(new Error('412 conflict'))).toBe(false)
    expect(isCommitTransient(new Error('schema validation failed for column impressions'))).toBe(false)
  })
})

describe('icebergAppendRetrying', () => {
  beforeEach(() => {
    icebergAppend.mockReset().mockResolvedValue({})
    restCatalogLoadTable.mockReset().mockResolvedValue({ metadata: { snapshots: [] } })
  })
  afterEach(() => vi.restoreAllMocks())

  it('passes through on first-attempt success — no retry', async () => {
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 and recovers once the commit succeeds', async () => {
    icebergAppend
      .mockRejectedValueOnce(new Error('429 too many commits to this table'))
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    expect(icebergAppend).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a non-429 error — it propagates immediately', async () => {
    icebergAppend.mockRejectedValueOnce(new Error('412 conflict'))
    await expect(icebergAppendRetrying(APPEND_ARGS, FAST)).rejects.toThrow('412 conflict')
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('retries a transient R2 500 on an object PUT and recovers', async () => {
    const put500 = (): Error => Object.assign(
      new Error('PUT https://r2/__r2_data_catalog/t/data/f.parquet: 500 Internal Server Error'),
      { status: 500 },
    )
    icebergAppend
      .mockRejectedValueOnce(put500())
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    expect(icebergAppend).toHaveBeenCalledTimes(3)
  })

  it('throws a 4xx that is NOT 429 immediately, with zero retries', async () => {
    for (const permanent of [
      Object.assign(new Error('PUT /x: 400 Bad Request'), { status: 400 }),
      Object.assign(new Error('PUT /x: 403 Forbidden'), { status: 403 }),
      Object.assign(new Error('409 conflict: table already committed'), { status: 409 }),
      new Error('schema validation failed for column impressions'),
    ]) {
      icebergAppend.mockReset().mockRejectedValueOnce(permanent)
      const caught = await icebergAppendRetrying(APPEND_ARGS, FAST).then(() => undefined, (e: unknown) => e)
      expect(caught).toBe(permanent)
      expect(icebergAppend).toHaveBeenCalledTimes(1)
    }
  })

  it('bounds the 5xx retry budget at maxAttempts and throws the last error', async () => {
    const boom = (): Error => Object.assign(new Error('PUT /x: 500 Internal Server Error'), { status: 500 })
    icebergAppend.mockRejectedValue(boom())
    const caught = await icebergAppendRetrying(APPEND_ARGS, { ...FAST, maxAttempts: 4 }).then(() => undefined, (e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(icebergAppend).toHaveBeenCalledTimes(4)
  })

  it('does NOT re-append a 500 whose commit LANDED', async () => {
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { snapshots: [] } })
    icebergAppend.mockRejectedValueOnce(Object.assign(new Error('PUT /x: 500 Internal Server Error'), { status: 500 }))
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'operation': 'append', 'lakehouse.append-id': 'landed-500' } }] },
    })
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'landed-500' })
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('uses the SAME full-jitter schedule for a 5xx as for a 429', async () => {
    const delays: number[] = []
    icebergAppend
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, {
      sleep: async (ms: number) => { delays.push(ms) },
      random: () => 1,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    })
    expect(delays).toEqual([100, 200])
  })

  it('gives up after maxAttempts of sustained 429s and throws the last error', async () => {
    const rl = (): Error => new Error('429 too many commits to this table')
    icebergAppend.mockRejectedValueOnce(rl()).mockRejectedValueOnce(rl()).mockRejectedValueOnce(rl()).mockRejectedValueOnce(rl())
    const caught = await icebergAppendRetrying(APPEND_ARGS, { ...FAST, maxAttempts: 4 }).then(() => undefined, (e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect(icebergAppend).toHaveBeenCalledTimes(4)
  })

  it('stamps a per-call append-id into the snapshot summary', async () => {
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'id-123' })
    expect(icebergAppend.mock.calls[0][0].snapshotProperties).toEqual({ 'lakehouse.append-id': 'id-123' })
  })

  it('does NOT re-append a 429 whose commit LANDED (the double-count fix)', async () => {
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { snapshots: [] } })
    icebergAppend.mockRejectedValueOnce(new Error('429 too many commits to this table'))
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'operation': 'append', 'lakehouse.append-id': 'landed-1' } }] },
    })
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'landed-1' })
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry when the landed-check fails after a 429', async () => {
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { snapshots: [] } })
    icebergAppend.mockRejectedValueOnce(new Error('429 too many commits to this table'))
    restCatalogLoadTable.mockRejectedValueOnce(new Error('catalog unavailable'))

    await expect(
      icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'ambiguous-1' }),
    ).rejects.toThrow('catalog unavailable')
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('skips the append entirely when the content token already landed (cross-run double fix)', async () => {
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'lakehouse.append-id': 'prior-run' } }] },
    })
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'prior-run' })
    expect(icebergAppend).toHaveBeenCalledTimes(0)
  })

  it('derives a STABLE content token across calls (same records → same id), pagination-safe', async () => {
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    const id1 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['lakehouse.append-id']
    icebergAppend.mockClear()
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    const id2 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['lakehouse.append-id']
    expect(id2).toBe(id1)
    icebergAppend.mockClear()
    await icebergAppendRetrying({ ...APPEND_ARGS, records: [{ url: '/p2', site_id: 1 }] }, FAST)
    const id3 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['lakehouse.append-id']
    expect(id3).not.toBe(id1)
  })

  it('backs off with full-jitter exponential delay between 429 retries', async () => {
    const delays: number[] = []
    icebergAppend.mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, {
      sleep: async (ms: number) => { delays.push(ms) },
      random: () => 1,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    })
    expect(delays).toEqual([100, 200])
  })
})

describe('icebergAppendBatchesRetrying', () => {
  const batchFactory = vi.fn(() => [[{ url: '/', site_id: 1 }]])
  const args = {
    catalog: { type: 'rest' } as never,
    namespace: 'crawl',
    table: 'pages',
    resolver: {} as never,
    batchFactory,
  }

  beforeEach(() => {
    batchFactory.mockClear()
    icebergAppendBatches.mockReset().mockResolvedValue({})
    restCatalogLoadTable.mockReset().mockResolvedValue({ metadata: { snapshots: [] } })
  })

  it('creates a fresh lazy batch source for each 429 retry', async () => {
    icebergAppendBatches
      .mockRejectedValueOnce(new Error('429 too many commits to this table'))
      .mockResolvedValueOnce({})
    await icebergAppendBatchesRetrying(args, { ...FAST, appendId: 'batch-1' })
    expect(batchFactory).toHaveBeenCalledTimes(2)
    expect(icebergAppendBatches).toHaveBeenCalledTimes(2)
    expect(icebergAppendBatches.mock.calls[0][0].snapshotProperties).toEqual({ 'lakehouse.append-id': 'batch-1' })
  })

  it('creates a fresh lazy batch source for a transient 500 retry', async () => {
    icebergAppendBatches
      .mockRejectedValueOnce(Object.assign(new Error('PUT /x: 500 Internal Server Error'), { status: 500 }))
      .mockResolvedValueOnce({})
    await icebergAppendBatchesRetrying(args, { ...FAST, appendId: 'batch-500' })
    expect(batchFactory).toHaveBeenCalledTimes(2)
    expect(icebergAppendBatches).toHaveBeenCalledTimes(2)
  })

  it('propagates a permanent batch failure without retrying', async () => {
    icebergAppendBatches.mockRejectedValueOnce(Object.assign(new Error('400 Bad Request'), { status: 400 }))
    await expect(icebergAppendBatchesRetrying(args, { ...FAST, appendId: 'batch-400' })).rejects.toThrow('400 Bad Request')
    expect(icebergAppendBatches).toHaveBeenCalledTimes(1)
  })

  it('does not replay a batch transaction already recorded in snapshot metadata', async () => {
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'lakehouse.append-id': 'batch-landed' } }] },
    })
    const committed = await icebergAppendBatchesRetrying(args, { ...FAST, appendId: 'batch-landed' })
    expect(committed).toBe(false)
    expect(batchFactory).not.toHaveBeenCalled()
    expect(icebergAppendBatches).not.toHaveBeenCalled()
  })
})
