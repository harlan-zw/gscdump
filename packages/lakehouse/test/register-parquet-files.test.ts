import type { TableMetadata } from 'icebird'
import type { IcebergConnection, ParquetFileMetadataLike } from '../src/index'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { icebergManifests, s3SignedResolver } from 'icebird'
import { createStorage } from 'unstorage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineIcebergDataset,
  encodeIcebergBoundValue,
  extractParquetColumnStats,
  registerIcebergParquetFiles,
  toIcebergDayCount,
} from '../src/index'

const DATASET_DEF = {
  namespace: 'gsc',
  table: 'page_queries',
  identity: { kind: 'site-int' as const, encoding: 'int' as const },
  naturalKey: ['date', 'page', 'query'],
  clusterKey: ['page', 'query', 'date'],
  columns: [
    { name: 'date', type: 'DATE' as const, required: true },
    { name: 'page', type: 'STRING' as const, required: true },
    { name: 'query', type: 'STRING' as const, required: true },
    { name: 'clicks', type: 'LONG' as const, required: true },
    { name: 'position', type: 'DOUBLE' as const, required: true },
    { name: 'active', type: 'BOOLEAN' as const, required: false },
  ],
  partition: [
    { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
    { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
  ],
}

const dataset = defineIcebergDataset(DATASET_DEF)

interface MockCatalogOptions {
  metadata?: Partial<TableMetadata>
  conflictStatus?: 409 | 412
  concurrentLoadGate?: boolean
  ambiguousFirstCommitStatus?: number
  commitFailures?: Array<{ status: number, message: string }>
}

function createMockCatalog(options: MockCatalogOptions = {}) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>()
  const putPaths: string[] = []
  let loads = 0
  let commits = 0
  let conflicts = 0
  const queuedFailures = [...(options.commitFailures ?? [])]

  let metadata: TableMetadata = {
    'format-version': 2,
    'table-uuid': '00000000-0000-4000-8000-000000000042',
    'location': 's3://local/warehouse/page_queries',
    'last-sequence-number': 0,
    'last-updated-ms': 1_700_000_000_000,
    'last-column-id': 7,
    'current-schema-id': 0,
    'schemas': [dataset.icebergSchema()],
    'default-spec-id': 0,
    'partition-specs': [dataset.icebergPartitionSpec()],
    'last-partition-id': 1001,
    'default-sort-order-id': 1,
    'sort-orders': [
      { 'order-id': 0, 'fields': [] },
      dataset.icebergSortOrder()!,
    ],
    'properties': {
      'commit.retry.min-wait-ms': '0',
      'commit.retry.max-wait-ms': '0',
    },
    'snapshots': [],
    'refs': {},
    ...options.metadata,
  }

  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    if (url.hostname === 'objects.invalid') {
      if (method === 'PUT') {
        putPaths.push(url.pathname)
        objects.set(url.pathname, new Uint8Array(init.body as Uint8Array<ArrayBuffer>))
        return new Response(null)
      }
      const bytes = objects.get(url.pathname)
      if (!bytes)
        return new Response('Not Found', { status: 404 })
      if (method === 'HEAD')
        return new Response(null, { headers: { 'content-length': String(bytes.length) } })
      const range = new Headers(init.headers).get('range')?.match(/bytes=(\d+)-(\d+)/)
      return new Response(range ? bytes.slice(Number(range[1]), Number(range[2]) + 1) : bytes)
    }

    if (url.hostname !== 'catalog.invalid')
      throw new Error(`Unexpected fetch host: ${url.hostname}`)

    if (method === 'GET') {
      loads++
      const response = Response.json({ metadata })
      if (options.concurrentLoadGate && loads <= 2) {
        if (loads === 2)
          releaseGate()
        await gate
      }
      return response
    }

    const body = JSON.parse(String(init.body)) as {
      requirements: Array<{ 'type': string, 'snapshot-id'?: number | null, 'uuid'?: string }>
      updates: Array<{ action: string, snapshot?: NonNullable<TableMetadata['snapshots']>[number] }>
    }

    if (queuedFailures.length > 0) {
      const failure = queuedFailures.shift()!
      return Response.json({ error: { message: failure.message, code: failure.status } }, { status: failure.status })
    }

    const refReq = body.requirements.find(r => r.type === 'assert-ref-snapshot-id')
    if (refReq && refReq['snapshot-id'] !== (metadata['current-snapshot-id'] ?? null)) {
      conflicts++
      const status = options.conflictStatus ?? 409
      return Response.json({ error: { message: 'Snapshot conflict', code: status } }, { status })
    }

    const addSnap = body.updates.find(u => u.action === 'add-snapshot')?.snapshot
    if (!addSnap)
      return Response.json({ error: { message: 'Missing add-snapshot' } }, { status: 400 })

    metadata = {
      ...metadata,
      'current-snapshot-id': addSnap['snapshot-id'],
      'last-sequence-number': addSnap['sequence-number'],
      'snapshots': [...(metadata.snapshots ?? []), addSnap],
      'refs': {
        ...metadata.refs,
        main: { 'snapshot-id': addSnap['snapshot-id'], 'type': 'branch' },
      },
    }
    commits++

    if (options.ambiguousFirstCommitStatus && commits === 1) {
      return Response.json(
        { error: { message: 'Lost commit response', code: options.ambiguousFirstCommitStatus } },
        { status: options.ambiguousFirstCommitStatus },
      )
    }

    return Response.json({ metadata })
  })

  const resolver = s3SignedResolver({
    accessKeyId: 'local',
    secretAccessKey: 'local',
    region: 'auto',
    endpoint: 'https://objects.invalid',
    pathStyle: true,
  })

  const conn: IcebergConnection = {
    catalog: {
      type: 'rest',
      url: 'https://catalog.invalid',
      prefix: '',
      defaults: {},
      overrides: {},
    },
    resolver,
    namespace: 'gsc',
    cacheScope: 'https://catalog.invalid\0wh',
  }

  return {
    conn,
    putObject(s3Uri: string, bytes: Uint8Array<ArrayBuffer>) {
      const withoutScheme = s3Uri.replace(/^s3:\/\//, '')
      objects.set(`/${withoutScheme}`, bytes)
    },
    metadata: () => metadata,
    loads: () => loads,
    commits: () => commits,
    conflicts: () => conflicts,
    manifestUploads: () => putPaths.filter(p => p.endsWith('-m0.avro')),
    manifestListUploads: () => putPaths.filter(p => /\/snap-\d+-1-/.test(p)),
    readCurrentManifests: () => icebergManifests({ metadata, resolver }),
  }
}

