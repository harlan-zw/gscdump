import type { Row } from '@gscdump/contracts'
import type { InspectionEventRow, InspectionReadPlan } from '../src/entities'
import type { DataSource } from '../src/storage'
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import {
  createInspectionStore,
  hashUrl,
  INSPECTION_RETIRED_GRACE_MS,
  inspectionBaseKey,
  inspectionBaseManifestKey,
  inspectionBasesPrefix,
  inspectionEventsPrefix,
  resolveInspectionReadPlan,
} from '../src/entities'
import { createInMemoryDataSource } from './helpers/in-memory'

const ctx = { userId: 'u1', siteId: 's1' }

function event(url: string, inspectedAt: string, extra: Partial<InspectionEventRow> = {}): InspectionEventRow {
  return {
    urlHash: hashUrl(url),
    url,
    inspectedAt,
    indexStatus: 'PASS',
    lastCrawlTime: null,
    googleCanonical: null,
    userCanonical: null,
    coverageState: null,
    robotsTxtState: null,
    indexingState: null,
    pageFetchState: null,
    mobileUsabilityVerdict: null,
    richResultsVerdict: null,
    scheduleNextAt: null,
    scheduleConsecutiveUnchanged: null,
    schedulePolicyVersion: null,
    crawlingUserAgent: null,
    richResultsItems: null,
    sitemaps: null,
    referringUrls: null,
    mobileIssues: null,
    inspectionResultLink: null,
    firstCheckedAt: null,
    checkCount: null,
    nextCheckAfter: null,
    nextCheckPriority: null,
    canonicalMismatchKind: 'none',
    ...extra,
  }
}

function urls(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `https://e.com/${prefix}/${i}`)
}

function clock(start: number): { now: () => number, advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

/** Every event file a read must merge, in the documented order: plan first, then list. */
async function liveEventKeys(ds: DataSource, plan: InspectionReadPlan): Promise<string[]> {
  return (await ds.list(`${inspectionEventsPrefix(ctx)}/`))
    .filter(key => !plan.foldedEventKeys.has(key))
    .sort()
}

/** The rows one read sees: the planned base plus every live event file, newest wins per URL. */
async function readLatest(ds: DataSource): Promise<Map<string, string>> {
  const plan = await resolveInspectionReadPlan(ds, ctx)
  const files = [plan.base.key, ...await liveEventKeys(ds, plan)]
  const latest = new Map<string, Row>()
  for (const key of files) {
    const bytes = await ds.read(key).catch((error: Error) => {
      if (plan.base._tag === 'legacy' && key === plan.base.key && /not found/.test(error.message))
        return undefined
      throw error
    })
    for (const row of bytes ? await decodeParquetToRows(bytes) : []) {
      const prev = latest.get(String(row.url))
      if (!prev || String(row.inspectedAt) > String(prev.inspectedAt))
        latest.set(String(row.url), row)
    }
  }
  return new Map([...latest].map(([url, row]) => [url, String(row.indexStatus)]))
}

/**
 * Read a base the way DuckDB httpfs does: size and footer first, then each
 * column chunk by range at the offsets the footer named. `between` runs after
 * the footer read and before any column chunk read.
 */
async function rangeReadBase(ds: DataSource, key: string, between: () => Promise<void>): Promise<Row[]> {
  const byteLength = (await ds.read(key)).byteLength
  const file = {
    byteLength,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const bytes = await ds.read(key, { offset: start, length: (end ?? byteLength) - start })
      return bytes.slice().buffer
    },
  }
  const metadata = await parquetMetadataAsync(file, { initialFetchSize: 8 })
  await between()
  return await parquetReadObjects({ file, metadata }) as Row[]
}

