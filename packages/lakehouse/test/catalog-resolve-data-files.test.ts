/**
 * Unit tests for `resolveIcebergDataFiles` (the generic read path) — ported +
 * generalized from `@gscdump/engine`'s `iceberg-catalog-list-data-files.test.ts`
 * and the `listIcebergDataFiles` half of `iceberg-catalog-cache.test.ts`.
 * No network: `icebird` is mocked.
 */

import { createStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird', () => ({
  icebergAppend: vi.fn(),
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  icebergManifests,
  restCatalogConnect: vi.fn(),
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables: vi.fn(),
  restCatalogLoadTable,
  s3SignedResolver: vi.fn(),
}))

const { resolveIcebergDataFiles } = await import('../src/catalog')

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'crawl' }
const SPEC = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]

function monthVal(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return (y - 1970) * 12 + (m - 1)
}

interface FakeEntry {
  status?: number
  data_file: { content?: number, file_path: string, file_size_in_bytes: number, record_count: number, partition: Record<string, unknown> }
}

let file_path_id = 0
function dataFile(partition: { site_id: number, date_month: number }, file_path = `s3://lh/crawl/pages/${file_path_id++}.parquet`): FakeEntry {
  return { status: 1, data_file: { content: 0, file_path, file_size_in_bytes: 1024, record_count: 10, partition } }
}

function withSnapshot(entries: FakeEntry[]) {
  restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': 'snap-1' } })
  icebergManifests.mockResolvedValue([{ entries }])
}

const RANGE = { start: '2026-05-01', end: '2026-05-31' }

function opts(extra: Partial<Parameters<typeof resolveIcebergDataFiles>[1]> = {}) {
  return {
    namespace: 'crawl',
    table: 'pages',
    partitionSpec: SPEC,
    matches: [{ field: 'site_id', value: 1, encoding: 'int32' as const }],
    range: RANGE,
    ...extra,
  }
}

describe('resolveIcebergDataFiles', () => {
  beforeEach(() => {
    file_path_id = 0
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns [] for an empty table without reading manifests', async () => {
    restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': null } })
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toEqual([])
    expect(icebergManifests).not.toHaveBeenCalled()
  })

  it('returns matching data files with stripped object key, bytes and rowCount', async () => {
    withSnapshot([dataFile({ site_id: 1, date_month: monthVal('2026-05') }, 's3://lh/crawl/pages/a.parquet')])
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toEqual([{ filePath: 's3://lh/crawl/pages/a.parquet', objectKey: 'crawl/pages/a.parquet', bytes: 1024, rowCount: 10 }])
  })

  it('filters out non-matching site_id', async () => {
    withSnapshot([
      dataFile({ site_id: 1, date_month: monthVal('2026-05') }),
      dataFile({ site_id: 2, date_month: monthVal('2026-05') }),
    ])
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toHaveLength(1)
  })

  it('expands a multi-month range and keeps only months inside it', async () => {
    withSnapshot([
      dataFile({ site_id: 1, date_month: monthVal('2026-04') }),
      dataFile({ site_id: 1, date_month: monthVal('2026-05') }),
      dataFile({ site_id: 1, date_month: monthVal('2026-06') }),
      dataFile({ site_id: 1, date_month: monthVal('2026-07') }),
    ])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-15', end: '2026-06-10' } }))
    expect(out).toHaveLength(2)
  })

  it('skips DELETED entries (status=2)', async () => {
    const live = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const deleted = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    deleted.status = 2
    withSnapshot([deleted, live])
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toHaveLength(1)
    expect(out[0].filePath).toBe(live.data_file.file_path)
  })

  it('skips non-data file entries (content != 0)', async () => {
    const data = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const deleteFile = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    deleteFile.data_file.content = 1
    withSnapshot([deleteFile, data])
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toHaveLength(1)
  })

  it('skips entries whose date_month partition is not a number', async () => {
    const bad = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    ;(bad.data_file.partition as Record<string, unknown>).date_month = null
    withSnapshot([bad])
    const out = await resolveIcebergDataFiles(CONN, opts())
    expect(out).toEqual([])
  })

  it('a second identical call skips both the loadTable round-trip and the manifest walk (cache)', async () => {
    withSnapshot([dataFile({ site_id: 1, date_month: monthVal('2026-05') })])
    const cache = { storage: createStorage() }

    const out1 = await resolveIcebergDataFiles(CONN, opts({ cache }))
    expect(out1).toHaveLength(1)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)

    const out2 = await resolveIcebergDataFiles(CONN, opts({ cache }))
    expect(out2).toEqual(out1)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)
  })

  it('hands the manifest list a partition filter that prunes a non-matching manifest', async () => {
    withSnapshot([dataFile({ site_id: 1, date_month: monthVal('2026-05') })])
    const cache = { storage: createStorage() }
    await resolveIcebergDataFiles(CONN, opts({
      cache,
      matches: [{ field: 'site_id', value: 's1', encoding: 'string' }],
    }))
    const arg = icebergManifests.mock.calls[0]![0] as { partitionFilter?: (p: unknown) => boolean }
    expect(typeof arg.partitionFilter).toBe('function')
    const aboveRange = [
      { contains_null: false, lower_bound: new TextEncoder().encode('s8'), upper_bound: new TextEncoder().encode('s9') },
      { contains_null: false },
    ]
    expect(arg.partitionFilter!(aboveRange)).toBe(false)
  })

  it('does not throw when metadata carries BigInt snapshot ids and a cache is supplied', async () => {
    // Real REST load-table metadata parses int64 fields (current-snapshot-id,
    // per-snapshot snapshot-id/sequence-number) as BigInt. The metadata cache
    // size-gate must not JSON.stringify those raw (throws "serialize a BigInt").
    restCatalogLoadTable.mockResolvedValue({
      metadata: {
        'current-snapshot-id': 8114363535789397000n,
        'snapshots': [{ 'snapshot-id': 8114363535789397000n, 'sequence-number': 42n }],
      },
    })
    icebergManifests.mockResolvedValue([{ entries: [dataFile({ site_id: 1, date_month: monthVal('2026-05') })] }])
    const cache = { storage: createStorage() }

    const out = await resolveIcebergDataFiles(CONN, opts({ cache }))
    expect(out).toHaveLength(1)
  })

  it('caches an empty table without ever walking manifests', async () => {
    restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': null } })
    const cache = { storage: createStorage() }

    const out1 = await resolveIcebergDataFiles(CONN, opts({ cache }))
    expect(out1).toEqual([])
    expect(icebergManifests).not.toHaveBeenCalled()

    const out2 = await resolveIcebergDataFiles(CONN, opts({ cache }))
    expect(out2).toEqual([])
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
  })
})
