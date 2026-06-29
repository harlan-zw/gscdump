/**
 * Pushdown extraction + parity. The extractor must only emit a parquet filter
 * that, applied at decode, yields EXACTLY the rows the query's `query`-equality
 * predicate keeps (the decoder materialises only matches, so a wrong filter
 * silently drops real rows). The parity test is the safety gate: pushed-decode
 * must equal decode-all-then-filter for every translated shape.
 */

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import {
  and,
  between,
  contains,
  country,
  date,
  eq,
  inArray,
  or,
  page,
  query,
  queryCanonical,
  searchAppearance,
} from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows, encodeRowsToParquet } from '../src/adapters/hyparquet'
import { extractParquetPushdown } from '../src/parquet-pushdown'

function state(filter: BuilderState['filter']): BuilderState {
  return { dimensions: ['query'], filter }
}

describe('extractParquetPushdown', () => {
  it('translates query equality to a $eq filter', () => {
    expect(extractParquetPushdown(state(eq(query, 'foo')), 'queries'))
      .toEqual({ query: { $eq: 'foo' } })
  })

  it('translates inArray(query) to an $or of equalities', () => {
    expect(extractParquetPushdown(state(inArray(query, ['a', 'b'])), 'queries'))
      .toEqual({ $or: [{ query: { $eq: 'a' } }, { query: { $eq: 'b' } }] })
  })

  it('translates country equality on the countries table', () => {
    expect(extractParquetPushdown(state(eq(country, 'usa')), 'countries'))
      .toEqual({ country: { $eq: 'usa' } })
  })

  it('translates search appearance equality on contextual tables', () => {
    expect(extractParquetPushdown(state(eq(searchAppearance, 'AMP_TOP_STORIES')), 'search_appearance_page_queries'))
      .toEqual({ searchAppearance: { $eq: 'AMP_TOP_STORIES' } })
  })

  it('keeps the query conjunct and drops a coexisting date range', () => {
    const filter = and(eq(query, 'foo'), between(date, '2025-01-01', '2025-01-31'))
    expect(extractParquetPushdown(state(filter), 'queries'))
      .toEqual({ query: { $eq: 'foo' } })
  })

  it('combines multiple verbatim string dimensions under AND', () => {
    const filter = and(eq(searchAppearance, 'FAQ'), eq(query, 'foo'))
    expect(extractParquetPushdown(state(filter), 'search_appearance_queries'))
      .toEqual({ $and: [{ searchAppearance: { $eq: 'FAQ' } }, { query: { $eq: 'foo' } }] })
  })

  it('refuses a top-level OR with a non-pushable branch (would narrow)', () => {
    const filter = or(eq(query, 'foo'), eq(page, '/x'))
    expect(extractParquetPushdown(state(filter), 'queries')).toBeUndefined()
  })

  it('keeps a top-level OR when every branch is exactly pushable', () => {
    const filter = or(eq(country, 'usa'), eq(country, 'gbr'))
    expect(extractParquetPushdown(state(filter), 'countries'))
      .toEqual({ $or: [{ country: { $eq: 'usa' } }, { country: { $eq: 'gbr' } }] })
  })

  it('does not push page equality (url normalization mismatch risk)', () => {
    expect(extractParquetPushdown(state(eq(page, '/x')), 'pages')).toBeUndefined()
  })

  it('does not push canonical query equality (fallback mismatch risk)', () => {
    expect(extractParquetPushdown(state(eq(queryCanonical, 'foo')), 'queries')).toBeUndefined()
  })

  it('does not push non-equality operators', () => {
    expect(extractParquetPushdown(state(contains(query, 'foo')), 'queries')).toBeUndefined()
  })

  it('does not push when the table has no query column', () => {
    expect(extractParquetPushdown(state(eq(query, 'foo')), 'pages')).toBeUndefined()
  })

  it('returns undefined for no filter', () => {
    expect(extractParquetPushdown(state(undefined), 'queries')).toBeUndefined()
  })
})

describe('pushdown decode parity (queries table)', () => {
  const rows: Row[] = [
    { query: 'foo', query_canonical: 'foo', date: '2025-01-01', clicks: 5, impressions: 50, sum_position: 21.5 },
    { query: 'bar', query_canonical: 'bar', date: '2025-01-01', clicks: 1, impressions: 2, sum_position: 4 },
    { query: 'foo', query_canonical: 'foo', date: '2025-01-02', clicks: 9, impressions: 90, sum_position: 30 },
    { query: 'baz', query_canonical: null, date: '2025-01-03', clicks: 3, impressions: 8, sum_position: 12 },
  ]
  const bytes = encodeRowsToParquet('queries', rows)

  async function decodeAll(): Promise<Row[]> {
    return decodeParquetToRows(bytes)
  }

  it('eq(query): pushed decode equals decode-all filtered in JS', async () => {
    const filter = extractParquetPushdown(state(eq(query, 'foo')), 'queries')!
    const pushed = await decodeParquetToRows(bytes, { filter })
    const expected = (await decodeAll()).filter(r => r.query === 'foo')
    expect(pushed).toEqual(expected)
    expect(pushed).toHaveLength(2)
  })

  it('inArray(query): pushed decode equals decode-all filtered in JS', async () => {
    const filter = extractParquetPushdown(state(inArray(query, ['foo', 'baz'])), 'queries')!
    const pushed = await decodeParquetToRows(bytes, { filter })
    const expected = (await decodeAll()).filter(r => r.query === 'foo' || r.query === 'baz')
    expect(pushed).toEqual(expected)
    expect(pushed).toHaveLength(3)
  })

  it('a no-match value returns zero rows', async () => {
    const filter = extractParquetPushdown(state(eq(query, 'absent')), 'queries')!
    expect(await decodeParquetToRows(bytes, { filter })).toHaveLength(0)
  })
})
