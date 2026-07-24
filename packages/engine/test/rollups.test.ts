import type { DataSource, Row, TableName, TenantCtx } from '@gscdump/engine/contracts'
import type { CreateSitemapStoreOptions, ParsedUrl } from '@gscdump/engine/entities'
import type { RollupBucket, RollupDef, RollupEngine } from '../src/rollups'
import { createIndexingMetadataStore, createSitemapStore as createSitemapStoreImpl } from '@gscdump/engine/entities'
import { decodeParquetToRows } from '@gscdump/engine/hyparquet'
import { describe, expect, it } from 'vitest'
import {
  dailyTotalsRollup,
  DEFAULT_ROLLUPS,
  indexingHealthRollup,
  indexingMetadataRollup,
  indexPercentRollup,
  queryCanonicalDailyRollup,
  queryCanonicalVariantsRollup,
  readLatestRollup,
  rebuildRollups,
  ROLLUP_PAGE_ROWS,
  ROLLUP_PAGE_ROWS_DAILY,
  ROLLUP_PAGE_ROWS_WIDE,
  rollupKey,
  rollupParquetKey,
  runWindowed,
  sitemapChanges28dRollup,
  sitemapHealthRollup,
  topCountries28dRollup,
  topKeywords28dParquetRollup,
  topPages28dRollup,
  weeklyTotalsRollup,
} from '../src/rollups'

function createSitemapStore(opts: Omit<CreateSitemapStoreOptions, 'withMutation'>) {
  const store = createSitemapStoreImpl({ ...opts, withMutation: (_ctx, fn) => fn() })
  let sequence = 0
  return {
    ...store,
    snapshotUrls(ctx: TenantCtx, feedpath: string, urls: readonly ParsedUrl[]) {
      const observedAt = opts.now?.() ?? Date.now()
      return store.snapshotUrls(ctx, {
        _tag: 'complete',
        id: `test-${observedAt}-${sequence++}`,
        observedAt,
      }, feedpath, urls)
    },
  }
}

function makeFakeDataSource(): {
  ds: DataSource
  store: Map<string, Uint8Array>
} {
  const store = new Map<string, Uint8Array>()
  const ds: DataSource = {
    async read(key) {
      const b = store.get(key)
      if (!b)
        throw new Error(`not found: ${key}`)
      return b
    },
    async write(key, bytes) {
      store.set(key, bytes)
    },
    async delete(keys) {
      for (const k of keys) store.delete(k)
    },
    async list(prefix) {
      return Array.from(store.keys()).filter(k => k.startsWith(prefix))
    },
  }
  return { ds, store }
}

function makeFakeEngine(
  responses: Partial<Record<TableName, Row[]>>,
): RollupEngine {
  return {
    async runSQL({ table }) {
      const rows = responses[table as TableName] ?? []
      return { rows }
    },
    // Single recent partition near the tests' builtAt (1_700_000_000_000 ≈
    // 2023-11-14): windowed builders produce exactly ONE window and runSQL
    // (which ignores partitions in this fake) is called once — no dup rows.
    async listPartitions() {
      return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
    },
  }
}

describe('rollupKey', () => {
  it('encodes tenant + version', () => {
    expect(rollupKey({ userId: 'u1', siteId: 's1' }, 'daily_totals', 1700000000000))
      .toBe('u_u1/s1/rollups/daily_totals__v1700000000000.json')
  })

  it('drops siteId segment when omitted', () => {
    expect(rollupKey({ userId: 'u1' }, 'top_pages_28d', 1700000000000))
      .toBe('u_u1/rollups/top_pages_28d__v1700000000000.json')
  })

  it('namespaces non-web slices under a searchType segment; web stays at the legacy path', () => {
    expect(rollupKey({ userId: 'u1', siteId: 's1' }, 'daily_totals', 1700000000000, 'discover'))
      .toBe('u_u1/s1/rollups/discover/daily_totals__v1700000000000.json')
    expect(rollupKey({ userId: 'u1', siteId: 's1' }, 'daily_totals', 1700000000000, 'web'))
      .toBe('u_u1/s1/rollups/daily_totals__v1700000000000.json')
  })
})

describe('rebuildRollups searchType namespacing', () => {
  it('jSON-format envelope key honours opts.searchType (regression: was overwriting web)', async () => {
    const { ds, store } = makeFakeDataSource()
    const def: RollupDef = {
      id: 'json_def',
      windowDays: 7,
      async build() {
        return [{ a: 1 }]
      },
    }
    const results = await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [def],
      now: () => 1_700_000_000_000,
      searchType: 'discover',
    })
    expect(results[0].objectKey).toBe('u_u1/s1/rollups/discover/json_def__v1700000000000.json')
    expect(store.has(results[0].objectKey)).toBe(true)
    // Crucially, the legacy/web path must NOT have been written.
    expect(store.has('u_u1/s1/rollups/json_def__v1700000000000.json')).toBe(false)
  })

  it('builds a slice-orthogonal def at the legacy path even when searchType is passed', async () => {
    const { ds, store } = makeFakeDataSource()
    const orthogonalDef: RollupDef = {
      id: 'entity_def',
      windowDays: 90,
      sliceOrthogonal: true,
      async build() {
        return { days: [] }
      },
    }
    const sliceAwareDef: RollupDef = {
      id: 'slice_def',
      windowDays: 7,
      async build() {
        return [{ a: 1 }]
      },
    }
    const results = await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [orthogonalDef, sliceAwareDef],
      now: () => 1_700_000_000_000,
      searchType: 'discover',
    })
    expect(results.every(r => !r.error)).toBe(true)
    // Slice-orthogonal def lands at the legacy (non-namespaced) key.
    expect(store.has('u_u1/s1/rollups/entity_def__v1700000000000.json')).toBe(true)
    expect(store.has('u_u1/s1/rollups/discover/entity_def__v1700000000000.json')).toBe(false)
    // Slice-aware def in the same call lands under the discover/ segment.
    expect(store.has('u_u1/s1/rollups/discover/slice_def__v1700000000000.json')).toBe(true)
  })

  it('continues building other defs when one def throws; failing result carries error', async () => {
    const { ds, store } = makeFakeDataSource()
    const failingDef: RollupDef = {
      id: 'boom',
      windowDays: 7,
      async build() {
        throw new Error('build exploded')
      },
    }
    const okDef: RollupDef = {
      id: 'ok',
      windowDays: 7,
      async build() {
        return [{ a: 1 }]
      },
    }
    const results = await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [failingDef, okDef],
      now: () => 1_700_000_000_000,
    })
    expect(results).toHaveLength(2)
    const failed = results.find(r => r.id === 'boom')!
    const ok = results.find(r => r.id === 'ok')!
    expect(failed.error?.kind).toBe('rollup-build-failed')
    expect(failed.error?.message).toContain('build exploded')
    expect(ok.error).toBeUndefined()
    // The good def's envelope was still written despite the earlier failure.
    expect(store.has('u_u1/s1/rollups/ok__v1700000000000.json')).toBe(true)
  })
})