function readBoundBytes(map: unknown, fieldId: number): Uint8Array | undefined {
  if (!map)
    return undefined
  if (Array.isArray(map)) {
    const found = (map as Array<{ key: number, value: Uint8Array }>).find(e => Number(e.key) === fieldId)
    return found?.value
  }
  return (map as Record<number, Uint8Array>)[fieldId]
}

function readStatCount(map: unknown, fieldId: number): bigint | undefined {
  if (!map)
    return undefined
  if (Array.isArray(map)) {
    const found = (map as Array<{ key: number, value: bigint }>).find(e => Number(e.key) === fieldId)
    return found?.value
  }
  return (map as Record<number, bigint>)[fieldId]
}

const FAST_RETRY = { sleep: async () => {}, random: () => 0 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registerIcebergParquetFiles & dataset.registerParquetFiles', () => {
  it('registers a single pre-written ZSTD Parquet file into one Avro manifest and append snapshot', async () => {
    const mock = createMockCatalog()
    const zstdPath = 's3://local/warehouse/page_queries/data/2026-03.zstd.parquet'

    const result = await dataset.registerParquetFiles(
      mock.conn,
      [
        {
          path: zstdPath,
          fileSizeBytes: 512_000,
          recordCount: 120_000,
          partition: { site_id: 42, date_month: 674 },
          sortOrderId: 1,
          columnStats: {
            columnSizes: { date: 12_000, page: 200_000, clicks: 40_000 },
            valueCounts: { date: 120_000, clicks: 120_000 },
            nullValueCounts: { active: 500 },
            lowerBounds: {
              site_id: 42,
              date: '2026-03-01',
              page: 'https://example.com/a',
              clicks: 0n,
              position: 1.25,
              active: false,
            },
            upperBounds: {
              site_id: 42,
              date: '2026-03-31',
              page: 'https://example.com/z',
              clicks: 9_000_000_000n,
              position: 98.5,
              active: true,
            },
            splitOffsets: [16_384, 4],
          },
        },
      ],
      {
        appendId: 'backfill-42-2026-03',
        snapshotProperties: { 'gscdump.source': 'duckdb-zstd', 'operation': 'should-not-override' },
        clock: () => 1_775_000_000_000,
      },
    )

    expect(result).toEqual({
      _tag: 'Registered',
      snapshotId: expect.stringMatching(/^\d+$/),
      manifestPath: expect.stringMatching(/^s3:\/\/local\/warehouse\/page_queries\/metadata\/.*-m0\.avro$/),
      fileCount: 1,
      recordCount: 120_000,
      totalBytes: 512_000,
    })
    if (result._tag !== 'Registered')
      throw new Error('expected Registered')

    expect(mock.commits()).toBe(1)
    expect(mock.manifestUploads()).toHaveLength(1)

    const snap = mock.metadata().snapshots![0]!
    expect(String(snap['snapshot-id'])).toBe(result.snapshotId)
    expect(snap['timestamp-ms']).toBe(1_775_000_000_000)
    expect(snap.summary).toMatchObject({
      'operation': 'append',
      'added-data-files': '1',
      'added-records': '120000',
      'added-files-size': '512000',
      'changed-partition-count': '1',
      'total-data-files': '1',
      'total-records': '120000',
      'total-files-size': '512000',
      'lakehouse.append-id': 'backfill-42-2026-03',
      'gscdump.source': 'duckdb-zstd',
    })

    const manifests = await mock.readCurrentManifests()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]!.entries).toHaveLength(1)
    const entry = manifests[0]!.entries[0]!
    expect(entry.status).toBe(1)
    expect(entry.data_file.content).toBe(0)
    expect(entry.data_file.file_path).toBe(zstdPath)
    expect(entry.data_file.file_format).toBe('PARQUET')
    expect(entry.data_file.file_size_in_bytes).toBe(512_000n)
    expect(entry.data_file.record_count).toBe(120_000n)
    expect(entry.data_file.sort_order_id).toBe(1)
    expect(entry.data_file.partition).toEqual({ site_id: 42, date_month: 674 })
    // split_offsets are sorted ascending per Iceberg v2 spec
    expect(entry.data_file.split_offsets).toEqual([4n, 16_384n])
    // Verify column stats by field ID: site_id=1, date=2, page=3, query=4, clicks=5, position=6, active=7
    expect(readStatCount(entry.data_file.column_sizes, 2)).toBe(12_000n)
    expect(readStatCount(entry.data_file.value_counts, 5)).toBe(120_000n)
    expect(readStatCount(entry.data_file.null_value_counts, 7)).toBe(500n)

    const resolved = await dataset.resolveDataFiles(mock.conn, 42, { start: '2026-03-10', end: '2026-03-20' })
    expect(resolved).toEqual([
      {
        filePath: zstdPath,
        objectKey: 'warehouse/page_queries/data/2026-03.zstd.parquet',
        bytes: 512_000,
        rowCount: 120_000,
        dateBounds: {
          minDay: toIcebergDayCount('2026-03-01'),
          maxDay: toIcebergDayCount('2026-03-31'),
        },
      },
    ])

    const byAppend = await dataset.resolveAppendFiles(mock.conn, 'backfill-42-2026-03', 42)
    expect(byAppend._tag).toBe('Ok')
    if (byAppend._tag === 'Ok') {
      expect(byAppend.snapshotId).toBe(result.snapshotId)
      expect(byAppend.files.map(f => f.filePath)).toEqual([zstdPath])
    }
  })

  it('registers multiple files atomically into ONE Avro manifest and ONE commit with partition and day pruning', async () => {
    const mock = createMockCatalog()

    const result = await dataset.registerParquetFiles(
      mock.conn,
      [
        {
          path: 's3://local/warehouse/page_queries/data/2026-03-early.zstd.parquet',
          fileSizeBytes: 100_000,
          recordCount: 10_000,
          partition: { site_id: 42, date_month: 674 },
          columnStats: {
            lowerBounds: { date: '2026-03-01' },
            upperBounds: { date: '2026-03-10' },
          },
        },
        {
          path: 's3://local/warehouse/page_queries/data/2026-03-late.zstd.parquet',
          fileSizeBytes: 150_000,
          recordCount: 15_000,
          partition: { site_id: 42, date_month: 674 },
          columnStats: {
            lowerBounds: { date: '2026-03-20' },
            upperBounds: { date: '2026-03-31' },
          },
        },
        {
          path: 's3://local/warehouse/page_queries/data/2026-04.zstd.parquet',
          fileSizeBytes: 200_000,
          recordCount: 20_000,
          partition: { site_id: 42, date_month: 675 },
          columnStats: {
            lowerBounds: { date: '2026-04-01' },
            upperBounds: { date: '2026-04-30' },
          },
        },
      ],
      { appendId: 'multi-file-1' },
    )

    expect(result._tag).toBe('Registered')
    if (result._tag !== 'Registered')
      throw new Error('expected Registered')
    expect(result.fileCount).toBe(3)
    expect(result.recordCount).toBe(45_000)
    expect(result.totalBytes).toBe(450_000)

    // Atomic: ONE manifest Avro and ONE catalog commit for all 3 files.
    expect(mock.manifestUploads()).toHaveLength(1)
    expect(mock.commits()).toBe(1)

    const summary = mock.metadata().snapshots![0]!.summary
    expect(summary['added-data-files']).toBe('3')
    expect(summary['changed-partition-count']).toBe('2')
    expect(summary['total-records']).toBe('45000')
    expect(summary['total-files-size']).toBe('450000')

    const manifests = await mock.readCurrentManifests()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]!.entries).toHaveLength(3)

    // Day-bound pruning inside March returns ONLY the early file.
    const earlyOnly = await dataset.resolveDataFiles(mock.conn, 42, { start: '2026-03-02', end: '2026-03-08' })
    expect(earlyOnly.map(f => f.filePath)).toEqual([
      's3://local/warehouse/page_queries/data/2026-03-early.zstd.parquet',
    ])

    // Month pruning for April returns ONLY the April file.
    const aprilOnly = await dataset.resolveDataFiles(mock.conn, 42, { start: '2026-04-05', end: '2026-04-15' })
    expect(aprilOnly.map(f => f.filePath)).toEqual([
      's3://local/warehouse/page_queries/data/2026-04.zstd.parquet',
    ])
  })

  it('is idempotent when appendId already exists before staging', async () => {
    const mock = createMockCatalog()
    const file = {
      path: 's3://local/warehouse/page_queries/data/m1.zstd.parquet',
      fileSizeBytes: 1024,
      recordCount: 10,
      partition: { site_id: 1, date_month: 674 },
    }

    const first = await registerIcebergParquetFiles(mock.conn, 'page_queries', [file], { appendId: 'idem-1' })
    expect(first._tag).toBe('Registered')
    if (first._tag !== 'Registered')
      throw new Error('expected Registered')

    const second = await registerIcebergParquetFiles(mock.conn, 'page_queries', [file], { appendId: 'idem-1' })
    expect(second).toEqual({ _tag: 'AlreadyApplied', snapshotId: first.snapshotId })
    expect(mock.commits()).toBe(1)
    expect(mock.manifestUploads()).toHaveLength(1)
  })

  it.each([409, 412] as const)('rebases concurrent distinct registrations on HTTP %i without rewriting the data manifest', async (status) => {
    const mock = createMockCatalog({ conflictStatus: status, concurrentLoadGate: true })

    const [a, b] = await Promise.all([
      dataset.registerParquetFiles(
        mock.conn,
        [{ path: 's3://local/warehouse/page_queries/data/a.zstd.parquet', fileSizeBytes: 1000, recordCount: 100, partition: { site_id: 1, date_month: 674 } }],
        { appendId: 'concurrent-a', commitRetry: FAST_RETRY },
      ),
      dataset.registerParquetFiles(
        mock.conn,
        [{ path: 's3://local/warehouse/page_queries/data/b.zstd.parquet', fileSizeBytes: 2000, recordCount: 250, partition: { site_id: 1, date_month: 674 } }],
        { appendId: 'concurrent-b', commitRetry: FAST_RETRY },
      ),
    ])

    expect(a._tag).toBe('Registered')
    expect(b._tag).toBe('Registered')
    expect(mock.conflicts()).toBe(1)
    expect(mock.commits()).toBe(2)
    // Each writer uploads its data manifest ONCE (reused across rebase).
    expect(mock.manifestUploads()).toHaveLength(2)
    // Loser wrote a second manifest list for the rebased sequence number.
    expect(mock.manifestListUploads()).toHaveLength(3)

    const snapshots = mock.metadata().snapshots!
    expect(snapshots).toHaveLength(2)
    expect(snapshots.map(s => s['sequence-number'])).toEqual([1, 2])
    expect(snapshots[1]!.summary['total-data-files']).toBe('2')
    expect(snapshots[1]!.summary['total-records']).toBe('350')
    expect(snapshots[1]!.summary['total-files-size']).toBe('3000')

    const files = await dataset.resolveDataFiles(mock.conn, 1, { start: '2026-03-01', end: '2026-03-31' })
    expect(files.map(f => f.filePath)).toEqual([
      's3://local/warehouse/page_queries/data/a.zstd.parquet',
      's3://local/warehouse/page_queries/data/b.zstd.parquet',
    ])
  })

  it('deduplicates concurrent identical appendId after HTTP 409 conflict', async () => {
    const mock = createMockCatalog({ conflictStatus: 409, concurrentLoadGate: true })
    const file = {
      path: 's3://local/warehouse/page_queries/data/same.zstd.parquet',
      fileSizeBytes: 4096,
      recordCount: 50,
      partition: { site_id: 7, date_month: 674 },
    }

    const results = await Promise.all([
      dataset.registerParquetFiles(mock.conn, [file], { appendId: 'same-token', commitRetry: FAST_RETRY }),
      dataset.registerParquetFiles(mock.conn, [file], { appendId: 'same-token', commitRetry: FAST_RETRY }),
    ])

    const registered = results.filter(r => r._tag === 'Registered')
    const alreadyApplied = results.filter(r => r._tag === 'AlreadyApplied')
    expect(registered).toHaveLength(1)
    expect(alreadyApplied).toHaveLength(1)
    expect(alreadyApplied[0]!.snapshotId).toBe(registered[0]!.snapshotId)
    expect(mock.commits()).toBe(1)
    expect(mock.metadata().snapshots).toHaveLength(1)
  })

  it('recovers without duplicating when an ambiguous 503 hides a landed commit', async () => {
    const mock = createMockCatalog({ ambiguousFirstCommitStatus: 503 })
    const result = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: 's3://local/warehouse/page_queries/data/landed.zstd.parquet', fileSizeBytes: 2048, recordCount: 25, partition: { site_id: 3, date_month: 674 } }],
      { appendId: 'ambiguous-503', commitRetry: FAST_RETRY },
    )

    expect(result._tag).toBe('Registered')
    expect(mock.commits()).toBe(1)
    expect(mock.metadata().snapshots).toHaveLength(1)
  })

  it('retries transient 429 and 500 responses and propagates permanent 400 immediately', async () => {
    const retryMock = createMockCatalog({
      commitFailures: [
        { status: 429, message: '429 too many commits to this table' },
        { status: 500, message: '500 Internal Server Error' },
      ],
    })
    const ok = await dataset.registerParquetFiles(
      retryMock.conn,
      [{ path: 's3://local/warehouse/page_queries/data/retry.zstd.parquet', fileSizeBytes: 512, recordCount: 5, partition: { site_id: 1, date_month: 674 } }],
      { appendId: 'retry-transient', commitRetry: FAST_RETRY },
    )
    expect(ok._tag).toBe('Registered')
    expect(retryMock.commits()).toBe(1)

    const permMock = createMockCatalog({
      commitFailures: [{ status: 400, message: '400 Bad Request' }],
    })
    await expect(
      dataset.registerParquetFiles(
        permMock.conn,
        [{ path: 's3://local/warehouse/page_queries/data/bad.zstd.parquet', fileSizeBytes: 512, recordCount: 5, partition: { site_id: 1, date_month: 674 } }],
        { appendId: 'perm-400', commitRetry: FAST_RETRY },
      ),
    ).rejects.toThrow(/400/)
    expect(permMock.commits()).toBe(0)
  })

  it('invalidates the reader snapshot cache pointer after a successful commit', async () => {
    const mock = createMockCatalog()
    const storage = createStorage()
    const cache = { storage }
    const snapKey = `lh-snapref\0${mock.conn.cacheScope}\0gsc\0page_queries`
    await storage.setItem(snapKey, { value: 'stale-snap', expiresAt: Date.now() + 60_000 })

    const result = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: 's3://local/warehouse/page_queries/data/c.zstd.parquet', fileSizeBytes: 100, recordCount: 1, partition: { site_id: 1, date_month: 674 } }],
      { appendId: 'cache-inv', cache },
    )
    expect(result._tag).toBe('Registered')
    expect(await storage.getItem(snapKey)).toBeNull()
  })
})

