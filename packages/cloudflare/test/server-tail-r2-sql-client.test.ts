import type { SiteDailyTimeseriesQuery } from '@gscdump/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  createR2SqlClient,
  escapeSqlValue,
  inlineParams,
  R2SqlError,
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

describe('escapeSqlValue', () => {
  it('escapes strings, passes numbers bare, maps null to NULL', () => {
    expect(escapeSqlValue('a\'b')).toBe('\'a\'\'b\'')
    expect(escapeSqlValue(42)).toBe('42')
    expect(escapeSqlValue(null)).toBe('NULL')
    expect(escapeSqlValue(undefined)).toBe('NULL')
  })

  it('rejects non-finite numbers', () => {
    expect(() => escapeSqlValue(Number.NaN)).toThrow(R2SqlError)
  })
})

describe('inlineParams', () => {
  it('substitutes ? placeholders in order', () => {
    expect(inlineParams('a = ? AND b = ?', ['x', 7])).toBe('a = \'x\' AND b = 7')
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
    warehouse: 'wh',
    namespace: 'gsc',
    token: 'tok',
  }

  it('runArchetype POSTs inlined SQL with the resolved table reference', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: { rows: [{ date: '2026-01-01', clicks: 10 }] },
    })
    const client = createR2SqlClient({ ...config, fetchImpl })
    const q: SiteDailyTimeseriesQuery = {
      siteId: 'site-1',
      searchType: 'web',
      range,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
    }
    const res = await client.runArchetype(q)
    expect(res.rows).toEqual([{ date: '2026-01-01', clicks: 10 }])

    const [, opts] = fetchImpl.mock.calls[0]!
    const sentSql = JSON.parse(opts!.body as string).query as string
    // {{TABLE}} resolved to namespace.table
    expect(sentSql).toContain('FROM gsc.dates')
    // params inlined — no ? left
    expect(sentSql).not.toContain('?')
    expect(sentSql).toContain('\'site-1\'')
    // bearer auth header present
    expect((opts!.headers as Record<string, string>).authorization).toBe('Bearer tok')
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