describe('rebuildRollups', () => {
  it('writes one envelope per def with version + builtAt + payload', async () => {
    const { ds, store } = makeFakeDataSource()
    let now = 1_000_000
    const def: RollupDef = {
      id: 'test',
      windowDays: 7,
      async build() {
        return [{ a: 1 }]
      },
    }

    const results = await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [def],
      now: () => now++,
    })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('test')
    expect(store.size).toBe(1)
    const bytes = store.get(results[0].objectKey)!
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    expect(parsed).toEqual({
      version: 1,
      id: 'test',
      builtAt: 1_000_000,
      windowDays: 7,
      payload: [{ a: 1 }],
    })
  })

  it('runs every default rollup against a fake engine without throwing', async () => {
    const { ds, store } = makeFakeDataSource()
    const engine = makeFakeEngine({
      pages: [{ date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 5000, week: '2026-04-06', url: '/x' }],
      queries: [{ date: '2026-04-10', impressions: 530, query: 'foo', clicks: 10, sum_position: 30 }],
      countries: [],
      dates: [],
      page_queries: [],
    })

    await rebuildRollups({
      engine,
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: DEFAULT_ROLLUPS,
      now: () => 1_700_000_000_000,
    })

    expect(store.size).toBe(DEFAULT_ROLLUPS.length)
    for (const def of DEFAULT_ROLLUPS) {
      const key = rollupKey({ userId: 'u1', siteId: 's1' }, def.id, 1_700_000_000_000)
      expect(store.get(key)).toBeDefined()
    }
  })
})

