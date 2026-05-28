/**
 * Unit tests for the R2 Data Catalog 429 commit-retry wrapper
 * (`icebergAppendRetrying` / `isCommitRateLimited`) — Phase-1.5 hardening.
 *
 * icebird's `commitWithRetry` retries 412/409 optimistic-concurrency
 * conflicts internally but treats R2 Data Catalog's `429 too many commits to
 * this table` as fatal. `icebergAppendRetrying` closes that gap. No network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the whole icebird module — the retry wrapper only needs `icebergAppend`.
const icebergAppend = vi.fn(async () => ({}))
vi.mock('icebird', () => ({
  icebergAppend,
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  restCatalogConnect: vi.fn(),
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables: vi.fn(),
  s3SignedResolver: vi.fn(),
}))

const { icebergAppendRetrying, isCommitRateLimited } = await import('../src/iceberg-catalog')

const APPEND_ARGS = {
  catalog: { type: 'rest' } as never,
  namespace: 'gsc',
  table: 'pages',
  resolver: {} as never,
  records: [{ url: '/', site_id: 's1', search_type: 'web' }],
}

/** A retry policy with a synchronous sleep + deterministic jitter — no real waiting. */
const FAST = { sleep: async () => {}, random: () => 0.5 }

describe('isCommitRateLimited', () => {
  it('matches a numeric 429 status', () => {
    expect(isCommitRateLimited({ status: 429 })).toBe(true)
    expect(isCommitRateLimited({ status: 409 })).toBe(false)
    expect(isCommitRateLimited({ status: 500 })).toBe(false)
  })

  it('matches the R2 rate-limit message text', () => {
    expect(isCommitRateLimited(new Error('429 too many commits to this table'))).toBe(true)
    expect(isCommitRateLimited(new Error('too many commits to this table'))).toBe(true)
    expect(isCommitRateLimited(new Error('rate limit exceeded'))).toBe(true)
    expect(isCommitRateLimited(new Error('412 conflict'))).toBe(false)
    expect(isCommitRateLimited('plain string 429')).toBe(true)
  })
})

describe('icebergAppendRetrying', () => {
  beforeEach(() => icebergAppend.mockReset().mockResolvedValue({}))
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
    icebergAppend
      .mockRejectedValueOnce(rl())
      .mockRejectedValueOnce(rl())
      .mockRejectedValueOnce(rl())
      .mockRejectedValueOnce(rl())
    const caught = await icebergAppendRetrying(APPEND_ARGS, { ...FAST, maxAttempts: 4 })
      .then(() => undefined, (e: unknown) => e)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('429')
    expect(icebergAppend).toHaveBeenCalledTimes(4)
  })

  // --- Documented CURRENT behavior (Issue 5) -----------------------------
  //
  // icebird's `commitWithRetry` retries 412/409 optimistic-concurrency
  // conflicts INTERNALLY (without re-uploading data files). This wrapper must
  // therefore NOT also retry 412/409 — doing so would re-run the full
  // `icebergAppend`, re-uploading data files and orphaning the previous
  // attempt's parquet objects. These tests pin that contract.

  it('does NOT retry a 409 conflict (icebird retries it internally)', async () => {
    icebergAppend.mockRejectedValueOnce(new Error('409 conflict'))
    await expect(icebergAppendRetrying(APPEND_ARGS, FAST)).rejects.toThrow('409')
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 412 precondition failure (icebird retries it internally)', async () => {
    icebergAppend.mockRejectedValueOnce(new Error('412 precondition failed'))
    await expect(icebergAppendRetrying(APPEND_ARGS, FAST)).rejects.toThrow('412')
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 5xx transient error — it propagates on the first attempt', async () => {
    icebergAppend.mockRejectedValueOnce(new Error('503 service unavailable'))
    await expect(icebergAppendRetrying(APPEND_ARGS, FAST)).rejects.toThrow('503')
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('re-runs icebergAppend on each 429 retry — the documented re-upload-orphan risk', async () => {
    // A 429 that escapes icebird is retried HERE by re-running the WHOLE
    // icebergAppend, which re-prepares + re-uploads data files. The previous
    // attempt's parquet objects become orphans. This pins that each retry is a
    // fresh full call (the orphan source), not an internal manifest-only redo.
    icebergAppend
      .mockRejectedValueOnce(new Error('429 too many commits to this table'))
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    expect(icebergAppend).toHaveBeenCalledTimes(2)
    // both calls received the SAME args object — a re-upload, not a manifest-only retry.
    expect(icebergAppend.mock.calls[0][0]).toBe(icebergAppend.mock.calls[1][0])
  })

  it('backs off with full-jitter exponential delay between 429 retries', async () => {
    const delays: number[] = []
    icebergAppend
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, {
      sleep: async (ms: number) => { delays.push(ms) },
      random: () => 1, // jitter at the ceiling
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    })
    // ceilings: attempt 0 → 100, attempt 1 → 200 (base * 2^attempt).
    expect(delays).toEqual([100, 200])
  })
})
