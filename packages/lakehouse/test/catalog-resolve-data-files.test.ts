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

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/manifest.js', () => ({ icebergManifests }))

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

  it('stores BigInt metadata through JSON-backed caches and reuses it on the next range', async () => {
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
    const storage = createStorage()
    const setItem = storage.setItem.bind(storage)
    storage.setItem = async (key, value, options) => {
      const jsonValue = JSON.parse(JSON.stringify(value))
      await setItem(key, jsonValue, options)
    }
    const errors: unknown[] = []
    const cache = { storage, onError: (_operation: string, _key: string, error: unknown) => errors.push(error) }

    const first = await resolveIcebergDataFiles(CONN, opts({ cache }))
    const second = await resolveIcebergDataFiles(CONN, opts({ cache, range: { start: '2026-06-01', end: '2026-06-30' } }))

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(errors).toEqual([])
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
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

// ---------------------------------------------------------------------------
// Per-file date-bound pruning. The partition tuple only narrows to a month, so
// these cover the day-level narrowing the manifest `lower_bounds`/`upper_bounds`
// make possible — and, above all, that every uncertain case KEEPS the file.
// ---------------------------------------------------------------------------

const DATE_FIELD_ID = 3

/** Iceberg `date` single-value serialization: 4-byte little-endian int32 day count. */
function dayBytes(iso: string): Uint8Array {
  const days = Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)
  const buf = new ArrayBuffer(4)
  new DataView(buf).setInt32(0, days, true)
  return new Uint8Array(buf)
}

/** Avro-decoded manifest stat map: an array of `{key, value}` records. */
function statMap(fieldId: number, value: Uint8Array | unknown) {
  return [{ key: fieldId, value }]
}

function withDateBounds(entry: FakeEntry, min: string, max: string): FakeEntry {
  const df = entry.data_file as Record<string, unknown>
  df.lower_bounds = statMap(DATE_FIELD_ID, dayBytes(min))
  df.upper_bounds = statMap(DATE_FIELD_ID, dayBytes(max))
  return entry
}

function schemaMetadata(dateType: string = 'date') {
  return {
    'current-snapshot-id': 'snap-1',
    'current-schema-id': 0,
    'schemas': [{
      'type': 'struct',
      'schema-id': 0,
      'fields': [
        { id: 1, name: 'site_id', required: true, type: 'int' },
        { id: DATE_FIELD_ID, name: 'date', required: true, type: dateType },
      ],
    }],
  }
}

function withBoundedSnapshot(entries: FakeEntry[], dateType?: string) {
  restCatalogLoadTable.mockResolvedValue({ metadata: schemaMetadata(dateType) })
  icebergManifests.mockResolvedValue([{ entries }])
}

/** One daily file inside the May 2026 partition. */
function dailyFile(iso: string): FakeEntry {
  return withDateBounds(
    dataFile({ site_id: 1, date_month: monthVal(iso.slice(0, 7)) }, `s3://lh/crawl/pages/${iso}.parquet`),
    iso,
    iso,
  )
}

describe('resolveIcebergDataFiles date-bound pruning', () => {
  beforeEach(() => {
    file_path_id = 0
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('prunes a file whose date bounds fall entirely before the range', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-01', '2026-05-05')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toEqual([])
  })

  it('prunes a file whose date bounds fall entirely after the range', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-25', '2026-05-31')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toEqual([])
  })

  it('keeps a file whose date bounds overlap the range, exposing the decoded bounds', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }, 's3://lh/crawl/pages/a.parquet'), '2026-05-18', '2026-05-24')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toEqual([{
      filePath: 's3://lh/crawl/pages/a.parquet',
      objectKey: 'crawl/pages/a.parquet',
      bytes: 1024,
      rowCount: 10,
      dateBounds: { minDay: 20591, maxDay: 20597 },
    }])
  })

  it('keeps a file touching the range at exactly its start day (inclusive)', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-01', '2026-05-10')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('keeps a file touching the range at exactly its end day (inclusive)', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-20', '2026-05-28')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('fails open: keeps a file with no bounds at all', async () => {
    withBoundedSnapshot([dataFile({ site_id: 1, date_month: monthVal('2026-05') })])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
    expect(out[0].dateBounds).toBeUndefined()
  })

  it('fails open: keeps a file whose bounds omit the date column', async () => {
    const entry = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const df = entry.data_file as Record<string, unknown>
    df.lower_bounds = statMap(1, dayBytes('2026-05-01'))
    df.upper_bounds = statMap(1, dayBytes('2026-05-05'))
    withBoundedSnapshot([entry])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('fails open: keeps a file with malformed (wrong-width) bound bytes', async () => {
    const entry = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const df = entry.data_file as Record<string, unknown>
    df.lower_bounds = statMap(DATE_FIELD_ID, new Uint8Array([1, 2]))
    df.upper_bounds = statMap(DATE_FIELD_ID, new Uint8Array([1, 2]))
    withBoundedSnapshot([entry])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
    expect(out[0].dateBounds).toBeUndefined()
  })

  it('fails open: keeps a file whose bound value is not bytes at all', async () => {
    const entry = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const df = entry.data_file as Record<string, unknown>
    df.lower_bounds = statMap(DATE_FIELD_ID, '2026-05-01')
    df.upper_bounds = statMap(DATE_FIELD_ID, '2026-05-05')
    withBoundedSnapshot([entry])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('fails open: keeps a file with only a lower bound', async () => {
    const entry = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    ;(entry.data_file as Record<string, unknown>).lower_bounds = statMap(DATE_FIELD_ID, dayBytes('2026-05-01'))
    withBoundedSnapshot([entry])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('fails open: keeps every file when the date column cannot be identified', async () => {
    // No schema in the metadata at all — the original month-only behaviour.
    withSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-01', '2026-05-05')])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('fails open: keeps every file when the date column is not an Iceberg date', async () => {
    withBoundedSnapshot([withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }), '2026-05-01', '2026-05-05')], 'string')
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toHaveLength(1)
  })

  it('accepts a plain Record<fieldId, bytes> bound map as well as the Avro key/value array', async () => {
    const entry = dataFile({ site_id: 1, date_month: monthVal('2026-05') })
    const df = entry.data_file as Record<string, unknown>
    df.lower_bounds = { [DATE_FIELD_ID]: dayBytes('2026-05-01') }
    df.upper_bounds = { [DATE_FIELD_ID]: dayBytes('2026-05-05') }
    withBoundedSnapshot([entry])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out).toEqual([])
  })

  it('still applies the site_id and month filters when date bounds are present', async () => {
    withBoundedSnapshot([
      withDateBounds(dataFile({ site_id: 2, date_month: monthVal('2026-05') }), '2026-05-12', '2026-05-12'),
      withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-04') }), '2026-05-12', '2026-05-12'),
      withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }, 's3://lh/crawl/pages/keep.parquet'), '2026-05-12', '2026-05-12'),
    ])
    const out = await resolveIcebergDataFiles(CONN, opts({ range: { start: '2026-05-10', end: '2026-05-20' } }))
    expect(out.map(f => f.filePath)).toEqual(['s3://lh/crawl/pages/keep.parquet'])
  })

  it('narrows a 7-day query over a 43-file month partition to 7 files', async () => {
    const files = Array.from({ length: 31 }, (_, i) => dailyFile(`2026-05-${String(i + 1).padStart(2, '0')}`))
      .concat(Array.from({ length: 12 }, (_, i) => dailyFile(`2026-06-${String(i + 1).padStart(2, '0')}`)))
    expect(files).toHaveLength(43)
    withBoundedSnapshot(files)

    const range = { start: '2026-05-28', end: '2026-06-03' }
    const out = await resolveIcebergDataFiles(CONN, opts({ range }))
    expect(out.map(f => f.objectKey)).toEqual([
      'crawl/pages/2026-05-28.parquet',
      'crawl/pages/2026-05-29.parquet',
      'crawl/pages/2026-05-30.parquet',
      'crawl/pages/2026-05-31.parquet',
      'crawl/pages/2026-06-01.parquet',
      'crawl/pages/2026-06-02.parquet',
      'crawl/pages/2026-06-03.parquet',
    ])
  })

  it('caches per exact range, not per month, so a narrower range is not served the wider list', async () => {
    withBoundedSnapshot([
      withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }, 's3://lh/crawl/pages/early.parquet'), '2026-05-01', '2026-05-05'),
      withDateBounds(dataFile({ site_id: 1, date_month: monthVal('2026-05') }, 's3://lh/crawl/pages/late.parquet'), '2026-05-25', '2026-05-31'),
    ])
    const cache = { storage: createStorage() }

    const wide = await resolveIcebergDataFiles(CONN, opts({ cache, range: { start: '2026-05-01', end: '2026-05-31' } }))
    expect(wide).toHaveLength(2)

    const narrow = await resolveIcebergDataFiles(CONN, opts({ cache, range: { start: '2026-05-01', end: '2026-05-05' } }))
    expect(narrow.map(f => f.objectKey)).toEqual(['crawl/pages/early.parquet'])
  })
})