describe('iceberg v2 binary bound serialization and partition tuple encoding', () => {
  it('encodes int, long, float, double, date, string, boolean, and timestamp bounds per Iceberg v2 spec', () => {
    const intEnc = encodeIcebergBoundValue(-42, 'int')
    expect(intEnc._tag).toBe('Ok')
    if (intEnc._tag === 'Ok') {
      expect(intEnc.bytes.byteLength).toBe(4)
      expect(new DataView(intEnc.bytes.buffer).getInt32(0, true)).toBe(-42)
    }

    const longEnc = encodeIcebergBoundValue(9_007_199_254_740_993n, 'long')
    expect(longEnc._tag).toBe('Ok')
    if (longEnc._tag === 'Ok') {
      expect(longEnc.bytes.byteLength).toBe(8)
      expect(new DataView(longEnc.bytes.buffer).getBigInt64(0, true)).toBe(9_007_199_254_740_993n)
    }

    const floatEnc = encodeIcebergBoundValue(3.5, 'float')
    expect(floatEnc._tag).toBe('Ok')
    if (floatEnc._tag === 'Ok') {
      expect(floatEnc.bytes.byteLength).toBe(4)
      expect(new DataView(floatEnc.bytes.buffer).getFloat32(0, true)).toBe(3.5)
    }

    const doubleEnc = encodeIcebergBoundValue(12.3456789, 'double')
    expect(doubleEnc._tag).toBe('Ok')
    if (doubleEnc._tag === 'Ok') {
      expect(doubleEnc.bytes.byteLength).toBe(8)
      expect(new DataView(doubleEnc.bytes.buffer).getFloat64(0, true)).toBe(12.3456789)
    }

    const dateFromStr = encodeIcebergBoundValue('2026-03-15', 'date')
    const dateFromDate = encodeIcebergBoundValue(new Date('2026-03-15T00:00:00Z'), 'date')
    const dateFromInt = encodeIcebergBoundValue(toIcebergDayCount('2026-03-15'), 'date')
    expect(dateFromStr._tag).toBe('Ok')
    expect(dateFromDate).toEqual(dateFromStr)
    expect(dateFromInt).toEqual(dateFromStr)
    if (dateFromStr._tag === 'Ok') {
      expect(dateFromStr.bytes.byteLength).toBe(4)
      expect(new DataView(dateFromStr.bytes.buffer).getInt32(0, true)).toBe(toIcebergDayCount('2026-03-15'))
    }

    const strEnc = encodeIcebergBoundValue('café 🚀', 'string')
    expect(strEnc._tag).toBe('Ok')
    if (strEnc._tag === 'Ok')
      expect(new TextDecoder().decode(strEnc.bytes)).toBe('café 🚀')

    const boolFalse = encodeIcebergBoundValue(false, 'boolean')
    const boolTrue = encodeIcebergBoundValue(true, 'boolean')
    expect(boolFalse).toEqual({ _tag: 'Ok', bytes: new Uint8Array([0]) })
    expect(boolTrue).toEqual({ _tag: 'Ok', bytes: new Uint8Array([1]) })

    const tsIso = encodeIcebergBoundValue('2026-03-15T12:30:45.123456Z', 'timestamp')
    expect(tsIso._tag).toBe('Ok')
    if (tsIso._tag === 'Ok') {
      expect(tsIso.bytes.byteLength).toBe(8)
      const expectedMicros = BigInt(Date.parse('2026-03-15T12:30:45Z')) * 1000n + 123_456n
      expect(new DataView(tsIso.bytes.buffer).getBigInt64(0, true)).toBe(expectedMicros)
    }

    const tsDate = encodeIcebergBoundValue(new Date('2026-03-15T12:30:45.123Z'), 'timestamptz')
    expect(tsDate._tag).toBe('Ok')
    if (tsDate._tag === 'Ok') {
      const expectedMicros = BigInt(Date.parse('2026-03-15T12:30:45.123Z')) * 1000n
      expect(new DataView(tsDate.bytes.buffer).getBigInt64(0, true)).toBe(expectedMicros)
    }
  })

  it('writes exact binary lower_bounds/upper_bounds and partition tuples into the Avro manifest', async () => {
    const mock = createMockCatalog({
      metadata: {
        'schemas': [
          {
            'type': 'struct',
            'schema-id': 0,
            'fields': [
              { id: 1, name: 'tenant', required: true, type: 'string' },
              { id: 2, name: 'date', required: true, type: 'date' },
              { id: 3, name: 'rank', required: true, type: 'int' },
              { id: 4, name: 'impressions', required: true, type: 'long' },
              { id: 5, name: 'ctr', required: true, type: 'double' },
              { id: 6, name: 'synced_at', required: false, type: 'timestamptz' },
              { id: 7, name: 'region', required: false, type: 'string' },
            ],
          },
        ],
        'partition-specs': [
          {
            'spec-id': 0,
            'fields': [
              { 'source-id': 1, 'field-id': 1000, 'name': 'tenant', 'transform': 'identity' },
              { 'source-id': 2, 'field-id': 1001, 'name': 'date_month', 'transform': 'month' },
              { 'source-id': 7, 'field-id': 1002, 'name': 'region', 'transform': 'identity' },
            ],
          },
        ],
        'sort-orders': [{ 'order-id': 0, 'fields': [] }],
        'default-sort-order-id': 0,
      },
    })

    const res = await registerIcebergParquetFiles(
      mock.conn,
      'page_queries',
      [
        {
          path: 's3://local/warehouse/page_queries/data/typed.zstd.parquet',
          fileSizeBytes: 8192,
          recordCount: 500,
          partition: { tenant: 'team-alpha', date_month: 674, region: null },
          columnStats: {
            // Mix column names and numeric field IDs
            lowerBounds: {
              tenant: 'team-alpha',
              2: '2026-03-01',
              rank: 1,
              impressions: 100n,
              ctr: 0.015,
              synced_at: '2026-03-01T00:00:00.000500Z',
            },
            upperBounds: {
              tenant: 'team-alpha',
              date: '2026-03-31',
              3: 100,
              4: 5_000_000_000n,
              ctr: 0.995,
              synced_at: '2026-03-31T23:59:59.999500Z',
            },
          },
        },
      ],
      { appendId: 'typed-bounds-1' },
    )

    expect(res._tag).toBe('Registered')
    const manifests = await mock.readCurrentManifests()
    const df = manifests[0]!.entries[0]!.data_file
    expect(df.partition.tenant).toBe('team-alpha')
    expect(df.partition.date_month).toBe(674)
    expect(df.partition.region).toBeUndefined()

    const decodeInt32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(0, true)
    const decodeInt64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true)
    const decodeFloat64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true)

    expect(new TextDecoder().decode(readBoundBytes(df.lower_bounds, 1)!)).toBe('team-alpha')
    expect(decodeInt32(readBoundBytes(df.lower_bounds, 2)!)).toBe(toIcebergDayCount('2026-03-01'))
    expect(decodeInt32(readBoundBytes(df.upper_bounds, 2)!)).toBe(toIcebergDayCount('2026-03-31'))
    expect(decodeInt32(readBoundBytes(df.lower_bounds, 3)!)).toBe(1)
    expect(decodeInt32(readBoundBytes(df.upper_bounds, 3)!)).toBe(100)
    expect(decodeInt64(readBoundBytes(df.lower_bounds, 4)!)).toBe(100n)
    expect(decodeInt64(readBoundBytes(df.upper_bounds, 4)!)).toBe(5_000_000_000n)
    expect(decodeFloat64(readBoundBytes(df.lower_bounds, 5)!)).toBe(0.015)
    expect(decodeFloat64(readBoundBytes(df.upper_bounds, 5)!)).toBe(0.995)
    expect(decodeInt64(readBoundBytes(df.lower_bounds, 6)!)).toBe(
      BigInt(Date.parse('2026-03-01T00:00:00Z')) * 1000n + 500n,
    )
    expect(decodeInt64(readBoundBytes(df.upper_bounds, 6)!)).toBe(
      BigInt(Date.parse('2026-03-31T23:59:59Z')) * 1000n + 999_500n,
    )
  })
})

