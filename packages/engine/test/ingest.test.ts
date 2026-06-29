/**
 * gscdump/analytics/ingest — GSC API row → storage Row transform + the
 * bucketing accumulator. Covers all five tables' key-indexing, overflow
 * behaviour and drain semantics.
 */

import { describe, expect, it } from 'vitest'
import {
  assembleDatesRow,
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

  it('maps keywords without writing a canonical fact column', () => {
    const out = transformGscRow(
      'queries',
      { keys: ['Foo Bar', '2026-04-10'], clicks: 1, impressions: 2, position: 10 },
      { normalizeQuery: q => q.toLowerCase() },
    )
    expect(out?.row).toEqual({ query: 'Foo Bar', date: '2026-04-10', clicks: 1, impressions: 2, sum_position: 18 })
    expect(out?.row).not.toHaveProperty('query_canonical')
  })

  it('keywords without normalizeQuery omit query_canonical', () => {
    const out = transformGscRow('queries', { keys: ['foo', '2026-04-10'], clicks: 0, impressions: 0, position: 0 })
    expect(out?.row).not.toHaveProperty('query_canonical')
  })

  it('maps countries', () => {
    const out = transformGscRow('countries', { keys: ['usa', '2026-04-10'], clicks: 1, impressions: 10, position: 2 })
    expect(out?.row).toEqual({ country: 'usa', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 10 })
  })

  it('maps search_appearance', () => {
    const out = transformGscRow('search_appearance', { keys: ['AMP_TOP_STORIES'], clicks: 2, impressions: 20, position: 5 }, { date: '2026-04-10' })
    expect(out?.row).toEqual({
      searchAppearance: 'AMP_TOP_STORIES',
      date: '2026-04-10',
      clicks: 2,
      impressions: 20,
      sum_position: 80,
    })
  })

  it('maps contextual search_appearance page/query rows', () => {
    const out = transformGscRow(
      'search_appearance_page_queries',
      { keys: ['https://example.com/foo', 'Blue Widgets', '2026-04-10'], clicks: 2, impressions: 20, position: 5 },
      {
        searchAppearance: 'AMP_TOP_STORIES',
        normalizeQuery: q => q.toLowerCase(),
      },
    )
    expect(out?.row).toEqual({
      searchAppearance: 'AMP_TOP_STORIES',
      url: '/foo',
      query: 'Blue Widgets',
      date: '2026-04-10',
      clicks: 2,
      impressions: 20,
      sum_position: 80,
    })
  })

  it('rejects the bespoke `dates` table — must use assembleDatesRow', () => {
    expect(() => transformGscRow('dates', { keys: ['x', '2026-04-10'], clicks: 0, impressions: 0, position: 0 }))
      .toThrow(/assembleDatesRow/)
  })
})

