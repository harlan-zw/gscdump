/**
 * Unit tests for `listIcebergDataFiles` (the read path) — no network. `icebird`
 * is mocked so `restCatalogLoadTable` returns a fake table metadata and
 * `icebergManifests` returns fake manifest entries. Covers month-range
 * expansion (incl. inverted/malformed range), partition filtering by
 * site_id/search_type/date_month, skipping DELETED (status=2) and non-data
 * (content!=0) entries, and the empty-snapshot case.
 */

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

const { listIcebergDataFiles } = await import('../src/iceberg/catalog')

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'gsc' }

/** `month(date)` value: months since 1970-01. 2026-05 → (2026-1970)*12 + 4 = 676. */
function monthVal(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return (y - 1970) * 12 + (m - 1)
}

interface FakeEntry {
  status?: number
  data_file: {
    content?: number
    file_path: string
    file_size_in_bytes: number
    record_count: number
    partition: Record<string, unknown>
  }
}

let file_path_id = 0

function dataFile(
  partition: { site_id: string, search_type: string, date_month: number },
  file_path = `s3://gscdump-analytics/gsc/pages/${file_path_id++}.parquet`,
): FakeEntry {
  return {
    status: 1,
    data_file: { content: 0, file_path, file_size_in_bytes: 1024, record_count: 10, partition },
  }
}

function withSnapshot(entries: FakeEntry[]) {
  restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': 'snap-1' } })
  icebergManifests.mockResolvedValue([{ entries }])
}

const RANGE = { start: '2026-05-01', end: '2026-05-31' }

describe('listIcebergDataFiles', () => {
  beforeEach(() => {
    file_path_id = 0
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns [] for an empty table (current-snapshot-id == null) without reading manifests', async () => {
    restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': null } })
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toEqual([])
    expect(icebergManifests).not.toHaveBeenCalled()
  })

  it('returns matching data files with stripped object key, bytes and rowCount', async () => {
    withSnapshot([dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') }, 's3://gscdump-analytics/gsc/pages/a.parquet')])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toEqual([
      { filePath: 's3://gscdump-analytics/gsc/pages/a.parquet', objectKey: 'gsc/pages/a.parquet', bytes: 1024, rowCount: 10 },
    ])
  })

  it('filters out non-matching site_id and search_type', async () => {
    withSnapshot([
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') }),
      dataFile({ site_id: 's2', search_type: 'web', date_month: monthVal('2026-05') }),
      dataFile({ site_id: 's1', search_type: 'discover', date_month: monthVal('2026-05') }),
    ])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toHaveLength(1)
  })

  it('expands a multi-month range and keeps only months inside it', async () => {
    withSnapshot([
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-04') }), // before
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') }), // in
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-06') }), // in
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-07') }), // after
    ])
    const out = await listIcebergDataFiles(CONN, {
      table: 'pages',
      siteId: 's1',
      searchType: 'web',
      range: { start: '2026-05-15', end: '2026-06-10' },
    })
    expect(out).toHaveLength(2)
  })

  it('crosses a year boundary in month expansion', async () => {
    withSnapshot([
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2025-12') }),
      dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-01') }),
    ])
    const out = await listIcebergDataFiles(CONN, {
      table: 'pages',
      siteId: 's1',
      searchType: 'web',
      range: { start: '2025-12-20', end: '2026-01-05' },
    })
    expect(out).toHaveLength(2)
  })

  it('treats an inverted range (start > end) as empty — matches nothing', async () => {
    withSnapshot([dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })])
    const out = await listIcebergDataFiles(CONN, {
      table: 'pages',
      siteId: 's1',
      searchType: 'web',
      range: { start: '2026-06-01', end: '2026-05-01' },
    })
    expect(out).toEqual([])
  })

  it('skips DELETED entries (status=2)', async () => {
    const live = dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })
    const deleted = dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })
    deleted.status = 2
    withSnapshot([deleted, live])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toHaveLength(1)
    expect(out[0].filePath).toBe(live.data_file.file_path)
  })

  it('skips non-data file entries (delete files, content != 0)', async () => {
    const data = dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })
    const deleteFile = dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })
    deleteFile.data_file.content = 1
    withSnapshot([deleteFile, data])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toHaveLength(1)
    expect(out[0].filePath).toBe(data.data_file.file_path)
  })

  it('skips entries whose date_month partition is not a number', async () => {
    const bad = dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })
    ;(bad.data_file.partition as Record<string, unknown>).date_month = null
    withSnapshot([bad])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toEqual([])
  })

  it('walks every manifest in the snapshot', async () => {
    restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': 'snap-1' } })
    icebergManifests.mockResolvedValue([
      { entries: [dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })] },
      { entries: [dataFile({ site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') })] },
    ])
    const out = await listIcebergDataFiles(CONN, { table: 'pages', siteId: 's1', searchType: 'web', range: RANGE })
    expect(out).toHaveLength(2)
  })
})
