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
import { parquetMetadata } from 'hyparquet'
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
    { query: 'foo', date: '2025-01-01', clicks: 5, impressions: 50, sum_position: 21.5 },
    { query: 'bar', date: '2025-01-01', clicks: 1, impressions: 2, sum_position: 4 },
    { query: 'foo', date: '2025-01-02', clicks: 9, impressions: 90, sum_position: 30 },
    { query: 'baz', date: '2025-01-03', clicks: 3, impressions: 8, sum_position: 12 },
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

/**
 * `decodeParquetToRows` passes `usePageIndex` to hyparquet whenever a filter is
 * present, so hyparquet may skip individual pages whose ColumnIndex bounds
 * cannot match. A wrong page skip drops real rows silently, the same failure
 * the parity block above guards for row groups, one granularity down.
 *
 * The fixture is a full row group of realistic `query` values, which is what
 * makes the `query` chunk exceed the writer's 1MB default page size and split
 * into pages. A single-page chunk carries no OffsetIndex and would leave the
 * pruning path unexercised, so the first test asserts the split really happened
 * — without it the rest of this suite would pass vacuously.
 */
describe('page-index pruning parity (multi-page file)', () => {
  // One full row group's worth (the encoder's internal `ROW_GROUP_SIZE`), so
  // the fixture matches the shape a real sync writes. Values are long and
  // mostly distinct because that is what a real `query` column looks like, and
  // it is what pushes the chunk past the writer's 1MB page split — a low
  // cardinality column dictionary-encodes small enough to stay one page.
  const GROUP_ROWS = 25000
  const valueAt = (n: number): string => `search query variant ${String(n).padStart(5, '0')} with trailing padding text`
  // Every 5th row repeats a hot value, so `$eq` has a multi-row answer to check
  // rather than a single row that any pruning bug would be lucky to preserve.
  const HOT = valueAt(7)
  const rows: Row[] = Array.from({ length: GROUP_ROWS }, (_, i) => ({
    query: i % 5 === 0 ? HOT : valueAt(i),
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    clicks: i % 97,
    impressions: (i % 97) * 11,
    sum_position: (i % 97) / 3,
  }))
  const bytes = encodeRowsToParquet('queries', rows)

  it('the query chunk really did split into pages', () => {
    expect(hasPageIndex(bytes, 'query')).toBe(true)
  })

  it.each([
    ['hot value repeated across pages', HOT],
    ['first value', valueAt(1)],
    ['middle value', valueAt(Math.floor(GROUP_ROWS / 2) + 1)],
    ['last value', valueAt(GROUP_ROWS - 1)],
  ])('eq on the %s returns exactly the unfiltered matches', async (_label, wanted) => {
    const filter = extractParquetPushdown(state(eq(query, wanted)), 'queries')!
    const pushed = await decodeParquetToRows(bytes, { filter })
    const expected = (await decodeParquetToRows(bytes)).filter(r => r.query === wanted)
    expect(pushed).toEqual(expected)
    expect(pushed.length).toBeGreaterThan(0)
  })

  it('inArray spanning distant pages returns exactly the unfiltered matches', async () => {
    const wanted = [valueAt(1), valueAt(Math.floor(GROUP_ROWS / 2) + 1), valueAt(GROUP_ROWS - 1)]
    const filter = extractParquetPushdown(state(inArray(query, wanted)), 'queries')!
    const pushed = await decodeParquetToRows(bytes, { filter })
    const expected = (await decodeParquetToRows(bytes)).filter(r => wanted.includes(r.query as string))
    expect(pushed).toEqual(expected)
  })

  it('a value absent from every page returns zero rows', async () => {
    const filter = extractParquetPushdown(state(eq(query, 'no such query anywhere in this file')), 'queries')!
    expect(await decodeParquetToRows(bytes, { filter })).toHaveLength(0)
  })

  it('a filter combined with a column projection keeps every matching row', async () => {
    const filter = extractParquetPushdown(state(eq(query, HOT)), 'queries')!
    const pushed = await decodeParquetToRows(bytes, { filter, columns: ['query', 'clicks'] })
    const expected = (await decodeParquetToRows(bytes)).filter(r => r.query === HOT)
    expect(pushed).toHaveLength(expected.length)
    expect(pushed.every(r => r.query === HOT)).toBe(true)
  })
})

/**
 * True when `column`'s chunk carries both a ColumnIndex and an OffsetIndex, the
 * pair hyparquet requires before it will prune pages. hyparquet-writer emits an
 * OffsetIndex only for a chunk with more than one page, so this doubles as the
 * multi-page check.
 */
function hasPageIndex(bytes: Uint8Array, column: string): boolean {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return parquetMetadata(ab).row_groups.some(rg => rg.columns.some(c =>
    c.meta_data?.path_in_schema.join('.') === column
    && Boolean(c.column_index_offset)
    && Boolean(c.offset_index_offset),
  ))
}
