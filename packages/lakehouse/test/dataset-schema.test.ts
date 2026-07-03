/**
 * Dataset-def derivation: schema / partition-spec / sort-order / dedupe key
 * all come FROM the def, not hand-listed. This is the byte-identity contract
 * nuxtseo's Phase-2 port leans on — a def-derived spec for `crawl.pages` must
 * match the frozen inline constants it replaces field-for-field.
 */

import { describe, expect, it } from 'vitest'
import { defineIcebergDataset, deriveTableSpec } from '../src/dataset'

// Mirrors nuxtseo's CRAWL_PAGES_SCHEMA / CRAWL_PARTITION_SPEC fixture
// (layers/pro/audit/server/utils/crawl-iceberg.ts) — identity(site_id) INT,
// then declared columns starting at date.
const CRAWL_PAGES_DEF = {
  namespace: 'crawl',
  table: 'pages',
  identity: { kind: 'site-int' as const, encoding: 'int' as const },
  naturalKey: ['url'],
  columns: [
    { name: 'date', type: 'DATE' as const, required: true },
    { name: 'url', type: 'STRING' as const, required: true },
    { name: 'audit_id', type: 'STRING' as const, required: true },
    { name: 'word_count', type: 'INT' as const, required: false },
  ],
  partition: [
    { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
    { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
  ],
}

describe('deriveTableSpec', () => {
  it('assigns field ids: identity columns first, then dims, then declared columns', () => {
    const spec = deriveTableSpec(CRAWL_PAGES_DEF)
    expect(spec.columns).toEqual([
      { name: 'site_id', type: 'INT', required: true, fieldId: 1 },
      { name: 'date', type: 'DATE', required: true, fieldId: 2 },
      { name: 'url', type: 'STRING', required: true, fieldId: 3 },
      { name: 'audit_id', type: 'STRING', required: true, fieldId: 4 },
      { name: 'word_count', type: 'INT', required: false, fieldId: 5 },
    ])
  })

  it('derives identityColumns as identity + dims + naturalKey', () => {
    const spec = deriveTableSpec(CRAWL_PAGES_DEF)
    expect(spec.identityColumns).toEqual(['site_id', 'url'])
  })

  it('carries the partition spec through untouched', () => {
    const spec = deriveTableSpec(CRAWL_PAGES_DEF)
    expect(spec.partitionSpec).toEqual(CRAWL_PAGES_DEF.partition)
  })

  it('interleaves dims columns between identity and declared columns', () => {
    const def = {
      namespace: 'gsc',
      table: 'pages',
      identity: { kind: 'site-int' as const, encoding: 'int' as const },
      dims: { searchType: { toPartitionValue: (v: string) => (v === 'web' ? 1 : 2), boundEncoding: 'int32' as const } },
      naturalKey: ['url', 'date'],
      columns: [
        { name: 'date', type: 'DATE' as const, required: true },
        { name: 'url', type: 'STRING' as const, required: true },
      ],
      partition: [
        { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
        { sourceColumn: 'searchType', transform: 'identity' as const, name: 'search_type' },
        { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
      ],
    }
    const spec = deriveTableSpec(def)
    expect(spec.columns.map(c => c.name)).toEqual(['site_id', 'searchType', 'date', 'url'])
    expect(spec.columns.map(c => c.fieldId)).toEqual([1, 2, 3, 4])
    expect(spec.identityColumns).toEqual(['site_id', 'searchType', 'url', 'date'])
  })
})

describe('defineIcebergDataset icebird shape derivation', () => {
  it('derives an icebird Schema matching the field-id-derived columns', () => {
    const ds = defineIcebergDataset(CRAWL_PAGES_DEF)
    expect(ds.icebergSchema()).toEqual({
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        { id: 1, name: 'site_id', required: true, type: 'int' },
        { id: 2, name: 'date', required: true, type: 'date' },
        { id: 3, name: 'url', required: true, type: 'string' },
        { id: 4, name: 'audit_id', required: true, type: 'string' },
        { id: 5, name: 'word_count', required: false, type: 'int' },
      ],
    })
  })

  it('derives an icebird PartitionSpec resolving source-ids by column name', () => {
    const ds = defineIcebergDataset(CRAWL_PAGES_DEF)
    expect(ds.icebergPartitionSpec()).toEqual({
      'spec-id': 0,
      'fields': [
        { 'source-id': 1, 'field-id': 1000, 'name': 'site_id', 'transform': 'identity' },
        { 'source-id': 2, 'field-id': 1001, 'name': 'date_month', 'transform': 'month' },
      ],
    })
  })

  it('has no sort order when the def declares no clusterKey (matches the original byte-for-byte create payload)', () => {
    const ds = defineIcebergDataset(CRAWL_PAGES_DEF)
    expect(ds.icebergSortOrder()).toBeUndefined()
  })

  it('derives a sort order from clusterKey when declared', () => {
    const ds = defineIcebergDataset({ ...CRAWL_PAGES_DEF, clusterKey: ['url', 'date'] })
    expect(ds.icebergSortOrder()).toEqual({
      'order-id': 1,
      'fields': [
        { 'source-id': 3, 'transform': 'identity', 'direction': 'asc', 'null-order': 'nulls-last' },
        { 'source-id': 2, 'transform': 'identity', 'direction': 'asc', 'null-order': 'nulls-last' },
      ],
    })
  })
})