describe('inspection base publication', () => {
  it('finishes a read on the base it resolved while a compaction publishes a new one', async () => {
    const ds = createInMemoryDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, urls(40, 'old').map(url => event(url, '2026-04-01T00:00:00Z')), { batchId: 'b1' })
    await inspector.compactInspections(ctx)

    const plan = await resolveInspectionReadPlan(ds, ctx)
    const expected = await decodeParquetToRows(await ds.read(plan.base.key))

    const rows = await rangeReadBase(ds, plan.base.key, async () => {
      await inspector.appendInspectionEvents(ctx, [
        ...urls(40, 'old').map(url => event(url, '2026-04-20T00:00:00Z', { indexStatus: 'FAIL', coverageState: 'Crawled - currently not indexed' })),
        ...urls(300, 'new').map(url => event(url, '2026-04-20T00:00:00Z')),
      ], { batchId: 'b2' })
      await inspector.compactInspections(ctx)
    })

    expect(rows.map(row => [row.url, row.indexStatus])).toEqual(expected.map(row => [row.url, row.indexStatus]))
    const after = await readLatest(ds)
    expect(after.size).toBe(340)
    expect(after.get('https://e.com/old/0')).toBe('FAIL')
  })

  it('hides folded event files from a read that resolves the new manifest', async () => {
    const ds = createInMemoryDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/a', '2026-04-01T00:00:00Z')], { batchId: 'b1' })
    const before = await resolveInspectionReadPlan(ds, ctx)

    await inspector.compactInspections(ctx)
    const after = await resolveInspectionReadPlan(ds, ctx)

    // The earlier plan still merges the event; the new plan reads it from the base.
    expect(await liveEventKeys(ds, before)).toHaveLength(1)
    expect(await liveEventKeys(ds, after)).toEqual([])
    expect(after.base._tag).toBe('published')
    expect(await readLatest(ds)).toEqual(new Map([['https://e.com/a', 'PASS']]))
  })

  it('reads a legacy in-place base until the first compaction publishes a manifest', async () => {
    const ds = createInMemoryDataSource()
    const legacyKey = inspectionBaseKey(ctx)
    await ds.write(legacyKey, encodeRowsToParquetFlex(
      [event('https://e.com/legacy', '2026-03-01T00:00:00Z', { indexStatus: 'NEUTRAL' })] as Row[],
      { columns: [
        { name: 'urlHash', type: 'VARCHAR', nullable: false },
        { name: 'url', type: 'VARCHAR', nullable: false },
        { name: 'inspectedAt', type: 'VARCHAR', nullable: false },
        { name: 'indexStatus', type: 'VARCHAR', nullable: true },
      ], sortKey: ['urlHash'] },
    ))
    const t = clock(Date.UTC(2026, 3, 1))
    const inspector = createInspectionStore({ dataSource: ds, now: t.now })

    const legacyPlan = await resolveInspectionReadPlan(ds, ctx)
    expect(legacyPlan.base).toEqual({ _tag: 'legacy', key: legacyKey })
    expect(await readLatest(ds)).toEqual(new Map([['https://e.com/legacy', 'NEUTRAL']]))

    await inspector.appendInspectionEvents(ctx, [event('https://e.com/b', '2026-04-01T00:00:00Z')], { batchId: 'b1' })
    await inspector.compactInspections(ctx)

    expect((await resolveInspectionReadPlan(ds, ctx)).base._tag).toBe('published')
    expect(await readLatest(ds)).toEqual(new Map([
      ['https://e.com/legacy', 'NEUTRAL'],
      ['https://e.com/b', 'PASS'],
    ]))
    // A read that resolved the legacy plan before the compaction still finds its base.
    expect(await decodeParquetToRows(await ds.read(legacyPlan.base.key))).toHaveLength(1)
  })

  it('deletes a superseded base and folded events only after the grace, never the current base', async () => {
    const ds = createInMemoryDataSource()
    const t = clock(Date.UTC(2026, 3, 1))
    const inspector = createInspectionStore({ dataSource: ds, now: t.now })
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/a', '2026-04-01T00:00:00Z')], { batchId: 'b1' })
    await inspector.compactInspections(ctx)
    const first = await resolveInspectionReadPlan(ds, ctx)
    const firstEvents = [...first.foldedEventKeys]

    t.advance(1000)
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/b', '2026-04-02T00:00:00Z')], { batchId: 'b2' })
    await inspector.compactInspections(ctx)
    const second = await resolveInspectionReadPlan(ds, ctx)
    expect(second.base.key).not.toBe(first.base.key)

    // One millisecond short of the grace since `first` was superseded.
    t.advance(INSPECTION_RETIRED_GRACE_MS - 1)
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/c', '2026-04-03T00:00:00Z')], { batchId: 'b3' })
    await inspector.compactInspections(ctx)
    expect(await decodeParquetToRows(await ds.read(first.base.key))).toHaveLength(1)

    t.advance(1)
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/d', '2026-04-04T00:00:00Z')], { batchId: 'b4' })
    const result = await inspector.compactInspections(ctx)

    const keys = new Set(ds.snapshot().keys())
    expect(keys.has(first.base.key)).toBe(false)
    for (const key of firstEvents)
      expect(keys.has(key)).toBe(false)
    expect(result.eventFilesDeleted).toBe(firstEvents.length)
    // The base `second` named was superseded less than a grace ago.
    expect(keys.has(second.base.key)).toBe(true)

    t.advance(10 * INSPECTION_RETIRED_GRACE_MS)
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/e', '2026-04-05T00:00:00Z')], { batchId: 'b5' })
    await inspector.compactInspections(ctx)
    const current = await resolveInspectionReadPlan(ds, ctx)
    expect(new Set(ds.snapshot().keys()).has(current.base.key)).toBe(true)
    expect([...(await readLatest(ds)).keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e'].map(p => `https://e.com/${p}`))
  })

  it('deletes a base an interrupted compaction never published, after the grace', async () => {
    const ds = createInMemoryDataSource()
    const t = clock(Date.UTC(2026, 3, 1))
    const inspector = createInspectionStore({ dataSource: ds, now: t.now })
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/a', '2026-04-01T00:00:00Z')], { batchId: 'b1' })
    const crashing = createInspectionStore({
      dataSource: { ...ds, async write(key, bytes) {
        if (key === inspectionBaseManifestKey(ctx))
          throw new Error('R2 PUT 503')
        return ds.write(key, bytes)
      } },
      now: t.now,
    })
    await expect(crashing.compactInspections(ctx)).rejects.toThrow(/503/)
    const basesPrefix = `${inspectionBasesPrefix(ctx)}/`
    const [orphan] = await ds.list(basesPrefix)
    expect(orphan).toBeDefined()

    await inspector.compactInspections(ctx)
    expect(await ds.list(basesPrefix)).toContain(orphan)

    t.advance(INSPECTION_RETIRED_GRACE_MS)
    await inspector.appendInspectionEvents(ctx, [event('https://e.com/b', '2026-04-02T00:00:00Z')], { batchId: 'b2' })
    await inspector.compactInspections(ctx)
    expect(await ds.list(basesPrefix)).not.toContain(orphan)
    expect(await readLatest(ds)).toEqual(new Map([['https://e.com/a', 'PASS'], ['https://e.com/b', 'PASS']]))
  })

  it.each([
    ['a base outside the tenant', { version: 1, baseKey: 'u_u2/s1/entities/inspections/bases/0000000000001__x.parquet', retired: [] }],
    ['a retired key outside the inspection files', { version: 1, baseKey: 'u_u1/s1/entities/inspections/bases/0000000000001__x.parquet', retired: [{ key: 'u_u1/s1/daily/2026-04-01.parquet', retiredAt: 1 }] }],
    ['an unknown version', { version: 2, baseKey: 'u_u1/s1/entities/inspections/bases/0000000000001__x.parquet', retired: [] }],
  ])('rejects a manifest that names %s', async (_label, manifest) => {
    const ds = createInMemoryDataSource()
    await ds.write(inspectionBaseManifestKey(ctx), new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(resolveInspectionReadPlan(ds, ctx)).rejects.toThrow(/inspection base manifest/)
  })
})
