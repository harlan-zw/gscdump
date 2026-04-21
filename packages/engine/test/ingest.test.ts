/**
 * gscdump/analytics/ingest — GSC API row → storage Row transform + the
 * bucketing accumulator. Covers all five tables' key-indexing, overflow
 * behaviour, drain semantics, and the normalizeQuery hook.
 */

import { describe, expect, it } from 'vitest'
import {
  createRowAccumulator,
  toPath,
  toSumPosition,
  transformGscRow,
} from '../src/ingest'

describe('transformGscRow', () => {
  it('maps pages (keys=[page, date])', () => {
    const out = transformGscRow('pages', {
      keys: ['https://example.com/foo', '2026-04-10'],
      clicks: 5,
      impressions: 100,
      position: 3.5,
    })
    expect(out).toEqual({
      date: '2026-04-10',
      row: { url: '/foo', date: '2026-04-10', clicks: 5, impressions: 100, sum_position: 250 },
    })
  })

  it('maps keywords + applies normalizeQuery hook', () => {
    const out = transformGscRow(
      'keywords',
      { keys: ['Foo Bar', '2026-04-10'], clicks: 1, impressions: 2, position: 10 },
      { normalizeQuery: q => q.toLowerCase() },
    )
    expect(out?.row).toMatchObject({ query: 'Foo Bar', query_canonical: 'foo bar', date: '2026-04-10' })
  })

  it('keywords without normalizeQuery sets query_canonical=null', () => {
    const out = transformGscRow('keywords', { keys: ['foo', '2026-04-10'], clicks: 0, impressions: 0, position: 0 })
    expect(out?.row.query_canonical).toBeNull()
  })

  it('maps countries', () => {
    const out = transformGscRow('countries', { keys: ['usa', '2026-04-10'], clicks: 1, impressions: 10, position: 2 })
    expect(out?.row).toEqual({ country: 'usa', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 10 })
  })

  it('maps devices', () => {
    const out = transformGscRow('devices', { keys: ['mobile', '2026-04-10'], clicks: 0, impressions: 3, position: 1 })
    expect(out?.row).toEqual({ device: 'mobile', date: '2026-04-10', clicks: 0, impressions: 3, sum_position: 0 })
  })

  it('maps page_keywords (keys=[page, query, date])', () => {
    const out = transformGscRow(
      'page_keywords',
      { keys: ['https://example.com/foo', 'bar', '2026-04-10'], clicks: 2, impressions: 20, position: 4 },
      { normalizeQuery: q => q },
    )
    expect(out).toEqual({
      date: '2026-04-10',
      row: {
        url: '/foo',
        query: 'bar',
        query_canonical: 'bar',
        date: '2026-04-10',
        clicks: 2,
        impressions: 20,
        sum_position: 60,
      },
    })
  })

  it('returns null for empty keys', () => {
    expect(transformGscRow('pages', { keys: [], clicks: 0, impressions: 0, position: 0 })).toBeNull()
  })

  it('preserves non-URL paths unchanged', () => {
    expect(toPath('/already-a-path')).toBe('/already-a-path')
  })

  it('toSumPosition guards impressions=0 to avoid losing sign', () => {
    expect(toSumPosition(5, 0)).toBe(4)
    expect(toSumPosition(1, 0)).toBe(0)
  })
})

describe('createRowAccumulator', () => {
  it('buckets rows by (table, date)', () => {
    const acc = createRowAccumulator()
    acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 1, impressions: 10, position: 1 },
      { keys: ['/b', '2026-04-10'], clicks: 2, impressions: 20, position: 2 },
      { keys: ['/c', '2026-04-11'], clicks: 3, impressions: 30, position: 3 },
    ])
    acc.push('keywords', [
      { keys: ['foo', '2026-04-10'], clicks: 5, impressions: 50, position: 4 },
    ])
    expect(acc.totalRows).toBe(4)

    const drained = acc.drain()
    expect(drained.get('pages')?.get('2026-04-10')).toHaveLength(2)
    expect(drained.get('pages')?.get('2026-04-11')).toHaveLength(1)
    expect(drained.get('keywords')?.get('2026-04-10')).toHaveLength(1)
  })

  it('drain resets state', () => {
    const acc = createRowAccumulator()
    acc.push('devices', [{ keys: ['mobile', '2026-04-10'], clicks: 0, impressions: 0, position: 0 }])
    acc.drain()
    expect(acc.totalRows).toBe(0)
    expect(acc.drain().size).toBe(0)
  })

  it('overflows once maxRows exceeded and drops subsequent pushes', () => {
    const acc = createRowAccumulator({ maxRows: 2 })
    const ok1 = acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/b', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(ok1).toBe(true)
    expect(acc.overflowed).toBe(false)

    const ok2 = acc.push('pages', [
      { keys: ['/c', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(ok2).toBe(false)
    expect(acc.overflowed).toBe(true)

    const ok3 = acc.push('pages', [
      { keys: ['/d', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(ok3).toBe(false)
  })

  it('skips rows with empty keys', () => {
    const acc = createRowAccumulator()
    acc.push('pages', [
      { keys: [], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(acc.totalRows).toBe(1)
  })

  it('skips rows with missing date', () => {
    const acc = createRowAccumulator()
    acc.push('pages', [
      { keys: ['/a'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(acc.totalRows).toBe(0)
  })
})
