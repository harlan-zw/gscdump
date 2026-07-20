// Unit tests for `sweepUncommittedOrphans` — the never-committed orphan
// sweep (R2-FIXES F2). No network: `icebird` is mocked. `s3` is a
// hand-rolled in-memory fake matching `SweepStorageClient` (structurally
// the same shape as Cloudflare's native `R2Bucket` binding).

import { describe, expect, it, vi } from 'vitest'

const restCatalogListTables = vi.fn()
const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird', () => ({
  icebergAppend: vi.fn(),
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  icebergManifests,
  restCatalogConnect: vi.fn(),
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables,
  restCatalogLoadTable,
  s3SignedResolver: vi.fn(),
}))

const { sweepUncommittedOrphans } = await import('../src/maintenance')
type SweepListedObject = import('../src/maintenance').SweepListedObject
type SweepStorageClient = import('../src/maintenance').SweepStorageClient

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'crawl' }
const BUCKET = 'gsc-team-t1-int'

function metadata(opts: { table: string, snapshots?: { id: number, files: string[] }[] }) {
  const snapshots = opts.snapshots ?? []
  return {
    'location': `s3://${BUCKET}/__r2_data_catalog/${opts.table}-abc123`,
    'current-snapshot-id': snapshots.length > 0 ? snapshots[snapshots.length - 1]!.id : null,
    'snapshots': snapshots.map(s => ({
      'snapshot-id': s.id,
      'manifest-list': `s3://${BUCKET}/__r2_data_catalog/${opts.table}-abc123/metadata/snap-${s.id}.avro`,
    })),
  }
}

/** Wires `icebergManifests` to return one manifest with an ADDED entry per file, keyed by snapshot id. */
function wireManifestsBySnapshot(bySnapshot: Record<number, string[]>) {
  icebergManifests.mockImplementation(async ({ snapshotId }: { snapshotId: number }) => {
    const files = bySnapshot[snapshotId] ?? []
    return [{
      url: 'manifest',
      entries: files.map(file_path => ({ status: 1, data_file: { content: 0, file_path } })),
    }]
  })
}

/** In-memory fake of `SweepStorageClient`. */
function fakeS3(objects: SweepListedObject[]): SweepStorageClient & { deletedKeys: string[][] } {
  const deletedKeys: string[][] = []
  return {
    deletedKeys,
    async list({ prefix }) {
      return { objects: objects.filter(o => o.key.startsWith(prefix)), truncated: false }
    },
    async delete(keys: string[]) {
      deletedKeys.push(keys)
    },
  }
}

const NOW = Date.parse('2026-07-03T00:00:00Z')
function hoursAgo(h: number): Date {
  return new Date(NOW - h * 60 * 60 * 1000)
}

const DATA_PREFIX = `__r2_data_catalog/pages-abc123/data/`