describe('dailyTotalsRollup', () => {
  it('computes anonymizedImpressionsPct from page-vs-keyword impression deltas', async () => {
    const engine = makeFakeEngine({
      pages: [
        { date: '2026-04-10', clicks: 50, impressions: 1000, sum_position: 5000 },
        { date: '2026-04-11', clicks: 60, impressions: 800, sum_position: 4000 },
      ],
      queries: [
        { date: '2026-04-10', impressions: 530 }, // 47% anonymized
        { date: '2026-04-11', impressions: 800 }, // 0% anonymized
      ],
      countries: [],
      dates: [],
      page_queries: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ date: string, anonymizedImpressionsPct: number, impressions: number }>

    expect(result).toHaveLength(2)
    expect(result[0].date).toBe('2026-04-10')
    expect(result[0].anonymizedImpressionsPct).toBeCloseTo(0.47, 2)
    expect(result[1].anonymizedImpressionsPct).toBeCloseTo(0, 5)
  })

  it('clamps anonymizedImpressionsPct into [0, 1] (e.g. when keyword aggregation overshoots)', async () => {
    const engine = makeFakeEngine({
      pages: [{ date: '2026-04-10', clicks: 50, impressions: 1000, sum_position: 5000 }],
      queries: [{ date: '2026-04-10', impressions: 1500 }],
      countries: [],
      dates: [],
      page_queries: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ anonymizedImpressionsPct: number }>
    expect(result[0].anonymizedImpressionsPct).toBe(0)
  })

  it('returns 0 anonymization when total impressions is 0', async () => {
    const engine = makeFakeEngine({
      pages: [{ date: '2026-04-10', clicks: 0, impressions: 0, sum_position: 0 }],
      queries: [],
      countries: [],
      dates: [],
      page_queries: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ anonymizedImpressionsPct: number }>
    expect(result[0].anonymizedImpressionsPct).toBe(0)
  })
})

describe('weeklyTotalsRollup', () => {
  it('forwards rows to payload coercing numeric types', async () => {
    const engine = makeFakeEngine({
      pages: [{ week: '2026-04-06', clicks: 100n, impressions: 500n, sum_position: 750 }],
      queries: [],
      countries: [],
      dates: [],
      page_queries: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await weeklyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ week: string, clicks: number, impressions: number }>
    expect(result[0].week).toBe('2026-04-06')
    expect(result[0].clicks).toBe(100)
    expect(result[0].impressions).toBe(500)
  })
})

describe('indexingMetadataRollup', () => {
  it('returns zeroed totals when the entity store is empty', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexingMetadataRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { totals: { urls: number, updates: number, removes: number }, days: unknown[] }
    expect(payload.totals.urls).toBe(0)
    expect(payload.totals.updates).toBe(0)
    expect(payload.totals.removes).toBe(0)
    expect(payload.days).toEqual([])
  })

  it('aggregates per-day counts and latest timestamps from the store', async () => {
    const { ds } = makeFakeDataSource()
    const store = createIndexingMetadataStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await store.writeBatch(ctx, [
      {
        url: 'https://example.com/a',
        capturedAt: '2026-04-22T00:00:00Z',
        latestUpdateAt: '2026-04-20T10:00:00Z',
      },
      {
        url: 'https://example.com/b',
        capturedAt: '2026-04-22T00:00:00Z',
        latestUpdateAt: '2026-04-20T11:00:00Z',
        latestRemoveAt: '2026-04-21T09:00:00Z',
      },
      {
        url: 'https://example.com/c',
        capturedAt: '2026-04-22T00:00:00Z',
        latestUpdateAt: '2026-04-22T05:00:00Z',
      },
    ])

    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexingMetadataRollup.build({
      engine,
      ctx,
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as {
      totals: { urls: number, updates: number, removes: number, latestUpdateAt: string | null, latestRemoveAt: string | null }
      days: Array<{ day: string, updates: number, removes: number }>
    }

    expect(payload.totals.urls).toBe(3)
    expect(payload.totals.updates).toBe(3)
    expect(payload.totals.removes).toBe(1)
    expect(payload.totals.latestUpdateAt).toBe('2026-04-22T05:00:00Z')
    expect(payload.totals.latestRemoveAt).toBe('2026-04-21T09:00:00Z')
    expect(payload.days).toEqual([
      { day: '2026-04-20', updates: 2, removes: 0 },
      { day: '2026-04-21', updates: 0, removes: 1 },
      { day: '2026-04-22', updates: 1, removes: 0 },
    ])
  })
})

describe('rebuildRollups dataEndDate anchoring', () => {
  function capturingDef(sink: { windowAnchorMs?: number }): RollupDef {
    return {
      id: 'capture',
      windowDays: 28,
      async build({ windowAnchorMs }) {
        sink.windowAnchorMs = windowAnchorMs
        return []
      },
    }
  }

  it('anchors windowAnchorMs to dataEndDate, not wall-clock build time', async () => {
    const { ds } = makeFakeDataSource()
    const sink: { windowAnchorMs?: number } = {}
    await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [capturingDef(sink)],
      dataEndDate: '2026-01-15',
      now: () => 1_900_000_000_000, // far-future wall clock — must be ignored
    })
    expect(sink.windowAnchorMs).toBe(Date.UTC(2026, 0, 15))
  })

  it('falls back to wall-clock build time when dataEndDate is omitted', async () => {
    const { ds } = makeFakeDataSource()
    const sink: { windowAnchorMs?: number } = {}
    await rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [capturingDef(sink)],
      now: () => 1_700_000_000_000,
    })
    expect(sink.windowAnchorMs).toBe(1_700_000_000_000)
  })

  it('rejects a malformed dataEndDate', async () => {
    const { ds } = makeFakeDataSource()
    await expect(rebuildRollups({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [capturingDef({})],
      dataEndDate: '2026/01/15',
    })).rejects.toThrow('dataEndDate must be ISO')
  })
})

describe('topPages28dRollup', () => {
  it('forwards top-N rows from the engine result', async () => {
    const engine = makeFakeEngine({
      pages: [
        { url: '/a', clicks: 100, impressions: 1000, sum_position: 5000 },
        { url: '/b', clicks: 50, impressions: 500, sum_position: 2500 },
      ],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await topPages28dRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ url: string, clicks: number }>
    expect(result).toHaveLength(2)
    expect(result[0].url).toBe('/a')
    expect(result[0].clicks).toBe(100)
  })
})

describe('topCountries28dRollup', () => {
  it('forwards top-N country rows from the engine result', async () => {
    const engine = makeFakeEngine({
      countries: [
        { country: 'usa', clicks: 200, impressions: 2000, sum_position: 10000 },
        { country: 'gbr', clicks: 80, impressions: 800, sum_position: 4000 },
      ],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await topCountries28dRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      windowAnchorMs: 1_700_000_000_000,
    })) as Array<{ country: string, clicks: number }>
    expect(result).toHaveLength(2)
    expect(result[0].country).toBe('usa')
    expect(result[0].clicks).toBe(200)
  })
})

describe('parquet rollups', () => {
  it('writes parquet bytes + JSON sidecar pointer', async () => {
    const { ds, store } = makeFakeDataSource()
    const engine = makeFakeEngine({
      queries: [
        { query: 'foo', clicks: 500, impressions: 5000, sum_position: 10000 },
        { query: 'bar', clicks: 100, impressions: 1000, sum_position: 5000 },
      ],
    })
    const results = await rebuildRollups({
      engine,
      dataSource: ds,
      ctx: { userId: 'u1', siteId: 's1' },
      defs: [topKeywords28dParquetRollup],
      now: () => 1_700_000_000_000,
    })

    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.parquetKey).toBe(rollupParquetKey({ userId: 'u1', siteId: 's1' }, 'top_keywords_28d_parquet', 1_700_000_000_000))
    expect(r.objectKey).toBe(rollupKey({ userId: 'u1', siteId: 's1' }, 'top_keywords_28d_parquet', 1_700_000_000_000))
    expect(r.parquetBytes).toBeGreaterThan(0)

    const envelope = JSON.parse(new TextDecoder().decode(store.get(r.objectKey)!))
    expect(envelope.version).toBe(1)
    expect(envelope.payload.parquetKey).toBe(r.parquetKey)
    expect(envelope.payload.rowCount).toBe(2)

    const rows = await decodeParquetToRows(store.get(r.parquetKey!)!)
    expect(rows).toHaveLength(2)
    expect(rows.map(x => x.query).sort()).toEqual(['bar', 'foo'])
  })

  it('throws if format=parquet def is missing parquetColumns', async () => {
    const { ds } = makeFakeDataSource()
    const broken: RollupDef = {
      id: 'broken',
      windowDays: 7,
      format: 'parquet',
      async build() {
        return []
      },
    }
    const results = await rebuildRollups({
      engine: makeFakeEngine({}),
      dataSource: ds,
      ctx: { userId: 'u1' },
      defs: [broken],
      now: () => 1_700_000_000_000,
    })
    expect(results).toHaveLength(1)
    expect(results[0].error?.message).toMatch(/parquetColumns/)
  })
})

