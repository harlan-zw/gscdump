import { describe, expect, it } from 'vitest'
import { mergeExtras } from '../src/resolver/compile'

describe('mergeExtras', () => {
  it('enriches canonical rows through one composite lookup', () => {
    const rows = [
      { queryCanonical: 'foo', clicks: 5 },
      { query_canonical: 'missing', clicks: 2 },
    ]
    const extras = [{
      key: 'canonicalExtras',
      results: [{
        joinKey: 'foo',
        variantCount: 2,
        canonicalName: 'Foo',
        variants: 'Foo:::5:::50:::2.0||||foos:::2:::20:::3.5',
      }],
    }]

    expect(mergeExtras(rows, extras)).toEqual([
      {
        queryCanonical: 'Foo',
        clicks: 5,
        variantCount: 2,
        canonicalName: 'Foo',
        variants: [
          { query: 'Foo', clicks: 5, impressions: 50, position: 2 },
          { query: 'foos', clicks: 2, impressions: 20, position: 3.5 },
        ],
      },
      {
        query_canonical: 'missing',
        clicks: 2,
        variantCount: null,
        canonicalName: null,
        variants: [],
      },
    ])
  })
})
