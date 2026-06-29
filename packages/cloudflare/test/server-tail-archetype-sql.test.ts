import type {
  ArbitrarySqlQuery,
  EntityDailySparklineQuery,
  MultiSeriesStackedDailyQuery,
  SiteDailyTimeseriesQuery,
  TopNBreakdownQuery,
  TwoDimensionDetailQuery,
} from '@gscdump/contracts/archetypes'
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
    // ORDER BY the selected alias, NOT a recomputed aggregate (R2 SQL / DataFusion
    // rejects a duplicate unqualified field name otherwise — error 40004).
    expect(plan.sql).toContain('ORDER BY clicks DESC LIMIT 50')
    expect(plan.sql).not.toContain('ORDER BY SUM(')
    expect(plan.sql).not.toContain('OFFSET')
  })

  it('top-n-breakdown selects the order metric so ORDER BY can reference its alias', () => {
    // order by a metric NOT in the projection — it must be added to the SELECT
    // (else `ORDER BY impressions` references a non-existent column).
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'impressions', dir: 'desc' },
      limit: 10,
    }
    const plan = buildArchetypeSql(q)
    expect(plan.sql).toContain('SUM(impressions) AS impressions')
    expect(plan.sql).toContain('ORDER BY impressions DESC')
    expect(plan.sql).not.toContain('ORDER BY SUM(')
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

  it('top-n-breakdown over device reads the dates pivot columns', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'device',
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 3,
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('dates')
    expect(plan.sql).toContain('UNION ALL')
    expect(plan.sql).toContain('SUM(clicks_desktop) AS clicks')
    expect(plan.sql).toContain('SUM(impressions_mobile) AS impressions')
    expect(plan.sql).toContain('SUM(sum_position_tablet) / NULLIF(SUM(impressions_tablet), 0) AS position')
    expect(plan.sql).toContain('ORDER BY clicks DESC LIMIT 3')
    expect(plan.params).toHaveLength(12)
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

  it('top-n-breakdown applies a brand regex facet as regexp_matches on the query column', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'query', op: 'regex', value: '(nuxt seo)' }],
    }
    const plan = buildArchetypeSql(q)
    expect(plan.sql).toContain('regexp_matches(LOWER(query), ?)')
    expect(plan.sql).not.toContain('NOT regexp_matches')
    // facet param binds AFTER the 4 partition params; LIMIT is inlined, not bound.
    expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31', '(nuxt seo)'])
    // facet predicate sits in the WHERE, before GROUP BY.
    expect(plan.sql.indexOf('regexp_matches')).toBeLessThan(plan.sql.indexOf('GROUP BY'))
  })

  it('top-n-breakdown negates a notRegex (non-brand) facet', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'query', op: 'notRegex', value: '(nuxt seo)' }],
    }
    expect(buildArchetypeSql(q).sql).toContain('NOT regexp_matches(LOWER(query), ?)')
  })

  it('top-n-breakdown applies an eq facet as an equality predicate', () => {
    const q: TopNBreakdownQuery = {
      ...base,
      archetype: 'top-n-breakdown',
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'country', op: 'eq', value: 'ind' }],
    }
    const plan = buildArchetypeSql(q)
    expect(plan.sql).toContain('country = ?')
    expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31', 'ind'])
  })

  it('two-dimension-detail applies a facet after the page/query prefilter', () => {
    const q: TwoDimensionDetailQuery = {
      ...base,
      archetype: 'two-dimension-detail',
      metrics: ['clicks'],
      filter: { page: 'https://x.com/a' },
      facets: [{ column: 'query', op: 'regex', value: '(brand)' }],
    }
    const plan = buildArchetypeSql(q)
    expect(plan.sql).toContain('AND url = ?')
    expect(plan.sql).toContain('regexp_matches(LOWER(query), ?)')
    // page prefilter param precedes the facet param.
    expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31', 'https://x.com/a', '(brand)'])
  })

  it('multi-series-stacked-daily over device reads the dates pivot columns', () => {
    const q: MultiSeriesStackedDailyQuery = {
      ...base,
      archetype: 'multi-series-stacked-daily',
      seriesDimension: 'device',
      metric: 'clicks',
    }
    const plan = buildArchetypeSql(q)
    expect(plan.table).toBe('dates')
    expect(plan.sql).toContain('UNION ALL')
    expect(plan.sql).toContain('SUM(clicks_desktop) AS clicks')
    expect(plan.sql).toContain('GROUP BY date')
    expect(plan.sql).toContain('ORDER BY date ASC, device ASC')
    expect(plan.params).toHaveLength(12)
  })

  it('arbitrary-sql is not translated here', () => {
    const q: ArbitrarySqlQuery = {
      ...base,
      archetype: 'arbitrary-sql',
      sql: 'SELECT 1',
    }
    expect(() => buildArchetypeSql(q)).toThrow(/caller SQL/)
  })

  describe('partitionPruned (DuckDB file-list path)', () => {
    // The file-list executor reads raw Iceberg parquet via read_parquet([...]);
    // site_id / search_type are identity-partition columns NOT materialized in
    // the data files, so the predicate must collapse to the date range only —
    // else DuckDB fails with `Referenced column "site_id" not found`.
    it('drops the site_id/search_type predicate, keeping only the date range', () => {
      const q: SiteDailyTimeseriesQuery = {
        ...base,
        archetype: 'site-daily-timeseries',
        metrics: ['clicks'],
      }
      const plan = buildArchetypeSql(q, { partitionPruned: true })
      expect(plan.sql).toContain('WHERE date BETWEEN ? AND ?')
      expect(plan.sql).not.toContain('site_id')
      expect(plan.sql).not.toContain('search_type')
      // params drop siteId + searchType, leaving start/end only
      expect(plan.params).toEqual(['2026-01-01', '2026-03-31'])
    })

    it('keeps the full partition predicate by default (R2 SQL catalog path)', () => {
      const q: SiteDailyTimeseriesQuery = {
        ...base,
        archetype: 'site-daily-timeseries',
        metrics: ['clicks'],
      }
      expect(buildArchetypeSql(q).sql).toContain('site_id = ?')
      expect(buildArchetypeSql(q).params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31'])
    })

    it('can emit legacy string R2 SQL CONCAT predicates by encoding', () => {
      const q: SiteDailyTimeseriesQuery = {
        ...base,
        archetype: 'site-daily-timeseries',
        metrics: ['clicks'],
      }
      const plan = buildArchetypeSql(q, { partitionKeyEncoding: 'string' })
      expect(plan.sql).toContain('CONCAT(site_id, \'\') = ?')
      expect(plan.sql).toContain('CONCAT(search_type, \'\') = ?')
      expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31'])
    })

    it('can emit R2 SQL CONCAT predicates without client-side rewriting', () => {
      const q: SiteDailyTimeseriesQuery = {
        ...base,
        archetype: 'site-daily-timeseries',
        metrics: ['clicks'],
      }
      const plan = buildArchetypeSql(q, { partitionPredicateMode: 'r2-sql-concat' })
      expect(plan.sql).toContain('CONCAT(site_id, \'\') = ?')
      expect(plan.sql).toContain('CONCAT(search_type, \'\') = ?')
      expect(plan.params).toEqual(['site-1', 'web', '2026-01-01', '2026-03-31'])
    })

    it('prunes both ranges + keeps param alignment on the variantCount compareRange path', () => {
      // The exact shape that crashed in prod: queryCanonical top-N with a
      // compareRange (two partitionWhere calls + COUNT(DISTINCT) variantCount).
      const q: TopNBreakdownQuery = {
        ...base,
        archetype: 'top-n-breakdown',
        dimension: 'queryCanonical',
        metrics: ['clicks'],
        orderBy: { metric: 'clicks', dir: 'desc' },
        limit: 25,
        compareRange: { start: '2025-10-01', end: '2025-12-31' },
      }
      const plan = buildArchetypeSql(q, { partitionPruned: true })
      expect(plan.sql).not.toContain('site_id')
      expect(plan.sql).not.toContain('search_type')
      expect(plan.sql).toContain('COUNT(DISTINCT query) AS variantCount')
      expect(plan.sql).toContain('SELECT qd.query_canonical FROM query_dim qd')
      expect(plan.sql).not.toContain('GROUP BY query_canonical')
      // cur range + prev range, two bound params each, alignment preserved
      expect(plan.params).toEqual(['2026-01-01', '2026-03-31', '2025-10-01', '2025-12-31'])
    })
  })
})