describe('indexingHealthRollup', () => {
  it('returns empty days when inspection parquet sidecar is missing', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexingHealthRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { days: unknown[] }
    expect(payload.days).toEqual([])
  })

  it('runs DuckDB SQL via fileSets.keys when sidecar exists', async () => {
    // `head` returning truthy = sidecar present. Rollup routes the read
    // through `fileSets.keys` so the executor pre-fetches bytes — the SQL
    // template carries `{{INSPECTIONS}}`, never an inline URI.
    const { ds: base } = makeFakeDataSource()
    const ds: DataSource = { ...base, head: async () => ({ bytes: 1 }) }
    let capturedSql = ''
    let capturedFileSets: Record<string, { keys?: string[] }> | undefined
    const engine: RollupEngine = {
      async runSQL(opts) {
        capturedSql = opts.sql
        capturedFileSets = opts.fileSets as Record<string, { keys?: string[] }>
        return {
          rows: [
            {
              date: '2026-04-10',
              total_urls: 10,
              indexed_count: 7,
              soft_404: 1,
              redirect: 0,
              not_found: 1,
              mobile_passes: 6,
              rich_results_passes: 5,
              canonical_mismatches: 2,
            },
          ],
        }
      },
      async listPartitions() {
        return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
      },
    }
    const payload = (await indexingHealthRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { days: Array<{ date: string, indexed_count: number, canonical_mismatches: number }> }
    expect(capturedSql).toContain('read_parquet({{INSPECTIONS}}')
    expect(capturedSql).not.toContain('r2://')
    expect(capturedFileSets?.INSPECTIONS?.keys).toEqual(['u_u1/s1/entities/inspections/index.parquet'])
    expect(payload.days).toHaveLength(1)
    expect(payload.days[0].date).toBe('2026-04-10')
    expect(payload.days[0].indexed_count).toBe(7)
    expect(payload.days[0].canonical_mismatches).toBe(2)
  })
})

describe('indexPercentRollup', () => {
  it('returns zero totals when sitemap urls parquet is missing', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { totalSitemapUrls: number, days: unknown[] }
    expect(payload.totalSitemapUrls).toBe(0)
    expect(payload.days).toEqual([])
  })

  it('computes per-day ratio from JOIN against pages parquet', async () => {
    const { ds } = makeFakeDataSource()
    // At least one per-feedpath index file present → the rollup proceeds.
    await ds.write('u_u1/s1/entities/sitemaps/urls/by-feed/abc123/index.parquet', new Uint8Array([1]))
    const engine: RollupEngine = {
      async runSQL(opts) {
        // First call: numerator (per-day clicked URLs); second call: denominator
        if (opts.sql.includes('clicked_urls')) {
          return {
            rows: [
              { date: '2026-04-10', clicked_urls: 25 },
              { date: '2026-04-11', clicked_urls: 50 },
            ],
          }
        }
        return { rows: [{ total: 100 }] }
      },
      async listPartitions() {
        return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
      },
    }
    const payload = (await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as {
      totalSitemapUrls: number
      days: Array<{ date: string, clicked_urls: number, total_sitemap_urls: number, ratio: number }>
    }
    expect(payload.totalSitemapUrls).toBe(100)
    expect(payload.days).toHaveLength(2)
    expect(payload.days[0].ratio).toBeCloseTo(0.25)
    expect(payload.days[1].ratio).toBeCloseTo(0.5)
  })

  it('defaults omitted page-fact searchType to web instead of cross-type unioning', async () => {
    const { ds } = makeFakeDataSource()
    await ds.write('u_u1/s1/entities/sitemaps/urls/by-feed/abc123/index.parquet', new Uint8Array([1]))
    const listCalls: Parameters<RollupEngine['listPartitions']>[0][] = []
    const runCalls: Parameters<RollupEngine['runSQL']>[0][] = []
    const engine: RollupEngine = {
      async listPartitions(opts) {
        listCalls.push(opts)
        return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
      },
      async runSQL(opts) {
        runCalls.push(opts)
        return opts.sql.includes('clicked_urls')
          ? { rows: [] }
          : { rows: [{ total: 100 }] }
      },
    }

    await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })

    expect(listCalls[0]).toEqual(expect.objectContaining({ table: 'pages', searchType: 'web' }))
    const numerator = runCalls.find(call => call.fileSets.PAGES)
    const denominator = runCalls.find(call => !call.fileSets.PAGES)
    expect(numerator).toEqual(expect.objectContaining({ table: 'pages', searchType: 'web' }))
    expect(denominator).toEqual(expect.objectContaining({ table: 'pages' }))
    expect(denominator).not.toHaveProperty('searchType')
  })

  it('merges active sitemap deltas and excludes retired deltas from the denominator', async () => {
    const { ds } = makeFakeDataSource()
    const prefix = 'u_u1/s1/entities/sitemaps/urls'
    const feedpathHash = 'abc123'
    const indexKey = `${prefix}/by-feed/${feedpathHash}/index.parquet`
    const retiredDelta = `${prefix}/deltas/2026-07-24__${feedpathHash}__1753330000000__aaa.parquet`
    const activeDelta = `${prefix}/deltas/2026-07-24__${feedpathHash}__1753330000001__bbb.parquet`
    await ds.write(indexKey, new Uint8Array([1]))
    await ds.write(retiredDelta, new Uint8Array([2]))
    await ds.write(activeDelta, new Uint8Array([3]))
    await ds.write(`${prefix}/projection.json`, new TextEncoder().encode(JSON.stringify({
      version: 1,
      feeds: {
        [feedpathHash]: {
          compactedThrough: retiredDelta,
          publishedAt: 1_753_330_000_000,
        },
      },
    })))
    const runCalls: Parameters<RollupEngine['runSQL']>[0][] = []
    const engine: RollupEngine = {
      async runSQL(opts) {
        runCalls.push(opts)
        return opts.sql.includes('clicked_urls')
          ? { rows: [] }
          : { rows: [{ total: 1 }] }
      },
      async listPartitions() {
        return []
      },
    }

    await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_753_330_000_000,
    })

    for (const call of runCalls) {
      expect(call.fileSets.URLS_INDEX?.keys).toEqual([indexKey])
      expect(call.fileSets.URLS_DELTA?.keys).toEqual([activeDelta])
      expect(call.sql).toContain(`op IN ('added', 'removed')`)
    }
  })
})

