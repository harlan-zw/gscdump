/**
 * Unit tests for the R2 Data Catalog 429 commit-retry wrapper
 * (`icebergAppendRetrying` / `isCommitRateLimited`) — ported from
 * `@gscdump/engine`'s `iceberg-catalog-retry.test.ts` now that the
 * implementation lives here (ADR-0021 C1). No network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const icebergAppend = vi.fn(async () => ({}))
const restCatalogLoadTable = vi.fn(async () => ({ metadata: { snapshots: [] as Array<{ summary?: Record<string, string> }> } }))
vi.mock('icebird', () => ({
  icebergAppend,
  restCatalogLoadTable,
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  restCatalogConnect: vi.fn(),
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables: vi.fn(),
  s3SignedResolver: vi.fn(),
}))

const { icebergAppendRetrying } = await import('../src/catalog')
const { isCommitRateLimited } = await import('../src/maintenance')

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
