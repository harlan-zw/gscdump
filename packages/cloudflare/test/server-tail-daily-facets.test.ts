import type { ArchetypeQuery } from '@gscdump/contracts/archetypes'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { bindLiterals } from '@gscdump/engine/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildArchetypeSql, TABLE_PLACEHOLDER } from '../src/server-tail/archetype-sql'

const range = { start: '2026-01-01', end: '2026-01-02' }
const base = { siteId: 'site-1', searchType: 'web' as const, range }

// Site totals on `dates` exceed every faceted figure (anonymized impressions),
// so a compiler that drops the facet returns these totals and fails loudly.
const FIXTURE = [
  `CREATE OR REPLACE TABLE page_queries AS SELECT * FROM (VALUES
    (DATE '2026-01-01', '/a', 'nuxt seo', 5, 50, 0.0),
    (DATE '2026-01-01', '/a', 'sitemap', 2, 20, 0.0),
    (DATE '2026-01-01', '/b', 'nuxt seo', 3, 30, 0.0),
    (DATE '2026-01-02', '/a', 'nuxt seo', 4, 40, 0.0),
    (DATE '2026-01-02', '/b', 'sitemap', 7, 70, 0.0)
  ) t(date, url, query, clicks, impressions, sum_position)`,
  `CREATE OR REPLACE TABLE pages AS SELECT date, url, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(sum_position) AS sum_position FROM page_queries GROUP BY date, url`,
  `CREATE OR REPLACE TABLE queries AS SELECT date, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(sum_position) AS sum_position FROM page_queries GROUP BY date, query`,
  `CREATE OR REPLACE TABLE countries AS SELECT * FROM (VALUES
    (DATE '2026-01-01', 'usa', 6, 60, 0.0),
    (DATE '2026-01-01', 'deu', 4, 40, 0.0),
    (DATE '2026-01-02', 'usa', 9, 90, 0.0),
    (DATE '2026-01-02', 'deu', 2, 20, 0.0)
  ) t(date, country, clicks, impressions, sum_position)`,
  `CREATE OR REPLACE TABLE dates AS SELECT * FROM (VALUES
    (DATE '2026-01-01', 11, 110, 0.0),
    (DATE '2026-01-02', 12, 120, 0.0)
  ) t(date, clicks, impressions, sum_position)`,
  `CREATE OR REPLACE TABLE query_dim AS SELECT * FROM (VALUES
    ('nuxt seo', 'nuxt seo'),
    ('sitemap', 'sitemap')
  ) t(query, query_canonical)`,
]

const db = createNodeDuckDBHandle()

// The node handle returns DATE as epoch milliseconds and SUM(INTEGER) as bigint.
function plain(value: unknown, key: string): unknown {
  if (key === 'date')
    return new Date(Number(value)).toISOString().slice(0, 10)
  return typeof value === 'bigint' ? Number(value) : value
}

// The file-list executor path: partitions are pruned by file selection, so only
// the row-level date predicate is emitted, and `{{TABLE}}` names the fact table.
async function run(query: ArchetypeQuery): Promise<{ table: string, rows: Record<string, unknown>[] }> {
  const plan = buildArchetypeSql(query, { partitionPruned: true })
  const rows = await db.query(bindLiterals(plan.sql, plan.params).replaceAll(TABLE_PLACEHOLDER, plan.table))
  return {
    table: plan.table,
    rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value, key)]))),
  }
}

beforeAll(async () => {
  for (const statement of FIXTURE)
    await db.query(statement)
})

afterAll(() => {
  resetNodeDuckDB()
})

describe('server-tail daily archetypes apply facets', () => {
  it('site-daily-timeseries filters to a page', async () => {
    const result = await run({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
      facets: [{ column: 'page', op: 'eq', value: '/a' }],
    })
    expect(result.table).toBe('pages')
    expect(result.rows).toEqual([
      { date: '2026-01-01', clicks: 7 },
      { date: '2026-01-02', clicks: 4 },
    ])
  })

  it('site-daily-timeseries filters to a country', async () => {
    const result = await run({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
      facets: [{ column: 'country', op: 'eq', value: 'usa' }],
    })
    expect(result.table).toBe('countries')
    expect(result.rows).toEqual([
      { date: '2026-01-01', clicks: 6 },
      { date: '2026-01-02', clicks: 9 },
    ])
  })

  it('site-daily-timeseries applies a brand regex on queries', async () => {
    const result = await run({
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
      facets: [{ column: 'query', op: 'regex', value: 'nuxt' }],
    })
    expect(result.table).toBe('queries')
    expect(result.rows).toEqual([
      { date: '2026-01-01', clicks: 8 },
      { date: '2026-01-02', clicks: 4 },
    ])
  })

  it('entity-daily-timeseries combines the entity and a page facet on page_queries', async () => {
    const result = await run({
      ...base,
      archetype: 'entity-daily-timeseries',
      entity: { dimension: 'queryCanonical', value: 'nuxt seo' },
      metrics: ['clicks'],
      facets: [{ column: 'page', op: 'eq', value: '/a' }],
    })
    expect(result.table).toBe('page_queries')
    expect(result.rows).toEqual([
      { date: '2026-01-01', clicks: 5 },
      { date: '2026-01-02', clicks: 4 },
    ])
  })

  it('entity-daily-sparkline keeps only rows matching the facet', async () => {
    const result = await run({
      ...base,
      archetype: 'entity-daily-sparkline',
      dimension: 'query',
      entities: ['nuxt seo', 'sitemap'],
      metric: 'clicks',
      facets: [{ column: 'page', op: 'eq', value: '/b' }],
    })
    expect(result.table).toBe('page_queries')
    expect(result.rows).toEqual([
      { date: '2026-01-01', entity: 'nuxt seo', clicks: 3 },
      { date: '2026-01-02', entity: 'sitemap', clicks: 7 },
    ])
  })

  it('multi-series-stacked-daily splits pages for one query', async () => {
    const result = await run({
      ...base,
      archetype: 'multi-series-stacked-daily',
      seriesDimension: 'page',
      metric: 'clicks',
      facets: [{ column: 'query', op: 'eq', value: 'sitemap' }],
    })
    expect(result.table).toBe('page_queries')
    expect(result.rows).toEqual([
      { date: '2026-01-01', url: '/a', clicks: 2 },
      { date: '2026-01-02', url: '/b', clicks: 7 },
    ])
  })

  it.each([
    ['a country facet on a query entity', {
      ...base,
      archetype: 'entity-daily-timeseries',
      entity: { dimension: 'query', value: 'nuxt seo' },
      metrics: ['clicks'],
      facets: [{ column: 'country', op: 'eq', value: 'usa' }],
    }],
    ['a device facet', {
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks'],
      facets: [{ column: 'device', op: 'eq', value: 'MOBILE' }],
    }],
    ['a facet on a device series', {
      ...base,
      archetype: 'multi-series-stacked-daily',
      seriesDimension: 'device',
      metric: 'clicks',
      facets: [{ column: 'page', op: 'eq', value: '/a' }],
    }],
  ] as [string, ArchetypeQuery][])('refuses %s instead of returning unfiltered totals', (_name, query) => {
    expect(() => buildArchetypeSql(query)).toThrow(/facet/)
  })
})
