/**
 * Regression tests for the `clusterAndDedupe` dedupe-key invariant
 * (PR #134 review finding "dedupe-key-conflates-cluster").
 *
 * `clusterAndDedupe` collapses adjacent records equal on
 * `clusterKey + (identityColumns - clusterKey)`. That equals a collapse on
 * `identityColumns` alone ONLY while every clusterKey column is also an
 * identity column. The sink must enforce that subset invariant: a table whose
 * spec violates it fails its own flush loudly instead of silently committing
 * a weakened dedupe (the 2026-04 double-count corruption class).
 *
 * No network: `../iceberg-catalog` is mocked like `iceberg-append-sink.test.ts`,
 * and `../iceberg/schema`'s `gscDataset` is wrapped so ONE table's
 * `tableSpec.clusterKey` gains a non-identity column — exactly the future
 * metadata drift the invariant exists to catch.
 */

import type { IcebergTableName, PartitionKeyEncoding } from '../src/iceberg/schema'
import type { SinkSlice } from '../src/sink'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendCalls: { table: string, records: Record<string, unknown>[] }[] = []
const connectIcebergCatalog = vi.fn()
const icebergAppendRetrying = vi.fn(async (args: { table: string, records: Record<string, unknown>[] }) => {
  appendCalls.push({ table: args.table, records: args.records })
})

vi.mock('../src/iceberg/catalog', () => ({
  connectIcebergCatalog,
  icebergAppendRetrying,
}))

// When set, `pages`' tableSpec.clusterKey gains 'clicks' — a metric column
// that is NOT part of identityColumns, violating the dedupe-key invariant.
let corruptClusterKey = false
vi.mock('../src/iceberg/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/iceberg/schema')>()
  return {
    ...actual,
    gscDataset: (table: IcebergTableName, encoding?: PartitionKeyEncoding) => {
      const dataset = actual.gscDataset(table, encoding)
      if (!corruptClusterKey || table !== 'pages')
        return dataset
      return {
        ...dataset,
        tableSpec: { ...dataset.tableSpec, clusterKey: [...dataset.tableSpec.clusterKey ?? [], 'clicks'] },
      }
    },
  }
})

const { createIcebergAppendSink } = await import('../src/iceberg/append-sink')

const CATALOG = {
  catalogUri: 'https://catalog.example/acct/wh',
  warehouse: 'acct_gscdump-analytics',
  namespace: 'gsc',
  catalogToken: 'tok',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'k', secretAccessKey: 's' },
}

const FAKE_CONN = { catalog: { type: 'rest' }, resolver: { signed: true }, namespace: 'gsc' }

function slice(table: SinkSlice['table'], searchType: SinkSlice['searchType'], siteId?: string): SinkSlice {
  return { ctx: { userId: 'u1', siteId }, table, searchType, date: '2026-05-01' }
}

describe('clusterAndDedupe clusterKey subset invariant', () => {
  beforeEach(() => {
    appendCalls.length = 0
    corruptClusterKey = false
    connectIcebergCatalog.mockReset().mockResolvedValue(FAKE_CONN)
    icebergAppendRetrying.mockReset().mockImplementation(async (args: { table: string, records: Record<string, unknown>[] }) => {
      appendCalls.push({ table: args.table, records: args.records })
    })
  })

  it('fails the flush of a table whose clusterKey leaves identityColumns instead of silently weakening dedupe', async () => {
    corruptClusterKey = true
    const sink = createIcebergAppendSink({ catalog: CATALOG, encoding: 'string' })
    // Two rows with the SAME identity tuple (site, search_type, url, date)
    // but different clicks. Under the weakened key (cluster + identity) they
    // sort apart on 'clicks' and BOTH would commit — a double count.
    await sink.emit(slice('pages', 'web', 's1'), [
      { url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
      { url: '/', date: '2026-05-01', clicks: 5, impressions: 6, sum_position: 7 },
    ])
    // A table whose spec still satisfies the invariant must flush normally.
    await sink.emit(slice('queries', 'web', 's1'), [
      { query: 'a', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])

    const res = await sink.close()

    expect(res.flushed).toEqual(['queries'])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]!.table).toBe('pages')
    expect(res.failed[0]!.error.message).toMatch(/identity/)
    // Nothing committed for the violating table — no silent double-count.
    expect(appendCalls.find(c => c.table === 'pages')).toBeUndefined()
    expect(appendCalls.find(c => c.table === 'queries')).toBeDefined()
  })

  it('flushes unchanged when every clusterKey column is an identity column', async () => {
    const sink = createIcebergAppendSink({ catalog: CATALOG, encoding: 'string' })
    await sink.emit(slice('pages', 'web', 's1'), [
      { url: '/', date: '2026-05-01', clicks: 1, impressions: 2, sum_position: 3 },
      { url: '/', date: '2026-05-01', clicks: 5, impressions: 6, sum_position: 7 },
    ])
    const res = await sink.close()
    expect(res.failed).toEqual([])
    // Same identity tuple → collapsed to the last-emitted row.
    expect(appendCalls[0]!.records).toHaveLength(1)
    expect(appendCalls[0]!.records[0]!.clicks).toBe(5)
  })
})