describe('sitemapHealthRollup', () => {
  it('returns empty payload when sitemap index is empty', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await sitemapHealthRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { days: unknown[], feeds: unknown[] }
    expect(payload.days).toEqual([])
    expect(payload.feeds).toEqual([])
  })

  it('aggregates per-day feed counts and url totals', async () => {
    const { ds } = makeFakeDataSource()
    const store = createSitemapStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    // builtAt 2026-04-22; cutoff = 2026-01-22 (90d back). Use recent dates.
    const builtAt = new Date('2026-04-22T00:00:00Z').getTime()
    await store.writeSnapshot(ctx, [
      {
        path: 'https://x/sitemap-1.xml',
        capturedAt: '2026-04-20T00:00:00Z',
        urlCount: 100,
        errors: 1,
        warnings: 2,
        contentHash: 'abc',
        lastDownloaded: '2026-04-20T00:00:00Z',
      },
      {
        path: 'https://x/sitemap-2.xml',
        capturedAt: '2026-04-20T00:00:00Z',
        urlCount: 50,
        errors: 0,
        warnings: 1,
        contentHash: 'def',
      },
    ])
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await sitemapHealthRollup.build({
      engine,
      ctx,
      dataSource: ds,
      windowAnchorMs: builtAt,
    })) as {
      days: Array<{ day: string, feeds: number, total_urls: number, errors: number, warnings: number }>
      feeds: Array<{ path: string, urlCount: number }>
    }
    expect(payload.days).toHaveLength(1)
    expect(payload.days[0].day).toBe('2026-04-20')
    expect(payload.days[0].feeds).toBe(2)
    expect(payload.days[0].total_urls).toBe(150)
    expect(payload.days[0].errors).toBe(1)
    expect(payload.days[0].warnings).toBe(3)
    expect(payload.feeds).toHaveLength(2)
  })
})

describe('sitemapChanges28dRollup', () => {
  it('returns empty payload when no deltas exist', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await sitemapChanges28dRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    })) as { days: unknown[], topAdded: unknown[], topRemoved: unknown[] }
    expect(payload.days).toEqual([])
    expect(payload.topAdded).toEqual([])
    expect(payload.topRemoved).toEqual([])
  })

  it('aggregates added/removed counts per day per feedpath and emits top lists', async () => {
    const { ds } = makeFakeDataSource()
    const builtAt = new Date('2026-04-22T00:00:00Z').getTime()
    let nowMs = new Date('2026-04-20T00:00:00Z').getTime()
    const store = createSitemapStore({ dataSource: ds, now: () => nowMs })
    const ctx = { userId: 'u1', siteId: 's1' }
    // Snapshot 1: feed A with two URLs (both added).
    await store.snapshotUrls(ctx, 'https://x/a.xml', [
      { loc: 'https://x/a/1' },
      { loc: 'https://x/a/2' },
    ])
    // Snapshot 2 (next day): drop one URL, add another.
    nowMs = new Date('2026-04-21T00:00:00Z').getTime()
    await store.snapshotUrls(ctx, 'https://x/a.xml', [
      { loc: 'https://x/a/1' },
      { loc: 'https://x/a/3' },
    ])
    await store.compactUrls(ctx)
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await sitemapChanges28dRollup.build({
      engine,
      ctx,
      dataSource: ds,
      windowAnchorMs: builtAt,
    })) as {
      days: Array<{ day: string, feedpath: string, added: number, removed: number }>
      topAdded: Array<{ loc: string }>
      topRemoved: Array<{ loc: string }>
    }
    // Day 1: 2 added, 0 removed. Day 2: 1 added, 1 removed.
    expect(payload.days).toHaveLength(2)
    expect(payload.days[0]).toMatchObject({ day: '2026-04-20', added: 2, removed: 0 })
    expect(payload.days[1]).toMatchObject({ day: '2026-04-21', added: 1, removed: 1 })
    expect(payload.topAdded.length).toBeGreaterThan(0)
    // Most-recent-first: top added should start with /3 (added day 2).
    expect(payload.topAdded[0].loc).toBe('https://x/a/3')
    expect(payload.topRemoved[0].loc).toBe('https://x/a/2')
  })

  it('bounds recent URL lists while preserving complete daily counts', async () => {
    const { ds } = makeFakeDataSource()
    const capturedAt = new Date('2026-04-20T00:00:00Z').getTime()
    const store = createSitemapStore({ dataSource: ds, now: () => capturedAt })
    const ctx = { userId: 'u1', siteId: 's1' }
    await store.snapshotUrls(ctx, 'https://x/large.xml', Array.from({ length: 250 }, (_, i) => ({
      loc: `https://x/page/${i}`,
    })))
    await store.compactUrls(ctx)

    const payload = (await sitemapChanges28dRollup.build({
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      ctx,
      dataSource: ds,
      windowAnchorMs: new Date('2026-04-22T00:00:00Z').getTime(),
    })) as {
      days: Array<{ added: number, removed: number }>
      topAdded: Array<{ loc: string }>
      topRemoved: Array<{ loc: string }>
    }

    expect(payload.days).toEqual([expect.objectContaining({ added: 250, removed: 0 })])
    expect(payload.topAdded).toHaveLength(200)
    expect(payload.topRemoved).toEqual([])
  })
})

