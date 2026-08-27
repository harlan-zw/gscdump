import type { SiteDailyTimeseriesQuery } from '@gscdump/contracts/archetypes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createR2SqlClient,
  inlineParams,
  R2SqlError,
  R2SqlTimeoutError,
} from '../src/server-tail/r2-sql-client'

const range = { start: '2026-01-01', end: '2026-03-31' }

/** A fake fetch returning a recorded CF R2 SQL envelope. */
function fakeFetch(envelope: unknown, init?: { ok?: boolean, status?: number }) {
  return vi.fn(async (_url: string, opts?: RequestInit) => {
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => envelope,
      text: async () => JSON.stringify(envelope),
      _opts: opts,
    } as unknown as Response
  })
}

describe('inlineParams', () => {
  it('substitutes ? placeholders in order', () => {
    expect(inlineParams('a = ? AND b = ?', ['a\'b', 7])).toBe('a = \'a\'\'b\' AND b = 7')
  })

  it('does not treat a ? inside a string literal as a placeholder', () => {
    expect(inlineParams('x = \'why?\' AND y = ?', [1])).toBe('x = \'why?\' AND y = 1')
  })

  it('throws on placeholder/param count mismatch', () => {
    expect(() => inlineParams('a = ?', [])).toThrow(R2SqlError)
    expect(() => inlineParams('a = ?', [1, 2])).toThrow(R2SqlError)
  })
})

describe('createR2SqlClient', () => {
  const config = {
    accountId: 'acct',
    bucket: 'wh',
    namespace: 'gsc',
    token: 'tok',
  }

  it('runArchetype POSTs inlined int-catalog SQL with the resolved table reference by default', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [{ date: '2026-01-01', clicks: 10 }] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const q: SiteDailyTimeseriesQuery = {
      siteId: '42',
      searchType: 'web',
      range,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    }
    const res = await client.runArchetype(q)
    expect(res.rows).toEqual([{ date: '2026-01-01', clicks: 10 }])

    const [url, opts] = fetchImpl.mock.calls[0]!
    // the correct R2 SQL endpoint (bucket-addressed), NOT the catalog mgmt API
    expect(url).toBe('https://api.sql.cloudflarestorage.com/api/v1/accounts/acct/r2-sql/query/wh')
    const sentSql = JSON.parse(opts!.body as string).query as string
    // {{TABLE}} resolved to namespace.table
    expect(sentSql).toContain('FROM gsc.dates')
    // params inlined — no ? left
    expect(sentSql).not.toContain('?')
    expect(sentSql).toContain('site_id = 42')
    expect(sentSql).toContain('search_type = 1')
    // int-catalog default: bare predicates, no string materialization workaround
    expect(sentSql).not.toContain('CONCAT(site_id')
    expect(sentSql).not.toContain('CONCAT(search_type')
    // bearer auth header present
    expect((opts!.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('runArchetype uses CONCAT predicates for explicit legacy string catalogs', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl, partitionKeyEncoding: 'string' })
    const q: SiteDailyTimeseriesQuery = {
      siteId: 'site-1',
      searchType: 'web',
      range,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    }
    await client.runArchetype(q)

    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    expect(sentSql).toContain('CONCAT(site_id, \'\') = \'site-1\'')
    expect(sentSql).toContain('CONCAT(search_type, \'\') = \'web\'')
  })

  it('runArchetype maps public site ids for int catalogs when a mapper is provided', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [] },
    })
    const client = createR2SqlClient({
      ...config,
      fetchImpl,
      partitionSiteId: siteId => (siteId === 'site-1' ? 42 : siteId),
    })
    const q: SiteDailyTimeseriesQuery = {
      siteId: 'site-1',
      searchType: 'discover',
      range,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    }
    await client.runArchetype(q)

    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    expect(sentSql).toContain('site_id = 42')
    expect(sentSql).toContain('search_type = 5')
  })

  it('runArchetype fails fast for int catalogs without a numeric site id', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const q: SiteDailyTimeseriesQuery = {
      siteId: 'site-1',
      searchType: 'web',
      range,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    }
    expect(() => client.runArchetype(q)).toThrow(/numeric site_id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runPlan rewrites bare partition equality for explicit legacy string catalogs', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl, partitionKeyEncoding: 'string' })
    await client.runPlan({
      table: 'dates',
      sql: `SELECT date FROM {{TABLE}} WHERE site_id = ? AND search_type = ? AND date BETWEEN ? AND ?`,
      params: ['site-1', 'web', range.start, range.end],
    })

    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    expect(sentSql).toContain('CONCAT(site_id, \'\') = \'site-1\'')
    expect(sentSql).toContain('CONCAT(search_type, \'\') = \'web\'')
  })

  it('runPlan keeps bare partition equality by default for int catalogs', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    await client.runPlan({
      table: 'dates',
      sql: `SELECT date FROM {{TABLE}} WHERE site_id = ? AND search_type = ? AND date BETWEEN ? AND ?`,
      params: [42, 1, range.start, range.end],
    })

    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    expect(sentSql).toContain('site_id = 42')
    expect(sentSql).toContain('search_type = 1')
    expect(sentSql).not.toContain('CONCAT(site_id')
    expect(sentSql).not.toContain('CONCAT(search_type')
  })

  it('normalizes the columns+data envelope shape', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { columns: ['date', 'clicks'], data: [['2026-01-01', 5], ['2026-01-02', 8]] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const res = await client.query('SELECT 1')
    expect(res.rows).toEqual([
      { date: '2026-01-01', clicks: 5 },
      { date: '2026-01-02', clicks: 8 },
    ])
  })

  it('throws R2SqlError when the envelope reports failure', async () => {
    const fetchImpl = fakeFetch({ success: false, errors: [{ message: 'bad table' }] })
    const client = createR2SqlClient({ ...config, fetchImpl })
    await expect(client.query('SELECT 1')).rejects.toThrow(/bad table/)
  })

  it('throws R2SqlError on an HTTP error status', async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 403 })
    const client = createR2SqlClient({ ...config, fetchImpl })
    await expect(client.query('SELECT 1')).rejects.toThrow(/HTTP 403/)
  })
})

