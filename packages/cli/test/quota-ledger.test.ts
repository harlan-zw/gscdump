import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLedgerState, googleErrorMessage, openQuotaLedger, parseQuotaRefusal, recordQuotaOutcome, reserveQuota } from '../src/quota-ledger'

const SITE = 'sc-domain:example.com'
// 10:00 PDT on 2026-09-22. The next PST day starts at 2026-09-23T07:00Z.
const NOW = new Date('2026-09-22T17:00:00Z')
const NEXT_RESET = Date.parse('2026-09-23T07:00:00Z')

function googleError(status: number, message: string, reason: string): Error {
  return Object.assign(new Error(`[POST] "https://searchconsole.googleapis.com": ${status} Forbidden`), {
    status,
    statusCode: status,
    data: { error: { code: status, message, errors: [{ reason, message }] } },
  })
}

describe('reserveQuota', () => {
  it('grants up to the daily URL Inspection cap, then refuses until the PST reset', () => {
    let state = emptyLedgerState()
    const first = reserveQuota(state, { api: 'urlInspection', site: SITE, n: 1990, now: NOW })
    state = first.state
    const second = reserveQuota(state, { api: 'urlInspection', site: SITE, n: 50, now: NOW })
    state = second.state
    const third = reserveQuota(state, { api: 'urlInspection', site: SITE, n: 1, now: NOW })

    expect(first.decision).toEqual({ kind: 'granted', n: 1990 })
    expect(second.decision).toEqual({ kind: 'partial', n: 10, resetsAt: NEXT_RESET })
    expect(third.decision).toEqual({ kind: 'exhausted', resetsAt: NEXT_RESET, reason: '2000 calls a day' })
  })

  it('counts each Site on its own day budget', () => {
    let state = reserveQuota(emptyLedgerState(), { api: 'urlInspection', site: SITE, n: 2000, now: NOW }).state
    expect(reserveQuota(state, { api: 'urlInspection', site: 'https://other.com/', n: 5, now: NOW }).decision).toEqual({ kind: 'granted', n: 5 })
    const tomorrow = new Date(NEXT_RESET + 1000)
    state = reserveQuota(state, { api: 'urlInspection', site: SITE, n: 5, now: tomorrow }).state
    expect(reserveQuota(state, { api: 'urlInspection', site: SITE, n: 5, now: tomorrow }).decision).toEqual({ kind: 'granted', n: 5 })
  })

  it('learns the Search Analytics load quota from a refusal and lifts it later', () => {
    const blocked = recordQuotaOutcome(emptyLedgerState(), {
      api: 'searchAnalytics',
      site: SITE,
      outcome: { kind: 'refused', reason: 'Search Analytics load quota exceeded.' },
      now: NOW,
    })

    const during = reserveQuota(blocked, { api: 'searchAnalytics', site: SITE, n: 1, now: new Date(NOW.getTime() + 60_000) })
    const after = reserveQuota(blocked, { api: 'searchAnalytics', site: SITE, n: 1, now: new Date(NOW.getTime() + 16 * 60_000) })

    expect(during.decision).toEqual({ kind: 'exhausted', resetsAt: NOW.getTime() + 15 * 60_000, reason: 'Search Analytics load quota exceeded.' })
    expect(after.decision).toEqual({ kind: 'granted', n: 1 })
  })

  it('blocks URL Inspection until the PST reset after a daily refusal', () => {
    const blocked = recordQuotaOutcome(emptyLedgerState(), {
      api: 'urlInspection',
      site: SITE,
      outcome: { kind: 'refused', reason: 'Quota exceeded for quota metric' },
      now: NOW,
    })
    expect(reserveQuota(blocked, { api: 'urlInspection', site: SITE, n: 1, now: new Date(NEXT_RESET - 1) }).decision.kind).toBe('exhausted')
    expect(reserveQuota(blocked, { api: 'urlInspection', site: SITE, n: 1, now: new Date(NEXT_RESET + 1) }).decision.kind).toBe('granted')
  })

  it('shares the Indexing API day cap across every Site of the project', () => {
    const state = reserveQuota(emptyLedgerState(), { api: 'indexing', site: SITE, n: 200, now: NOW }).state
    expect(reserveQuota(state, { api: 'indexing', site: 'https://other.com/', n: 1, now: NOW }).decision.kind).toBe('exhausted')
  })
})

describe('parseQuotaRefusal', () => {
  it.each([
    [googleError(403, 'Search Analytics load quota exceeded.', 'quotaExceeded'), '403 Search Analytics load quota exceeded.'],
    [googleError(429, 'Search Analytics QPS quota exceeded.', 'rateLimitExceeded'), '429 Search Analytics QPS quota exceeded.'],
    [googleError(403, 'User does not have sufficient permission for site.', 'forbidden'), undefined],
  ])('reads Google\'s reason from %#', (error, expected) => {
    expect(parseQuotaRefusal(error)).toBe(expected)
  })

  it('keeps Google\'s message for a failed-state error', () => {
    expect(googleErrorMessage(googleError(403, 'User does not have sufficient permission for site.', 'forbidden')))
      .toBe('403 User does not have sufficient permission for site.')
  })
})

describe('openQuotaLedger', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-ledger-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('adds up usage from two commands that share the data dir', async () => {
    const now = (): Date => NOW
    const sync = await openQuotaLedger({ dataDir: dir, now })
    const inspect = await openQuotaLedger({ dataDir: dir, now })

    sync.reserve('urlInspection', SITE, 1500)
    inspect.reserve('urlInspection', SITE, 400)
    await sync.flush()
    await inspect.flush()

    const next = await openQuotaLedger({ dataDir: dir, now })
    expect(next.status('urlInspection', SITE).used).toBe(1900)
    expect(next.reserve('urlInspection', SITE, 500)).toEqual({ kind: 'partial', n: 100, resetsAt: NEXT_RESET })
  })

  it('gives unused calls back and keeps a refusal across runs', async () => {
    const now = (): Date => NOW
    const first = await openQuotaLedger({ dataDir: dir, now })
    first.reserve('urlInspection', SITE, 50)
    first.record('urlInspection', SITE, { kind: 'unused', n: 20 })
    first.record('searchAnalytics', SITE, { kind: 'refused', reason: 'Search Analytics load quota exceeded.' })
    await first.flush()

    const second = await openQuotaLedger({ dataDir: dir, now })
    expect(second.status('urlInspection', SITE).used).toBe(30)
    expect(second.reserve('searchAnalytics', SITE, 1).kind).toBe('exhausted')
  })
})