// A RollupBucket fake that mirrors the Cloudflare R2 cursor protocol: keys are
// served `pageSize` at a time, each truncated page carrying an opaque cursor.
function makePaginatedBucket(keys: string[], pageSize: number): RollupBucket & {
  listCalls: number
} {
  const store = new Map<string, string>()
  for (const k of keys) store.set(k, JSON.stringify({ version: 1, id: 'x', builtAt: 0, windowDays: null, payload: { key: k } }))
  const all = Array.from(store.keys())
  const bucket = {
    listCalls: 0,
    list(opts: { prefix: string, cursor?: string }) {
      bucket.listCalls++
      const matching = all.filter(k => k.startsWith(opts.prefix))
      const offset = opts.cursor ? Number(opts.cursor) : 0
      const page = matching.slice(offset, offset + pageSize)
      const nextOffset = offset + pageSize
      const truncated = nextOffset < matching.length
      return Promise.resolve({
        objects: page.map(key => ({ key })),
        truncated,
        cursor: truncated ? String(nextOffset) : undefined,
      })
    },
    get(key: string) {
      const text = store.get(key)
      return Promise.resolve(text ? { text: () => Promise.resolve(text) } : null)
    },
  }
  return bucket
}

describe('readLatestRollup', () => {
  it('returns null when no envelope exists for the (ctx, id) pair', async () => {
    const bucket = makePaginatedBucket([], 10)
    const got = await readLatestRollup(bucket, { userId: 'u1', siteId: 's1' }, 'daily_totals')
    expect(got).toBeNull()
  })

  it('happy path: resolves the newest envelope from a single list page', async () => {
    const ctx = { userId: 'u1', siteId: 's1' }
    const bucket = makePaginatedBucket([
      rollupKey(ctx, 'daily_totals', 1700000000000),
      rollupKey(ctx, 'daily_totals', 1700000005000),
      rollupKey(ctx, 'daily_totals', 1700000002000),
    ], 50)
    const got = await readLatestRollup<{ key: string }>(bucket, ctx, 'daily_totals')
    expect(got).not.toBeNull()
    expect(got!.payload.key).toBe(rollupKey(ctx, 'daily_totals', 1700000005000))
  })

  it('ignores envelopes for a different rollup id', async () => {
    const ctx = { userId: 'u1', siteId: 's1' }
    const bucket = makePaginatedBucket([
      rollupKey(ctx, 'daily_totals', 1700000000000),
      rollupKey(ctx, 'top_pages_28d', 1700000009000),
    ], 50)
    const got = await readLatestRollup<{ key: string }>(bucket, ctx, 'daily_totals')
    expect(got!.payload.key).toBe(rollupKey(ctx, 'daily_totals', 1700000000000))
  })

  it('finds the newest envelope when it appears only on the 2nd list page', async () => {
    const ctx = { userId: 'u1', siteId: 's1' }
    // Page size 2: the newest (highest ts) key sorts last, so a single
    // un-paginated list call would never see it.
    const keys = [
      rollupKey(ctx, 'daily_totals', 1700000000001),
      rollupKey(ctx, 'daily_totals', 1700000000002),
      rollupKey(ctx, 'daily_totals', 1700000000003),
      rollupKey(ctx, 'daily_totals', 1700000000099),
    ]
    const bucket = makePaginatedBucket(keys, 2)
    const got = await readLatestRollup<{ key: string }>(bucket, ctx, 'daily_totals')
    expect(bucket.listCalls).toBeGreaterThan(1)
    expect(got!.payload.key).toBe(rollupKey(ctx, 'daily_totals', 1700000000099))
  })

  it('scopes the prefix to the searchType segment for non-web slices', async () => {
    const ctx = { userId: 'u1', siteId: 's1' }
    const bucket = makePaginatedBucket([
      rollupKey(ctx, 'daily_totals', 1700000000000),
      rollupKey(ctx, 'daily_totals', 1700000000050, 'discover'),
    ], 50)
    const web = await readLatestRollup<{ key: string }>(bucket, ctx, 'daily_totals', 'web')
    const discover = await readLatestRollup<{ key: string }>(bucket, ctx, 'daily_totals', 'discover')
    expect(web!.payload.key).toBe(rollupKey(ctx, 'daily_totals', 1700000000000))
    expect(discover!.payload.key).toBe(rollupKey(ctx, 'daily_totals', 1700000000050, 'discover'))
  })
})

