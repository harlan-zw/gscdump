/**
 * Catalog load-table count per append, through the REAL (patched) icebird
 * append and commit loop. R2 Data Catalog bills every load-table. The
 * landed-check already loads the table, so a successful append must cost one
 * load-table and one update-table. Only the catalog HTTP transport is stubbed;
 * parquet, manifest, and manifest-list writes go to in-memory writers.
 */

import type { Resolver } from 'icebird'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { icebergAppendBatchesRetrying, icebergAppendRetrying } from '../src/catalog'

// `hyparquet-writer` is icebird's dependency, not lakehouse's. Resolve it from
// icebird's own location so the in-memory writer matches the one icebird uses.
const icebirdEntry = fileURLToPath(import.meta.resolve('icebird'))
const { ByteWriter } = await import(createRequire(icebirdEntry).resolve('hyparquet-writer')) as typeof import('hyparquet-writer')

const CATALOG_URL = 'https://catalog.example'
const TABLE_PATH = `${CATALOG_URL}/v1/namespaces/gsc/tables/pages`

function tableMetadata() {
  return {
    'format-version': 2,
    'table-uuid': '00000000-0000-4000-8000-000000000001',
    'location': 'memory://warehouse/gsc/pages',
    'last-sequence-number': 0,
    'last-updated-ms': 1,
    'last-column-id': 2,
    'current-schema-id': 0,
    'schemas': [{
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        { id: 1, name: 'url', required: false, type: 'string' },
        { id: 2, name: 'site_id', required: false, type: 'long' },
      ],
    }],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, 'fields': [] }],
    'last-partition-id': 999,
    'default-sort-order-id': 0,
    'sort-orders': [{ 'order-id': 0, 'fields': [] }],
    'properties': {},
    'snapshots': [],
    'snapshot-log': [],
    'metadata-log': [],
    'refs': {},
  }
}

interface CatalogCalls {
  loadTable: number
  updateTable: number
}

function stubCatalog(opts: { conflictsBeforeCommit?: number } = {}): CatalogCalls {
  const calls: CatalogCalls = { loadTable: 0, updateTable: 0 }
  let conflicts = opts.conflictsBeforeCommit ?? 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url !== TABLE_PATH)
      return new Response('not found', { status: 404 })
    if (method === 'GET') {
      calls.loadTable++
      return Response.json({ 'metadata-location': 'memory://warehouse/gsc/pages/metadata/v1.json', 'metadata': tableMetadata() })
    }
    calls.updateTable++
    if (conflicts > 0) {
      conflicts--
      return Response.json({ error: { message: 'Requirement failed: branch main has changed', type: 'CommitFailedException', code: 409 } }, { status: 409 })
    }
    return Response.json({ 'metadata-location': 'memory://warehouse/gsc/pages/metadata/v2.json', 'metadata': tableMetadata() })
  }))
  return calls
}

const TARGET = {
  catalog: { type: 'rest', url: CATALOG_URL, prefix: '', defaults: {}, overrides: {} } as never,
  namespace: 'gsc',
  table: 'pages',
  resolver: { writer: () => new ByteWriter() } as unknown as Resolver as never,
}

const FAST = { sleep: async () => {}, random: () => 0 }

describe('catalog operations per append', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('issues one load-table and one update-table for a successful row append', async () => {
    const calls = stubCatalog()
    await icebergAppendRetrying({ ...TARGET, records: [{ url: '/', site_id: 1n }] }, { ...FAST, appendId: 'count-rows' })
    expect(calls).toEqual({ loadTable: 1, updateTable: 1 })
  })

  it('issues one load-table and one update-table for a successful batch append', async () => {
    const calls = stubCatalog()
    await icebergAppendBatchesRetrying(
      { ...TARGET, batchFactory: () => [[{ url: '/', site_id: 1n }]] },
      { ...FAST, appendId: 'count-batches' },
    )
    expect(calls).toEqual({ loadTable: 1, updateTable: 1 })
  })

  it('still reloads the table after a commit conflict', async () => {
    const calls = stubCatalog({ conflictsBeforeCommit: 1 })
    await icebergAppendRetrying({ ...TARGET, records: [{ url: '/p', site_id: 1n }] }, { ...FAST, appendId: 'count-conflict' })
    expect(calls).toEqual({ loadTable: 2, updateTable: 2 })
  })
})
