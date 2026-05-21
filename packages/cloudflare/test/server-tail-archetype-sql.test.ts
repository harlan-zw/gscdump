import type {
  ArbitrarySqlQuery,
  EntityDailySparklineQuery,
  PresetAnalyzerQuery,
  SiteDailyTimeseriesQuery,
  TopNBreakdownQuery,
  TwoDimensionDetailQuery,
} from '@gscdump/sdk'
import { describe, expect, it } from 'vitest'
import { buildArchetypeSql, TABLE_PLACEHOLDER } from '../src/server-tail/archetype-sql'

const range = { start: '2026-01-01', end: '2026-03-31' }
const base = { siteId: 'site-1', searchType: 'web' as const, range }

describe('buildArchetypeSql', () => {
  it('site-daily-timeseries derives ctr/position from stored sums', () => {
    const q: SiteDailyTimeseriesQuery = {
      ...base,
      archetype: 'site-daily-timeseries',
      metrics: ['clicks', 'ctr', 'position'],
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('dates')
    expect(plan.sql).toContain('SUM(clicks) AS clicks')
    expect(plan.sql).toContain('SUM(clicks) / NULLIF(SUM(impressions), 0) AS ctr')
    expect(plan.sql).toContain('SUM(sum_position) / NULLIF(SUM(impressions), 0) AS position')
    expect(plan.sql).toContain('GROUP BY date')
    // partition-pruning prefix is 4 bound params
    expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31'])
    expect(plan.sql).toContain(TABLE_PLACEHOLDER)
  })

  it('top-n-breakdown maps page dimension to the url column', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'page',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('pages')
    expect(plan.sql).toContain('SELECT url,')
    expect(plan.sql).toContain('GROUP BY url')
    expect(plan.sql).toContain('ORDER BY SUM(clicks) DESC LIMIT 50')
    expect(plan.sql).not.toContain('OFFSET')
  })

  it('top-n-breakdown emits OFFSET when offset is set', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['impressions'],
      orderBy: { metric: 'impressions', dir: 'desc' },
      limit: 20,
      offset: 40,
    }
    expect(buildArchetypeSql(q).sql).toContain('LIMIT 20 OFFSET 40')
  })

  it('entity-daily-sparkline inlines the pre-resolved entity IN list (escaped)', () => {
    const q: EntityDailySparklineQuery = {
      ...base,
      archetype: 'entity-daily-sparkline',
      dimension: 'query',
      entities: ['nuxt seo', 'it\'s a trap'],
      metric: 'clicks',
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('queries')
    // single quote in the entity must be doubled
    expect(plan.sql).toContain('query IN (\'nuxt seo\', \'it\'\'s a trap\')')
    // entities are inlined, NOT bound params — only the 4 partition params bind
    expect(plan.params).toHaveLength(4)
  })

  it('entity-daily-sparkline rejects an empty entity list', () => {
    const q: EntityDailySparklineQuery = {
      ...base,
      archetype: 'entity-daily-sparkline',
      dimension: 'query',
      entities: [],
      metric: 'clicks',
    }
    expect(() => buildArchetypeSql(q)).toThrow(/resolver must pre-resolve/)
  })

  it('two-dimension-detail groups by url, query and applies a page prefilter', () => {
    const q: TwoDimensionDetailQuery = {
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks', 'impressions'],
      filter: { page: 'https://x.com/a' },
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 100,
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('page_queries')
    expect(plan.sql).toContain('GROUP BY url, query')
    expect(plan.sql).toContain('AND url = ?')
    expect(plan.params).toContain('https://x.com/a')
  })

  it('preset-analyzer striking-distance is GROUP BY + HAVING, no window fn', () => {
    const q: PresetAnalyzerQuery = {
      ...base,
      archetype: 'preset-analyzer',
      presetId: 'striking-distance',
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('page_queries')
    expect(plan.sql).toContain('HAVING')
    expect(plan.sql).not.toMatch(/OVER\s*\(/)
    expect(plan.sql).not.toContain('QUALIFY')
  })

  it('preset-analyzer rejects a non-R2-SQL-safe preset', () => {
    const q: PresetAnalyzerQuery = {
      ...base,
      archetype: 'preset-analyzer',
      presetId: 'cannibalization',
    }
    expect(() => buildArchetypeSql(q)).toThrow(/arbitrary-sql/)
  })

  it('arbitrary-sql is not translated here', () => {
    const q: ArbitrarySqlQuery = {
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT 1',
    }
    expect(() => buildArchetypeSql(q)).toThrow(/caller SQL/)
  })
})
