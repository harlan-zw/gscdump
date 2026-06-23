import { describe, expect, it } from 'vitest'
import {
  icebergSchemaFor,
  icebergSortOrderFor,
} from '../src/iceberg/catalog'
import { ICEBERG_TABLES } from '../src/iceberg/schema'
import { TABLE_METADATA } from '../src/schema'

describe('icebergSortOrderFor', () => {
  it('sorts by clusterKey columns (dimension-first), all identity/asc', () => {
    for (const table of ICEBERG_TABLES) {
      const order = icebergSortOrderFor(table)
      const schema = icebergSchemaFor(table)
      const idToName = new Map(schema.fields.map(f => [f.id, f.name]))
      const orderedNames = order.fields.map(f => idToName.get(f['source-id']))
      // The declared sort order must match the physical clusterKey order the
      // append path / compaction clusters by.
      expect(orderedNames).toEqual([...TABLE_METADATA[table].clusterKey])
      expect(order['order-id']).toBe(1)
      for (const f of order.fields) {
        expect(f.transform).toBe('identity')
        expect(f.direction).toBe('asc')
      }
    }
  })

  it('resolves source-ids to real schema field ids, skipping non-cluster columns', () => {
    // page_queries clusters by url, query, date — skipping query_canonical, so
    // the source-ids are NOT contiguous.
    const order = icebergSortOrderFor('page_queries')
    const schema = icebergSchemaFor('page_queries')
    const fieldId = (name: string): number => schema.fields.find(f => f.name === name)!.id
    expect(order.fields.map(f => f['source-id'])).toEqual([
      fieldId('url'),
      fieldId('query'),
      fieldId('date'),
    ])
  })
})
