/**
 * Unit tests for the R2 Data Catalog 429 commit-retry wrapper
 * (`icebergAppendRetrying` / `isCommitRateLimited`) — Phase-1.5 hardening.
 *
 * icebird's `commitWithRetry` retries 412/409 optimistic-concurrency
 * conflicts internally but treats R2 Data Catalog's `429 too many commits to
 * this table` as fatal. `icebergAppendRetrying` closes that gap. No network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the whole icebird module — the retry wrapper needs `icebergAppend` plus
// `restCatalogLoadTable` (the landed-check reloads the table to look for the
// stamped append-id). Default load returns no snapshots → "not landed".
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

const { icebergAppendRetrying, isCommitRateLimited } = await import('../src/iceberg/catalog')

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

  it('re-runs icebergAppend on a 429 that did NOT land (orphan, no double)', async () => {
    // A 429 whose commit did not apply is retried HERE by re-running the WHOLE
    // icebergAppend (re-prepare + re-upload); the prior attempt's parquet is an
    // orphan. The landed-check (default mock → no matching snapshot) confirms it
    // didn't land, so the re-run is safe. Pins that each retry is a fresh full
    // call, not an internal manifest-only redo.
    icebergAppend
      .mockRejectedValueOnce(new Error('429 too many commits to this table'))
      .mockResolvedValueOnce({})
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    expect(icebergAppend).toHaveBeenCalledTimes(2)
    // both calls received the SAME args object — a re-upload, not a manifest-only retry.
    expect(icebergAppend.mock.calls[0][0]).toBe(icebergAppend.mock.calls[1][0])
  })

  // --- Idempotent re-run: a landed-but-errored commit must NOT double ------
  //
  // R2 Data Catalog can apply a commit and STILL surface 429 (or a lost ack
  // looks identical). Re-running icebergAppend then appends a SECOND copy of the
  // rows → silent double-count. The wrapper stamps a per-call `gscdump.append-id`
  // into the snapshot summary and reloads the table to check whether it already
  // landed before retrying or giving up.

  it('stamps a per-call append-id into the snapshot summary', async () => {
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'id-123' })
    expect(icebergAppend.mock.calls[0][0].snapshotProperties).toEqual({ 'gscdump.append-id': 'id-123' })
  })

  it('does NOT re-append a 429 whose commit LANDED (the double-count fix)', async () => {
    // Pre-append check sees nothing yet (not previously landed) → proceeds.
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { snapshots: [] } })
    // First attempt: the commit applied at R2 but the response was a 429.
    icebergAppend.mockRejectedValueOnce(new Error('429 too many commits to this table'))
    // The post-error landed-check finds the stamped id in a recent snapshot.
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'operation': 'append', 'gscdump.append-id': 'landed-1' } }] },
    })
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'landed-1' })
    // Crucially: only ONE icebergAppend — no second copy appended.
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('returns success for a non-429 error whose commit LANDED (lost ack)', async () => {
    restCatalogLoadTable.mockResolvedValueOnce({ metadata: { snapshots: [] } }) // pre-check: not landed
    icebergAppend.mockRejectedValueOnce(new Error('503 service unavailable'))
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'gscdump.append-id': 'landed-2' } }] },
    })
    // Without the landed-check this would throw 503 → the job re-drives → double.
    await expect(icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'landed-2' })).resolves.toBeUndefined()
    expect(icebergAppend).toHaveBeenCalledTimes(1)
  })

  it('skips the append entirely when the content token already landed (cross-run double fix)', async () => {
    // A queue RETRY of a job that committed-then-died re-derives the SAME content
    // token; the PRE-append check finds it already in a snapshot → no append at all.
    // This is the case a random per-call id could never catch.
    restCatalogLoadTable.mockResolvedValue({
      metadata: { snapshots: [{ summary: { 'gscdump.append-id': 'prior-run' } }] },
    })
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'prior-run' })
    expect(icebergAppend).toHaveBeenCalledTimes(0)
  })

  it('derives a STABLE content token across calls (same records → same id), pagination-safe', async () => {
    await icebergAppendRetrying(APPEND_ARGS, FAST)
    const id1 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['gscdump.append-id']
    icebergAppend.mockClear()
    await icebergAppendRetrying(APPEND_ARGS, FAST) // identical records → identical id
    const id2 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['gscdump.append-id']
    expect(id2).toBe(id1)
    // Different rows (a "page 2") → DIFFERENT token, so it is never falsely skipped.
    icebergAppend.mockClear()
    await icebergAppendRetrying({ ...APPEND_ARGS, records: [{ url: '/p2', site_id: 's1', search_type: 'web' }] }, FAST)
    const id3 = (icebergAppend.mock.calls[0][0] as { snapshotProperties: Record<string, string> }).snapshotProperties['gscdump.append-id']
    expect(id3).not.toBe(id1)
  })

  it('treats a landed-check load failure as "not landed" (falls back to retry)', async () => {
    icebergAppend
      .mockRejectedValueOnce(new Error('429 too many commits to this table'))
      .mockResolvedValueOnce({})
    restCatalogLoadTable.mockRejectedValue(new Error('catalog unreachable'))
    await icebergAppendRetrying(APPEND_ARGS, { ...FAST, appendId: 'x' })
    // Load failed → can't confirm landing → safe fallback is to re-run (no false skip).
    expect(icebergAppend).toHaveBeenCalledTimes(2)
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