describe('assembleDatesRow', () => {
  it('pivots the device breakdown and derives anonymized_impressions_pct', () => {
    const { date, row } = assembleDatesRow(
      '2026-04-10',
      { keys: ['2026-04-10'], clicks: 30, impressions: 300, position: 3 },
      [
        { keys: ['2026-04-10', 'DESKTOP'], clicks: 20, impressions: 200, position: 2 },
        { keys: ['2026-04-10', 'MOBILE'], clicks: 10, impressions: 100, position: 5 },
      ],
      240, // query-grained impressions → 1 - 240/300 = 0.2 anonymized
    )
    expect(date).toBe('2026-04-10')
    expect(row.anonymized_impressions_pct as number).toBeCloseTo(0.2, 6)
    expect(row).toMatchObject({
      date: '2026-04-10',
      clicks: 30,
      impressions: 300,
      sum_position: (3 - 1) * 300,
      clicks_desktop: 20,
      clicks_mobile: 10,
      clicks_tablet: 0,
      impressions_desktop: 200,
      impressions_mobile: 100,
      impressions_tablet: 0,
      sum_position_desktop: (2 - 1) * 200,
      sum_position_mobile: (5 - 1) * 100,
      sum_position_tablet: 0,
    })
  })

  it('clamps anonymized_impressions_pct into [0, 1]', () => {
    const over = assembleDatesRow('2026-04-10', { keys: ['2026-04-10'], clicks: 0, impressions: 100, position: 0 }, [], 150)
    expect(over.row.anonymized_impressions_pct).toBe(0)
    const zeroImpr = assembleDatesRow('2026-04-10', { keys: ['2026-04-10'], clicks: 0, impressions: 0, position: 0 }, [], 0)
    expect(zeroImpr.row.anonymized_impressions_pct).toBe(0)
  })

  it('maps hourly_pages (keys=[hour, page]), deriving date + INT hour-of-day from the hour prefix', () => {
    const out = transformGscRow('hourly_pages', {
      keys: ['2026-05-17T15:00:00-07:00', 'https://example.com/foo'],
      clicks: 4,
      impressions: 20,
      position: 5,
    })
    expect(out).toEqual({
      date: '2026-05-17',
      row: {
        url: '/foo',
        hour: 15,
        date: '2026-05-17',
        clicks: 4,
        impressions: 20,
        sum_position: 80,
      },
    })
  })

  it('maps page_keywords (keys=[page, query, date])', () => {
    const out = transformGscRow(
      'page_queries',
      { keys: ['https://example.com/foo', 'bar', '2026-04-10'], clicks: 2, impressions: 20, position: 4 },
      { normalizeQuery: q => q },
    )
    expect(out).toEqual({
      date: '2026-04-10',
      row: {
        url: '/foo',
        query: 'bar',
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
    acc.push('queries', [
      { keys: ['foo', '2026-04-10'], clicks: 5, impressions: 50, position: 4 },
    ])
    expect(acc.totalRows).toBe(4)

    const drained = acc.drain()
    expect(drained.get('pages')?.get('2026-04-10')).toHaveLength(2)
    expect(drained.get('pages')?.get('2026-04-11')).toHaveLength(1)
    expect(drained.get('queries')?.get('2026-04-10')).toHaveLength(1)
  })

  it('drain resets state', () => {
    const acc = createRowAccumulator()
    acc.push('countries', [{ keys: ['usa', '2026-04-10'], clicks: 0, impressions: 0, position: 0 }])
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

  it('drainCompleted is a no-op when trackDateBoundary is off', () => {
    const acc = createRowAccumulator()
    acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/b', '2026-04-11'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(acc.drainCompleted().size).toBe(0)
    expect(acc.totalRows).toBe(2)
  })

  it('drainCompleted returns older dates and keeps the latest', () => {
    const acc = createRowAccumulator({ trackDateBoundary: true })
    acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/b', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/c', '2026-04-11'], clicks: 0, impressions: 0, position: 0 },
    ])
    const completed = acc.drainCompleted()
    expect(completed.get('pages')?.get('2026-04-10')).toHaveLength(2)
    expect(completed.get('pages')?.has('2026-04-11')).toBe(false)
    expect(acc.totalRows).toBe(1)

    const remaining = acc.drain()
    expect(remaining.get('pages')?.get('2026-04-11')).toHaveLength(1)
  })

  it('drainCompleted advances the boundary across multiple pushes', () => {
    const acc = createRowAccumulator({ trackDateBoundary: true })
    acc.push('queries', [
      { keys: ['foo', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(acc.drainCompleted().size).toBe(0)

    acc.push('queries', [
      { keys: ['bar', '2026-04-11'], clicks: 0, impressions: 0, position: 0 },
    ])
    const first = acc.drainCompleted()
    expect(first.get('queries')?.get('2026-04-10')).toHaveLength(1)
    expect(acc.totalRows).toBe(1)

    acc.push('queries', [
      { keys: ['baz', '2026-04-12'], clicks: 0, impressions: 0, position: 0 },
    ])
    const second = acc.drainCompleted()
    expect(second.get('queries')?.get('2026-04-11')).toHaveLength(1)
    expect(acc.totalRows).toBe(1)
  })

  it('drainCompleted tracks boundary per-table', () => {
    const acc = createRowAccumulator({ trackDateBoundary: true })
    acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/b', '2026-04-12'], clicks: 0, impressions: 0, position: 0 },
    ])
    acc.push('queries', [
      { keys: ['foo', '2026-04-09'], clicks: 0, impressions: 0, position: 0 },
    ])
    const completed = acc.drainCompleted()
    expect(completed.get('pages')?.get('2026-04-10')).toHaveLength(1)
    expect(completed.has('queries')).toBe(false)
    expect(acc.totalRows).toBe(2)
  })

  it('drain() resets boundary state', () => {
    const acc = createRowAccumulator({ trackDateBoundary: true })
    acc.push('pages', [
      { keys: ['/a', '2026-04-10'], clicks: 0, impressions: 0, position: 0 },
      { keys: ['/b', '2026-04-11'], clicks: 0, impressions: 0, position: 0 },
    ])
    acc.drain()
    acc.push('pages', [
      { keys: ['/c', '2026-04-09'], clicks: 0, impressions: 0, position: 0 },
    ])
    expect(acc.drainCompleted().size).toBe(0)
  })
})
