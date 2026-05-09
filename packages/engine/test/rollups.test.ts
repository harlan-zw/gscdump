import type { DataSource, Row, TableName } from '@gscdump/engine/contracts'
import type { RollupDef, RollupEngine } from '../src/rollups'
import { createIndexingMetadataStore, createSitemapStore } from '@gscdump/engine/entities'
import { decodeParquetToRows } from '@gscdump/engine/hyparquet'
import { describe, expect, it } from 'vitest'
import {
  dailyTotalsRollup,
  DEFAULT_ROLLUPS,
  indexingHealthRollup,
  indexingMetadataRollup,
  indexPercentRollup,
  rebuildRollups,
  rollupKey,
  rollupParquetKey,
  sitemapChanges28dRollup,
  sitemapHealthRollup,
  topCountries28dRollup,
  topKeywords28dParquetRollup,
  topPages28dRollup,
  weeklyTotalsRollup,
} from '../src/rollups'

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
      builtAt: 1_700_000_000_000,
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
      keywords: [{ date: '2026-04-10', impressions: 530, query: 'foo', clicks: 10, sum_position: 30 }],
      countries: [],
      devices: [],
      page_keywords: [],
    })

    await rebuildRollups({
      engine,
      dataSource: ds,
      builtAt: 1_700_000_000_000,
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
      keywords: [
        { date: '2026-04-10', impressions: 530 }, // 47% anonymized
        { date: '2026-04-11', impressions: 800 }, // 0% anonymized
      ],
      countries: [],
      devices: [],
      page_keywords: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      builtAt: 1_700_000_000_000,
    })) as Array<{ date: string, anonymizedImpressionsPct: number, impressions: number }>

    expect(result).toHaveLength(2)
    expect(result[0].date).toBe('2026-04-10')
    expect(result[0].anonymizedImpressionsPct).toBeCloseTo(0.47, 2)
    expect(result[1].anonymizedImpressionsPct).toBeCloseTo(0, 5)
  })

  it('clamps anonymizedImpressionsPct into [0, 1] (e.g. when keyword aggregation overshoots)', async () => {
    const engine = makeFakeEngine({
      pages: [{ date: '2026-04-10', clicks: 50, impressions: 1000, sum_position: 5000 }],
      keywords: [{ date: '2026-04-10', impressions: 1500 }],
      countries: [],
      devices: [],
      page_keywords: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      builtAt: 1_700_000_000_000,
    })) as Array<{ anonymizedImpressionsPct: number }>
    expect(result[0].anonymizedImpressionsPct).toBe(0)
  })

  it('returns 0 anonymization when total impressions is 0', async () => {
    const engine = makeFakeEngine({
      pages: [{ date: '2026-04-10', clicks: 0, impressions: 0, sum_position: 0 }],
      keywords: [],
      countries: [],
      devices: [],
      page_keywords: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await dailyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      builtAt: 1_700_000_000_000,
    })) as Array<{ anonymizedImpressionsPct: number }>
    expect(result[0].anonymizedImpressionsPct).toBe(0)
  })
})

describe('weeklyTotalsRollup', () => {
  it('forwards rows to payload coercing numeric types', async () => {
    const engine = makeFakeEngine({
      pages: [{ week: '2026-04-06', clicks: 100n, impressions: 500n, sum_position: 750 }],
      keywords: [],
      countries: [],
      devices: [],
      page_keywords: [],
    })
    const { ds: buildDs } = makeFakeDataSource()
    const result = (await weeklyTotalsRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: buildDs,
      builtAt: 1_700_000_000_000,
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
      builtAt: 1_700_000_000_000,
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
      builtAt: 1_700_000_000_000,
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
      builtAt: 1_700_000_000_000,
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
      builtAt: 1_700_000_000_000,
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
      keywords: [
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
    await expect(
      rebuildRollups({
        engine: makeFakeEngine({}),
        dataSource: ds,
        ctx: { userId: 'u1' },
        defs: [broken],
        now: () => 1_700_000_000_000,
      }),
    ).rejects.toThrow(/parquetColumns/)
  })
})

describe('indexingHealthRollup', () => {
  it('returns empty days when inspection parquet URI is unavailable', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexingHealthRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      builtAt: 1_700_000_000_000,
    })) as { days: unknown[] }
    expect(payload.days).toEqual([])
  })

  it('runs DuckDB SQL and projects per-day counts when URI is present', async () => {
    // DataSource with `uri` defined makes parquetUri() return a string.
    const { ds: base } = makeFakeDataSource()
    const ds: DataSource = { ...base, uri: (k: string) => `file://${k}` }
    let capturedSql = ''
    const engine: RollupEngine = {
      async runSQL(opts) {
        capturedSql = opts.sql
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
    }
    const payload = (await indexingHealthRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      builtAt: 1_700_000_000_000,
    })) as { days: Array<{ date: string, indexed_count: number, canonical_mismatches: number }> }
    expect(capturedSql).toContain('read_parquet(\'file://u_u1/s1/entities/inspections/index.parquet\')')
    expect(payload.days).toHaveLength(1)
    expect(payload.days[0].date).toBe('2026-04-10')
    expect(payload.days[0].indexed_count).toBe(7)
    expect(payload.days[0].canonical_mismatches).toBe(2)
  })
})

describe('indexPercentRollup', () => {
  it('returns zero totals when sitemap urls parquet URI is unavailable', async () => {
    const { ds } = makeFakeDataSource()
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      builtAt: 1_700_000_000_000,
    })) as { totalSitemapUrls: number, days: unknown[] }
    expect(payload.totalSitemapUrls).toBe(0)
    expect(payload.days).toEqual([])
  })

  it('computes per-day ratio from JOIN against pages parquet', async () => {
    const { ds: base } = makeFakeDataSource()
    const ds: DataSource = { ...base, uri: (k: string) => `file://${k}` }
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
    }
    const payload = (await indexPercentRollup.build({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
      dataSource: ds,
      builtAt: 1_700_000_000_000,
    })) as {
      totalSitemapUrls: number
      days: Array<{ date: string, clicked_urls: number, total_sitemap_urls: number, ratio: number }>
    }
    expect(payload.totalSitemapUrls).toBe(100)
    expect(payload.days).toHaveLength(2)
    expect(payload.days[0].ratio).toBeCloseTo(0.25)
    expect(payload.days[1].ratio).toBeCloseTo(0.5)
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
      builtAt: 1_700_000_000_000,
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
      builtAt,
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
      builtAt: 1_700_000_000_000,
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
    const engine = makeFakeEngine({} as Record<TableName, Row[]>)
    const payload = (await sitemapChanges28dRollup.build({
      engine,
      ctx,
      dataSource: ds,
      builtAt,
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
})
