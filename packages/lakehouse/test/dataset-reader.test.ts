/**
 * Reader-side helpers derived from the def: `readerPredicate` /
 * `partitionBoundFilter` — covering int vs string identity encoding
 * (ADR-0021 amendment 4/5) and dims value derivation.
 */

import { describe, expect, it } from 'vitest'
import { defineIcebergDataset } from '../src/dataset'

const INT_DEF = {
  namespace: 'crawl',
  table: 'pages',
  identity: { kind: 'site-int' as const, encoding: 'int' as const },
  naturalKey: ['url'],
  columns: [{ name: 'date', type: 'DATE' as const, required: true }, { name: 'url', type: 'STRING' as const, required: true }],
  partition: [
    { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
    { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
  ],
}

const STRING_DEF = { ...INT_DEF, identity: { kind: 'site-int' as const, encoding: 'string' as const } }

const GSC_DEF = {
  namespace: 'gsc',
  table: 'pages',
  identity: { kind: 'site-int' as const, encoding: 'int' as const },
  dims: { searchType: { toPartitionValue: (v: string) => ({ web: 1, discover: 5 } as Record<string, number>)[v], boundEncoding: 'int32' as const } },
  naturalKey: ['url'],
  columns: [{ name: 'date', type: 'DATE' as const, required: true }, { name: 'url', type: 'STRING' as const, required: true }],
  partition: [
    { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
    { sourceColumn: 'searchType', transform: 'identity' as const, name: 'search_type' },
    { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
  ],
}

describe('icebergDataset.readerPredicate', () => {
  it('produces an int32 match for an int-encoded identity', () => {
    const ds = defineIcebergDataset(INT_DEF)
    expect(ds.readerPredicate(42)).toEqual([{ field: 'site_id', value: 42, encoding: 'int32' }])
  })

  it('produces a string match for a string-encoded identity', () => {
    const ds = defineIcebergDataset(STRING_DEF)
    expect(ds.readerPredicate('site-abc')).toEqual([{ field: 'site_id', value: 'site-abc', encoding: 'string' }])
  })

  it('coerces a string numeric identity to a number under int encoding', () => {
    const ds = defineIcebergDataset(INT_DEF)
    expect(ds.readerPredicate('42')).toEqual([{ field: 'site_id', value: 42, encoding: 'int32' }])
  })

  it('appends dims matches, applying toPartitionValue and the declared boundEncoding', () => {
    const ds = defineIcebergDataset(GSC_DEF)
    expect(ds.readerPredicate(7, { searchType: 'discover' })).toEqual([
      { field: 'site_id', value: 7, encoding: 'int32' },
      { field: 'searchType', value: 5, encoding: 'int32' },
    ])
  })

  it('omits a dims match when the caller does not supply it', () => {
    const ds = defineIcebergDataset(GSC_DEF)
    expect(ds.readerPredicate(7)).toEqual([{ field: 'site_id', value: 7, encoding: 'int32' }])
  })
})

describe('icebergDataset.partitionBoundFilter', () => {
  function strBound(s: string): Uint8Array {
    return new TextEncoder().encode(s)
  }

  it('prunes on a string-encoded identity bound', () => {
    const ds = defineIcebergDataset(STRING_DEF)
    const filter = ds.partitionBoundFilter('site-z', new Set([676]))
    const partitions = [
      { contains_null: false, lower_bound: strBound('site-a'), upper_bound: strBound('site-m') },
      { contains_null: false },
    ]
    expect(filter(partitions)).toBe(false)
  })

  it('does not prune on an int32-encoded identity bound (single-tenant, no savings)', () => {
    const ds = defineIcebergDataset(INT_DEF)
    const filter = ds.partitionBoundFilter(999, new Set([676]))
    const partitions = [
      { contains_null: false, lower_bound: strBound('anything'), upper_bound: strBound('anything') },
      { contains_null: false },
    ]
    expect(filter(partitions)).toBe(true)
  })
})