describe('createR2SqlClient timeout', () => {
  const config = {
    accountId: 'acct',
    bucket: 'wh',
    namespace: 'gsc',
    token: 'tok',
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A fetch that never resolves until its AbortSignal fires, then rejects. */
  function hangingFetch() {
    return vi.fn((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            // mirror the platform: aborting fetch rejects with the abort reason
            // (an Error whose name is 'AbortError') or the supplied reason.
            const reason = (signal as AbortSignal & { reason?: unknown }).reason
            reject(reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }
      })
    })
  }

  it('aborts the request and throws R2SqlTimeoutError after the deadline', async () => {
    const fetchImpl = hangingFetch()
    const client = createR2SqlClient({ ...config, fetchImpl, timeoutMs: 25_000 })
    const p = client.query('SELECT 1')
    const assertion = expect(p).rejects.toBeInstanceOf(R2SqlTimeoutError)
    await vi.advanceTimersByTimeAsync(25_000)
    await assertion
    // the AbortController signal was passed through to fetch
    const [, opts] = fetchImpl.mock.calls[0]!
    expect((opts!.signal as AbortSignal).aborted).toBe(true)
  })

  it('maps a platform AbortError to R2SqlTimeoutError', async () => {
    // a fetch that rejects immediately with a generic AbortError (e.g. the
    // platform aborted for reasons other than our timer reason object).
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    })
    const client = createR2SqlClient({ ...config, fetchImpl, timeoutMs: 25_000 })
    await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(R2SqlTimeoutError)
  })

  it('wraps other fetch failures as R2SqlError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    await expect(client.query('SELECT 1')).rejects.toThrow(/ECONNREFUSED/)
    await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(R2SqlError)
  })
})

describe('createR2SqlClient queryResult', () => {
  const config = {
    accountId: 'acct',
    bucket: 'wh',
    namespace: 'gsc',
    token: 'tok',
  }

  it('returns ok with rows on success', async () => {
    const fetchImpl = fakeFetch({ success: true, result: { rows: [{ clicks: 5 }] } })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const res = await client.queryResult!('SELECT 1')
    expect(res.ok).toBe(true)
    if (res.ok)
      expect(res.value.rows).toEqual([{ clicks: 5 }])
  })

  it('returns err with an R2SqlError on a rejected envelope', async () => {
    const fetchImpl = fakeFetch({ success: false, errors: [{ message: 'bad table' }] })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const res = await client.queryResult!('SELECT 1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(R2SqlError)
      expect(res.error.message).toMatch(/bad table/)
    }
  })

  it('returns err with the HTTP status on an error response', async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 403 })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const res = await client.queryResult!('SELECT 1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(R2SqlError)
      expect((res.error as R2SqlError).status).toBe(403)
    }
  })

  it('returns err with an R2SqlTimeoutError on a deadline abort', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_url: string, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const reason = (opts.signal as AbortSignal & { reason?: unknown }).reason
            reject(reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }))
      const client = createR2SqlClient({ ...config, fetchImpl, timeoutMs: 25_000 })
      const p = client.queryResult!('SELECT 1')
      await vi.advanceTimersByTimeAsync(25_000)
      const res = await p
      expect(res.ok).toBe(false)
      if (!res.ok)
        expect(res.error).toBeInstanceOf(R2SqlTimeoutError)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