describe('parquet footer metadata extraction (readParquetMetadata)', () => {
  it('reads footer stats from a real multi-row-group Parquet file without decompressing rows', async () => {
    const mock = createMockCatalog()
    const d1 = toIcebergDayCount('2026-03-05')
    const d2 = toIcebergDayCount('2026-03-12')
    const d3 = toIcebergDayCount('2026-03-22')
    const d4 = toIcebergDayCount('2026-03-28')

    const parquetBuf = parquetWriteBuffer({
      codec: 'UNCOMPRESSED',
      rowGroupSize: 2,
      schema: [
        { name: 'root', num_children: 7 },
        { name: 'site_id', type: 'INT32', repetition_type: 'REQUIRED' },
        { name: 'date', type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' }, repetition_type: 'REQUIRED' },
        { name: 'page', type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' }, repetition_type: 'REQUIRED' },
        { name: 'query', type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' }, repetition_type: 'REQUIRED' },
        { name: 'clicks', type: 'INT64', repetition_type: 'REQUIRED' },
        { name: 'position', type: 'DOUBLE', repetition_type: 'REQUIRED' },
        { name: 'active', type: 'BOOLEAN', repetition_type: 'OPTIONAL' },
      ],
      columnData: [
        { name: 'site_id', data: [42, 42, 42, 42] },
        { name: 'date', data: [d1, d2, d3, d4] },
        { name: 'page', data: ['/b', '/a', '/d', '/c'] },
        { name: 'query', data: ['zebra', 'alpha', 'middle', 'omega'] },
        { name: 'clicks', data: [10n, 500n, 2n, 9000n] },
        { name: 'position', data: [2.5, 1.1, 14.8, 3.0] },
        { name: 'active', data: [true, null, false, null] },
      ],
    })
    const parquetBytes = new Uint8Array(parquetBuf)
    const filePath = 's3://local/warehouse/page_queries/data/from-footer.parquet'
    mock.putObject(filePath, parquetBytes)

    const result = await dataset.registerParquetFiles(
      mock.conn,
      [
        {
          path: filePath,
          fileSizeBytes: parquetBytes.byteLength,
          recordCount: 4,
          partition: { site_id: 42, date_month: 674 },
        },
      ],
      { appendId: 'footer-extract-1', readParquetMetadata: true },
    )

    expect(result._tag).toBe('Registered')

    const manifests = await mock.readCurrentManifests()
    const df = manifests[0]!.entries[0]!.data_file
    const decodeInt32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(0, true)
    const decodeInt64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true)
    const decodeFloat64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true)

    // Field IDs: site_id=1, date=2, page=3, query=4, clicks=5, position=6, active=7
    expect(readStatCount(df.value_counts, 2)).toBe(4n)
    expect(readStatCount(df.null_value_counts, 7)).toBe(2n)
    expect(readStatCount(df.column_sizes, 3)! > 0n).toBe(true)
    expect(df.split_offsets?.length).toBe(2)

    expect(decodeInt32(readBoundBytes(df.lower_bounds, 1)!)).toBe(42)
    expect(decodeInt32(readBoundBytes(df.lower_bounds, 2)!)).toBe(d1)
    expect(decodeInt32(readBoundBytes(df.upper_bounds, 2)!)).toBe(d4)
    expect(new TextDecoder().decode(readBoundBytes(df.lower_bounds, 3)!)).toBe('/a')
    expect(new TextDecoder().decode(readBoundBytes(df.upper_bounds, 3)!)).toBe('/d')
    expect(new TextDecoder().decode(readBoundBytes(df.lower_bounds, 4)!)).toBe('alpha')
    expect(new TextDecoder().decode(readBoundBytes(df.upper_bounds, 4)!)).toBe('zebra')
    expect(decodeInt64(readBoundBytes(df.lower_bounds, 5)!)).toBe(2n)
    expect(decodeInt64(readBoundBytes(df.upper_bounds, 5)!)).toBe(9000n)
    expect(decodeFloat64(readBoundBytes(df.lower_bounds, 6)!)).toBe(1.1)
    expect(decodeFloat64(readBoundBytes(df.upper_bounds, 6)!)).toBe(14.8)
    expect(readBoundBytes(df.lower_bounds, 7)).toEqual(new Uint8Array([0]))
    expect(readBoundBytes(df.upper_bounds, 7)).toEqual(new Uint8Array([1]))

    // Verify day-bound pruning works immediately on the footer-extracted date bounds.
    const inRange = await dataset.resolveDataFiles(mock.conn, 42, { start: '2026-03-10', end: '2026-03-15' })
    expect(inRange).toHaveLength(1)
    const outOfRange = await dataset.resolveDataFiles(mock.conn, 42, { start: '2026-03-01', end: '2026-03-04' })
    expect(outOfRange).toHaveLength(0)
  })

  it('rejects recordCount mismatch against Parquet footer num_rows when readParquetMetadata is true', async () => {
    const mock = createMockCatalog()
    const parquetBytes = new Uint8Array(parquetWriteBuffer({
      codec: 'UNCOMPRESSED',
      schema: [
        { name: 'root', num_children: 2 },
        { name: 'site_id', type: 'INT32', repetition_type: 'REQUIRED' },
        { name: 'date', type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' }, repetition_type: 'REQUIRED' },
      ],
      columnData: [
        { name: 'site_id', data: [42, 42] },
        { name: 'date', data: [20_513, 20_514] },
      ],
    }))
    const filePath = 's3://local/warehouse/page_queries/data/mismatch.parquet'
    mock.putObject(filePath, parquetBytes)

    const result = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: filePath, fileSizeBytes: parquetBytes.byteLength, recordCount: 99, partition: { site_id: 42, date_month: 674 } }],
      { appendId: 'mismatch-1', readParquetMetadata: true },
    )

    expect(result).toMatchObject({ _tag: 'Err', reason: 'invalid-descriptor', fileIndex: 0 })
    expect(mock.commits()).toBe(0)
    expect(mock.manifestUploads()).toHaveLength(0)
  })

  it('omits unsound partial bounds when a non-all-null row group lacks stats and tolerates all-null row groups', () => {
    const fileMeta: ParquetFileMetadataLike = {
      num_rows: 100n,
      schema: [
        { name: 'root' },
        { name: 'date', type: 'INT32', converted_type: 'DATE' },
        { name: 'query', type: 'BYTE_ARRAY', converted_type: 'UTF8' },
        { name: 'clicks', type: 'INT64' },
      ],
      row_groups: [
        {
          num_rows: 50n,
          columns: [
            {
              file_offset: 4n,
              meta_data: {
                path_in_schema: ['date'],
                num_values: 50n,
                total_compressed_size: 100n,
                data_page_offset: 4n,
                statistics: { min_value: 20_513, max_value: 20_520, null_count: 0n },
              },
            },
            {
              file_offset: 104n,
              meta_data: {
                path_in_schema: ['query'],
                num_values: 50n,
                total_compressed_size: 200n,
                data_page_offset: 104n,
                statistics: { min_value: new TextEncoder().encode('alpha'), max_value: new TextEncoder().encode('beta'), null_count: 0n },
              },
            },
            {
              file_offset: 304n,
              meta_data: {
                path_in_schema: ['clicks'],
                num_values: 50n,
                total_compressed_size: 150n,
                data_page_offset: 304n,
                statistics: { min_value: 5n, max_value: 50n, null_count: 0n },
              },
            },
          ],
        },
        {
          num_rows: 50n,
          columns: [
            {
              file_offset: 500n,
              meta_data: {
                path_in_schema: ['date'],
                num_values: 50n,
                total_compressed_size: 80n,
                data_page_offset: 500n,
                // All-null row group must NOT invalidate date bounds from row group 0.
                statistics: { null_count: 50n },
              },
            },
            {
              file_offset: 580n,
              meta_data: {
                path_in_schema: ['query'],
                num_values: 50n,
                total_compressed_size: 180n,
                data_page_offset: 580n,
                // Non-null row group missing min_value/max_value MUST drop query bounds.
                statistics: { null_count: 0n },
              },
            },
            {
              file_offset: 760n,
              meta_data: {
                path_in_schema: ['clicks'],
                num_values: 50n,
                total_compressed_size: 150n,
                data_page_offset: 760n,
                statistics: { min_value: 1n, max_value: 99n, null_count: 2n },
              },
            },
          ],
        },
      ],
    }

    const stats = extractParquetColumnStats(fileMeta, dataset.icebergSchema())
    // date (id 2): preserved across all-null RG1
    expect(stats.lowerBounds?.[2]).toBe(20_513)
    expect(stats.upperBounds?.[2]).toBe(20_520)
    expect(stats.nullValueCounts?.[2]).toBe(50n)
    // query (id 4): omitted because RG1 had non-null values without bounds
    expect(stats.lowerBounds?.[4]).toBeUndefined()
    expect(stats.upperBounds?.[4]).toBeUndefined()
    // clicks (id 5): merged across both RGs
    expect(stats.lowerBounds?.[5]).toBe(1n)
    expect(stats.upperBounds?.[5]).toBe(99n)
    expect(stats.columnSizes?.[5]).toBe(300n)
    expect(stats.valueCounts?.[5]).toBe(100n)
    expect(stats.nullValueCounts?.[5]).toBe(2n)
    expect(stats.splitOffsets).toEqual([4n, 500n])
  })
})