describe('rebuildRollups idempotency', () => {
  it('re-running with identical inputs overwrites cleanly and produces identical output', async () => {
    const ctx = { userId: 'u1', siteId: 's1' }
    const def: RollupDef = {
      id: 'idem',
      windowDays: 7,
      async build() {
        return [{ a: 1, b: 'x' }]
      },
    }
    const opts = {
      engine: makeFakeEngine({} as Record<TableName, Row[]>),
      ctx,
      defs: [def],
      now: () => 1_700_000_000_000,
    }

    const first = makeFakeDataSource()
    const r1 = await rebuildRollups({ ...opts, dataSource: first.ds, windowAnchorMs: 1_700_000_000_000 })

    const second = makeFakeDataSource()
    const r2 = await rebuildRollups({ ...opts, dataSource: second.ds, windowAnchorMs: 1_700_000_000_000 })

    expect(r1).toEqual(r2)
    // Same key written, store has exactly one object, identical bytes.
    expect(r1[0].objectKey).toBe(r2[0].objectKey)
    expect(first.store.size).toBe(1)
    expect(second.store.size).toBe(1)
    expect(first.store.get(r1[0].objectKey)).toEqual(second.store.get(r2[0].objectKey))

    // Re-run a second time against the SAME store: overwrites in place, no
    // duplicate object, byte-identical envelope.
    const before = new TextDecoder().decode(first.store.get(r1[0].objectKey)!)
    const r3 = await rebuildRollups({ ...opts, dataSource: first.ds, windowAnchorMs: 1_700_000_000_000 })
    expect(r3).toEqual(r1)
    expect(first.store.size).toBe(1)
    expect(new TextDecoder().decode(first.store.get(r3[0].objectKey)!)).toBe(before)
  })
})

describe('rollup output pagination (bounds each runSQL/IPC payload by GROUP cardinality)', () => {
  // SQL-aware fake: honours the `LIMIT <n> OFFSET <m>` that runPagedQuery
  // appends, so we can prove paging reassembles the full set AND that every
  // single runSQL stays under the page cap. The fake ignores the aggregation
  // body and paginates a pre-shaped result set — the SUT under test is the
  // paging control flow, not DuckDB.
  function makePagingEngine(dataset: Row[]): { engine: RollupEngine, calls: Array<{ sql: string, returned: number }> } {
    const calls: Array<{ sql: string, returned: number }> = []
    const engine: RollupEngine = {
      async runSQL({ sql }) {
        const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)
        const rows = m ? dataset.slice(Number(m[2]), Number(m[2]) + Number(m[1])) : dataset
        calls.push({ sql, returned: rows.length })
        return { rows }
      },
      // One recent partition → planRollupWindows yields exactly one window.
      async listPartitions() {
        return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
      },
    }
    return { engine, calls }
  }

  it('runWindowed({ paginate }) pages a window by its key until a short page, concatenating all rows in order', async () => {
    const dataset: Row[] = Array.from({ length: 120_000 }, (_, i) => ({ k: i }))
    const { engine, calls } = makePagingEngine(dataset)
    const rows = await runWindowed({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'queries',
      sqlFor: () => 'SELECT k FROM read_parquet({{FILES}}) GROUP BY k',
      paginate: { orderBy: 'k', pageRows: 50_000 },
    })
    // All rows reassembled, in order, no gaps/dupes.
    expect(rows.length).toBe(120_000)
    expect((rows[0] as { k: number }).k).toBe(0)
    expect((rows[119_999] as { k: number }).k).toBe(119_999)
    // 3 pages: 50k, 50k, 20k — the short final page ends the loop.
    expect(calls.map(c => c.returned)).toEqual([50_000, 50_000, 20_000])
    expect(calls.every(c => c.returned <= 50_000)).toBe(true)
    // The appended clause carried the total-order key + offset paging.
    expect(calls[0]!.sql).toContain('ORDER BY k')
    expect(calls[0]!.sql).toContain('LIMIT 50000 OFFSET 0')
    expect(calls[1]!.sql).toContain('OFFSET 50000')
  })

  it('runWindowed without paginate keeps the single-call behaviour (regression)', async () => {
    const dataset: Row[] = Array.from({ length: 5 }, (_, i) => ({ k: i }))
    const { engine, calls } = makePagingEngine(dataset)
    const rows = await runWindowed({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      table: 'queries',
      sqlFor: () => 'SELECT k FROM read_parquet({{FILES}}) GROUP BY k',
    })
    expect(rows.length).toBe(5)
    expect(calls.length).toBe(1)
    expect(calls[0]!.sql).not.toContain('OFFSET')
  })

  it('queryCanonicalDailyRollup.build pages output by (date, query_canonical) — GSCDUMP-P regression', async () => {
    const { ds } = makeFakeDataSource() // empty store → no query dim → useDim=false
    const n = ROLLUP_PAGE_ROWS_DAILY + 1234 // forces a second page
    const dataset: Row[] = Array.from({ length: n }, (_, i) => ({
      query_canonical: `c${i}`,
      date: '2023-11-10',
      clicks: 1,
      impressions: 10,
      sum_position: 5,
    }))
    const { engine, calls } = makePagingEngine(dataset)
    const out = await queryCanonicalDailyRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      windowAnchorMs: 1_700_000_000_000,
    }) as Array<{ query_canonical: string }>
    expect(out.length).toBe(n)
    expect(calls.length).toBe(Math.ceil(n / ROLLUP_PAGE_ROWS_DAILY))
    expect(calls.every(c => c.returned <= ROLLUP_PAGE_ROWS_DAILY)).toBe(true)
    expect(calls[0]!.sql).toContain('ORDER BY date, query_canonical')
  })

  // Keyset-aware fake: returns the next page of per-variant rows AFTER the
  // `query > '<cursor>'` predicate (sorted by query), emulating the clusterKey
  // pruning the real engine gets — so the build's keyset loop terminates.
  function makeKeysetEngine(dataset: Row[]): { engine: RollupEngine, calls: Array<{ sql: string, returned: number }> } {
    const calls: Array<{ sql: string, returned: number }> = []
    const sorted = [...dataset].sort((a, b) => String(a.query).localeCompare(String(b.query)))
    const engine: RollupEngine = {
      async runSQL({ sql }) {
        const lim = /LIMIT (\d+)/.exec(sql)
        const limit = lim ? Number(lim[1]) : sorted.length
        const cur = /query > '([^']*)'/.exec(sql)
        const cursor = cur ? cur[1] : null
        const filtered = cursor === null ? sorted : sorted.filter(r => String(r.query) > cursor)
        const rows = filtered.slice(0, limit)
        calls.push({ sql, returned: rows.length })
        return { rows }
      },
      async listPartitions() {
        return [{ partition: 'daily/2023-11-10', bytes: 1000 }]
      },
    }
    return { engine, calls }
  }

  it('queryCanonicalVariantsRollup.build keyset-pages per-variant by query + regroups canonicals across page boundaries', async () => {
    // Per-variant rows (one per distinct query); two canonicals interleaved so
    // each canonical's variants STRADDLE the 20k page boundary — proves the JS
    // regroup reassembles a canonical that was split across pages.
    const total = ROLLUP_PAGE_ROWS_WIDE + 50 // forces a 2nd page
    const dataset: Row[] = Array.from({ length: total }, (_, i) => ({
      joinKey: i % 2 === 0 ? 'ca' : 'cb',
      query: `q${String(i).padStart(7, '0')}`,
      clicks: total - i, // distinct, descending → deterministic ranking
      impressions: 100,
      sum_pos: 100, // position = 100/100 + 1 = 2.0
    }))
    const { engine, calls } = makeKeysetEngine(dataset)
    const out = await queryCanonicalVariantsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: makeFakeDataSource().ds,
      windowAnchorMs: 1_700_000_000_000,
    }) as Array<{ joinKey: string, variantCount: bigint, canonicalName: string | null, variants: string | null }>
    // KEYSET paging by query (not OFFSET, not the derived joinKey), exactly 2 pages.
    expect(calls[0]!.sql).toContain('ORDER BY q.query')
    expect(calls[0]!.sql).not.toContain('OFFSET')
    expect(calls.length).toBe(2)
    expect(calls.every(c => c.returned <= ROLLUP_PAGE_ROWS_WIDE)).toBe(true)
    // Two canonicals reassembled from variants interleaved across both pages.
    expect(out.length).toBe(2)
    const ca = out.find(r => r.joinKey === 'ca')!
    expect(Number(ca.variantCount)).toBe(Math.ceil(total / 2))
    // Top variant by clicks is the lowest index (q0000000, clicks=total).
    expect(ca.canonicalName).toBe('q0000000')
    const terms = ca.variants!.split('||')
    expect(terms.length).toBe(10) // top-10 only
    expect(terms[0]).toBe(`q0000000:::${total}:::100:::2.0`)
  })

  it('ranks canonical variants by clicks then query before filtering zero-impression rows', async () => {
    const dataset: Row[] = Array.from({ length: 12 }, (_, i) => ({
      joinKey: 'canonical',
      query: `q${String(i).padStart(2, '0')}`,
      clicks: 10,
      impressions: i === 0 ? 0 : 100,
      sum_pos: 100,
    }))
    const { engine } = makeKeysetEngine(dataset)
    const [result] = await queryCanonicalVariantsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: makeFakeDataSource().ds,
      windowAnchorMs: 1_700_000_000_000,
    }) as Array<{ variantCount: bigint, canonicalName: string | null, variants: string | null }>

    expect(result?.variantCount).toBe(12n)
    expect(result?.canonicalName).toBe('q00')
    expect(result?.variants?.split('||').map(value => value.split(':::')[0])).toEqual([
      'q01',
      'q02',
      'q03',
      'q04',
      'q05',
      'q06',
      'q07',
      'q08',
      'q09',
    ])
  })
})