describe('sweepUncommittedOrphans', () => {
  it('fails closed: propagates a table-list failure and never calls s3.delete', async () => {
    restCatalogListTables.mockReset().mockRejectedValueOnce(new Error('catalog list failed'))
    const s3 = fakeS3([])
    await expect(sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET })).rejects.toThrow('catalog list failed')
    expect(s3.deletedKeys).toEqual([])
  })

  it('fails closed: propagates a table-load/manifest-walk failure and never calls s3.delete', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockRejectedValueOnce(new Error('load table failed'))
    const s3 = fakeS3([{ key: `${DATA_PREFIX}orphan.parquet`, uploaded: hoursAgo(100) }])
    await expect(sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })).rejects.toThrow('load table failed')
    expect(s3.deletedKeys).toEqual([])
  })

  it('fails closed: zero tables in scope no-ops rather than treating everything as orphaned', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([])
    const s3 = fakeS3([{ key: `${DATA_PREFIX}anything.parquet`, uploaded: hoursAgo(1000) }])
    const listSpy = vi.spyOn(s3, 'list')
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })
    expect(result).toMatchObject({ reason: 'zero-tables', deleted: [], candidateCount: 0 })
    expect(listSpy).not.toHaveBeenCalled()
    expect(s3.deletedKeys).toEqual([])
  })

  it('grace window: a recently-written orphan survives; an old one is deleted', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({ metadata: metadata({ table: 'pages', snapshots: [{ id: 1, files: [] }] }) })
    wireManifestsBySnapshot({ 1: [] })
    const s3 = fakeS3([
      { key: `${DATA_PREFIX}fresh.parquet`, uploaded: hoursAgo(1) }, // within default 48h grace
      { key: `${DATA_PREFIX}stale.parquet`, uploaded: hoursAgo(100) }, // past grace
    ])
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })
    expect(result.deleted).toEqual([`${DATA_PREFIX}stale.parquet`])
    expect(s3.deletedKeys).toEqual([[`${DATA_PREFIX}stale.parquet`]])
  })

  it('protects a file referenced ONLY by an older, still-retained (non-current) snapshot', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({
      metadata: metadata({
        table: 'pages',
        snapshots: [
          { id: 1, files: [`s3://${BUCKET}/${DATA_PREFIX}old-live.parquet`] },
          { id: 2, files: [] }, // current snapshot no longer references old-live.parquet
        ],
      }),
    })
    wireManifestsBySnapshot({
      1: [`s3://${BUCKET}/${DATA_PREFIX}old-live.parquet`],
      2: [],
    })
    const s3 = fakeS3([{ key: `${DATA_PREFIX}old-live.parquet`, uploaded: hoursAgo(100) }])
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })
    expect(result.deleted).toEqual([])
    expect(result.liveFileCount).toBeGreaterThan(0)
    expect(s3.deletedKeys).toEqual([])
  })

  it('cap: deletions are capped at maxDeletes, remainder left for next run', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({ metadata: metadata({ table: 'pages', snapshots: [{ id: 1, files: [] }] }) })
    wireManifestsBySnapshot({ 1: [] })
    const objects = Array.from({ length: 5 }, (_, i) => ({ key: `${DATA_PREFIX}orphan-${i}.parquet`, uploaded: hoursAgo(100) }))
    const s3 = fakeS3(objects)
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, maxDeletes: 2, now: () => NOW })
    expect(result.candidateCount).toBe(5)
    expect(result.deleted).toHaveLength(2)
    expect(result.cappedAtLimit).toBe(true)
    expect(s3.deletedKeys.flat()).toHaveLength(2)
  })

  it('dry-run: computes the candidate set but never calls s3.delete', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({ metadata: metadata({ table: 'pages', snapshots: [{ id: 1, files: [] }] }) })
    wireManifestsBySnapshot({ 1: [] })
    const s3 = fakeS3([{ key: `${DATA_PREFIX}orphan.parquet`, uploaded: hoursAgo(100) }])
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, dryRun: true, now: () => NOW })
    expect(result.dryRun).toBe(true)
    expect(result.deleted).toEqual([`${DATA_PREFIX}orphan.parquet`])
    expect(s3.deletedKeys).toEqual([])
  })

  it('never touches a key outside the table\'s own data prefix, even if the listing client returns one', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({ metadata: metadata({ table: 'pages', snapshots: [{ id: 1, files: [] }] }) })
    wireManifestsBySnapshot({ 1: [] })
    // A misbehaving list client returns a key that does NOT start with the
    // requested prefix — the defense-in-depth re-check must drop it.
    const s3: SweepStorageClient & { deletedKeys: string[][] } = {
      deletedKeys: [],
      async list() {
        return {
          objects: [
            { key: `${DATA_PREFIX}real-orphan.parquet`, uploaded: hoursAgo(100) },
            { key: `__r2_data_catalog/OTHER-TABLE/data/leaked.parquet`, uploaded: hoursAgo(100) },
          ],
          truncated: false,
        }
      },
      async delete(keys: string[]) {
        this.deletedKeys.push(keys)
      },
    }
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })
    expect(result.deleted).toEqual([`${DATA_PREFIX}real-orphan.parquet`])
  })

  it('skips a table whose location resolves into a different bucket, without scanning or deleting it', async () => {
    restCatalogListTables.mockReset().mockResolvedValueOnce([{ name: 'pages' }])
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({
      metadata: {
        'location': `s3://some-other-bucket/__r2_data_catalog/pages-abc123`,
        'current-snapshot-id': null,
        'snapshots': [],
      },
    })
    const s3 = fakeS3([{ key: `${DATA_PREFIX}anything.parquet`, uploaded: hoursAgo(1000) }])
    const listSpy = vi.spyOn(s3, 'list')
    const result = await sweepUncommittedOrphans({ conn: CONN, s3, bucket: BUCKET, now: () => NOW })
    expect(result.skippedTables).toEqual(['pages'])
    expect(result.scannedTables).toEqual([])
    expect(listSpy).not.toHaveBeenCalled()
    expect(s3.deletedKeys).toEqual([])
  })

  it('overlaps manifest reads up to the configured I/O bound', async () => {
    restCatalogLoadTable.mockReset().mockResolvedValueOnce({
      metadata: metadata({
        table: 'pages',
        snapshots: [1, 2, 3].map(id => ({ id, files: [] })),
      }),
    })
    let active = 0
    let maxActive = 0
    let release!: () => void
    let reachedTwo!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const twoActive = new Promise<void>((resolve) => {
      reachedTwo = resolve
    })
    icebergManifests.mockReset().mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      if (active === 2)
        reachedTwo()
      await gate
      active--
      return []
    })
    const s3 = fakeS3([])
    const pending = sweepUncommittedOrphans({
      conn: CONN,
      s3,
      bucket: BUCKET,
      tables: ['pages'],
      ioConcurrency: 2,
      now: () => NOW,
    })
    await twoActive
    expect(maxActive).toBe(2)
    release()
    await expect(pending).resolves.toMatchObject({ scannedTables: ['pages'] })
    expect(maxActive).toBe(2)
  })
})