describe('validation errors for invalid descriptors, partitions, and columnStats', () => {
  it('rejects empty files and empty appendId before calling the catalog', async () => {
    const mock = createMockCatalog()

    expect(await dataset.registerParquetFiles(mock.conn, [], { appendId: 'ok' })).toMatchObject({
      _tag: 'Err',
      reason: 'empty-files',
    })
    expect(
      await dataset.registerParquetFiles(
        mock.conn,
        [{ path: 's3://b/f.parquet', fileSizeBytes: 10, recordCount: 1, partition: { site_id: 1, date_month: 674 } }],
        { appendId: '   ' },
      ),
    ).toMatchObject({
      _tag: 'Err',
      reason: 'invalid-append-id',
    })
    expect(mock.loads()).toBe(0)
  })

  it.each([
    ['zero fileSizeBytes', { path: 's3://b/a.parquet', fileSizeBytes: 0, recordCount: 10, partition: { site_id: 1, date_month: 674 } }],
    ['negative fileSizeBytes', { path: 's3://b/a.parquet', fileSizeBytes: -5, recordCount: 10, partition: { site_id: 1, date_month: 674 } }],
    ['fractional fileSizeBytes', { path: 's3://b/a.parquet', fileSizeBytes: 10.5, recordCount: 10, partition: { site_id: 1, date_month: 674 } }],
    ['zero recordCount', { path: 's3://b/a.parquet', fileSizeBytes: 100, recordCount: 0, partition: { site_id: 1, date_month: 674 } }],
    ['negative recordCount', { path: 's3://b/a.parquet', fileSizeBytes: 100, recordCount: -1, partition: { site_id: 1, date_month: 674 } }],
    ['empty path', { path: '', fileSizeBytes: 100, recordCount: 10, partition: { site_id: 1, date_month: 674 } }],
  ])('rejects invalid descriptor: %s', async (_label, badFile) => {
    const mock = createMockCatalog()
    const res = await dataset.registerParquetFiles(mock.conn, [badFile], { appendId: 'bad-desc' })
    expect(res).toMatchObject({ _tag: 'Err', reason: 'invalid-descriptor', fileIndex: 0 })
    expect(mock.loads()).toBe(0)
    expect(mock.commits()).toBe(0)
  })

  it('rejects duplicate file paths within a single registration batch', async () => {
    const mock = createMockCatalog()
    const dup = { path: 's3://b/dup.parquet', fileSizeBytes: 100, recordCount: 10, partition: { site_id: 1, date_month: 674 } }
    const res = await dataset.registerParquetFiles(mock.conn, [dup, { ...dup }], { appendId: 'dup-paths' })
    expect(res).toMatchObject({ _tag: 'Err', reason: 'invalid-descriptor', fileIndex: 1 })
    expect(mock.loads()).toBe(0)
  })

  it.each([
    ['missing date_month', { site_id: 1 }],
    ['missing site_id', { date_month: 674 }],
    ['null required site_id', { site_id: null, date_month: 674 }],
    ['string for int site_id', { site_id: '1', date_month: 674 }],
    ['out-of-range int32 site_id', { site_id: 2_147_483_648, date_month: 674 }],
    ['unknown extra partition key', { site_id: 1, date_month: 674, bogus: 99 }],
  ])('rejects invalid partition: %s', async (_label, partition) => {
    const mock = createMockCatalog()
    const res = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: 's3://b/p.parquet', fileSizeBytes: 100, recordCount: 10, partition }],
      { appendId: 'bad-part' },
    )
    expect(res).toMatchObject({ _tag: 'Err', reason: 'invalid-partition', fileIndex: 0 })
    expect(mock.manifestUploads()).toHaveLength(0)
    expect(mock.commits()).toBe(0)
  })

  it.each([
    ['unknown column name', { lowerBounds: { nonexistent: 1 } }],
    ['negative valueCount', { valueCounts: { clicks: -1 } }],
    ['NaN double bound', { lowerBounds: { position: Number.NaN } }],
    ['invalid calendar date', { lowerBounds: { date: '2026-02-30' } }],
    ['wrong-length raw int32 bytes', { lowerBounds: { site_id: new Uint8Array([1, 2]) } }],
    ['inverted lower > upper bounds', { lowerBounds: { clicks: 500n }, upperBounds: { clicks: 100n } }],
    ['inverted date bounds', { lowerBounds: { date: '2026-03-31' }, upperBounds: { date: '2026-03-01' } }],
  ])('rejects invalid columnStats: %s', async (_label, columnStats) => {
    const mock = createMockCatalog()
    const res = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: 's3://b/s.parquet', fileSizeBytes: 100, recordCount: 10, partition: { site_id: 1, date_month: 674 }, columnStats }],
      { appendId: 'bad-stats' },
    )
    expect(res).toMatchObject({ _tag: 'Err', reason: 'invalid-column-stats', fileIndex: 0 })
    expect(mock.manifestUploads()).toHaveLength(0)
    expect(mock.commits()).toBe(0)
  })

  it('rejects Iceberg v1 tables as unsupported-format', async () => {
    const mock = createMockCatalog({ metadata: { 'format-version': 1 } })
    const res = await dataset.registerParquetFiles(
      mock.conn,
      [{ path: 's3://b/v1.parquet', fileSizeBytes: 100, recordCount: 10, partition: { site_id: 1, date_month: 674 } }],
      { appendId: 'v1-table' },
    )
    expect(res).toMatchObject({ _tag: 'Err', reason: 'unsupported-format' })
    expect(mock.commits()).toBe(0)
  })
})
