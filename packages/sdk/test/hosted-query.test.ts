import { describe, expect, it } from 'vitest'
import {
  dataQuery,
  sourceInfoQuery,
  tablesQuery,
  withDefaultSearchType,
} from '../src/hosted-query'

describe('hosted query serialization', () => {
  it('uses one canonical date/search-type shape', () => {
    expect(sourceInfoQuery({ startDate: '2026-06-01', endDate: '2026-06-30' })).toEqual({
      searchType: 'web',
      start: '2026-06-01',
      end: '2026-06-30',
    })
  })

  it('canonicalizes tables and clamps browser budgets', () => {
    expect(tablesQuery(['queries', 'pages', 'queries'], {
      searchType: 'image',
      maxBytes: 100.9,
      maxRows: 0,
      maxFiles: -5,
    })).toEqual({
      searchType: 'image',
      tables: 'pages,queries',
      maxBytes: '100',
      maxRows: '1',
      maxFiles: '1',
    })
  })

  it('defaults an object without mutating it', () => {
    const input = { dimensions: ['query'] }
    const result = withDefaultSearchType(input)
    expect(result).toEqual({ dimensions: ['query'], searchType: 'web' })
    expect(input).toEqual({ dimensions: ['query'] })
  })

  it('serializes nested data as canonical JSON', () => {
    const query = dataQuery({
      z: 1,
      nested: {
        omitted: undefined,
        values: [1, undefined, { b: 2, a: 1 }],
      },
    } as any)

    expect(query.q).toBe('{"nested":{"values":[1,null,{"a":1,"b":2}]},"searchType":"web","z":1}')
  })
})