describe('rollup page-row caps fit the duckdb-worker result budget', () => {
  // The duckdb service worker (workers/duckdb) rejects a runSQL whose estimate
  // `rows × cols × WORKER_COL_BYTES` exceeds its WORKER_MAX_RESULT_BYTES budget.
  // The estimate is PESSIMISTIC (fixed bytes/col, not real width), so a page-row
  // cap must be sized against it, not the real payload — 90k daily rows tripped it
  // (5 cols × 64 × 90k = 28.8MB > 24MB) on a high-cardinality site (comparaja.pt).
  const WORKER_MAX_RESULT_BYTES = 24 * 1024 * 1024
  const WORKER_COL_BYTES = 64
  const estimate = (rows: number, cols: number) => rows * cols * WORKER_COL_BYTES

  it('daily canonical page (5 cols) stays under the worker budget', () => {
    // SELECT query_canonical, date, clicks, impressions, sum_position
    expect(estimate(ROLLUP_PAGE_ROWS_DAILY, 5)).toBeLessThan(WORKER_MAX_RESULT_BYTES)
  })

  it('wide variants page (5 cols) stays under the worker budget', () => {
    // SELECT joinKey, query, clicks, impressions, sum_pos
    expect(estimate(ROLLUP_PAGE_ROWS_WIDE, 5)).toBeLessThan(WORKER_MAX_RESULT_BYTES)
  })

  it('narrow page stays under the worker budget up to ~7 columns', () => {
    expect(estimate(ROLLUP_PAGE_ROWS, 7)).toBeLessThan(WORKER_MAX_RESULT_BYTES)
  })
})
