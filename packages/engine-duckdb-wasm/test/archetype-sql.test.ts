import type { ArchetypeQuery } from '@gscdump/contracts/archetypes'
import { describe, expect, it } from 'vitest'
import { compileArchetypeSql, tableForArchetype } from '../src/archetype-sql'

const range = { start: '2026-01-01', end: '2026-03-31' }

describe('compileArchetypeSql', () => {
  it('1 — site-daily-timeseries: groups by date over dates', () => {
    const q: ArchetypeQuery = {
      archetype: 'site-daily-timeseries',
      siteId: 's1',
      searchType: 'web',
      range,
      metrics: ['clicks', 'impressions'],
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('dates')
    expect(c.sql).toContain('GROUP BY date')
    expect(c.sql).toContain('SUM(clicks) AS clicks')
    // NB: no trailing search_type param — the attached view is per-searchType,
    // so the predicate (and its param) were dropped (encoding-agnostic).
    expect(c.params).toEqual(['2026-01-01', '2026-03-31'])
  })

  it('2 — entity-daily-timeseries: filters one resolved entity', () => {
    const q: ArchetypeQuery = {
      archetype: 'entity-daily-timeseries',
      siteId: 's1',
      searchType: 'web',
      range,
      entity: { dimension: 'page', value: 'https://x.com/a' },
      metrics: ['clicks'],
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('pages')
    expect(c.sql).toContain('url = ?')
    expect(c.params).toContain('https://x.com/a')
  })

  it('3 — entity-daily-sparkline: builds an IN list from resolved entities', () => {
    const q: ArchetypeQuery = {
      archetype: 'entity-daily-sparkline',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'query',
      entities: ['kw1', 'kw2', 'kw3'],
      metric: 'clicks',
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('queries')
    expect(c.sql).toContain('query IN (?, ?, ?)')
    expect(c.params.slice(-3)).toEqual(['kw1', 'kw2', 'kw3'])
  })

  it('3 — entity-daily-sparkline: throws with no resolved entities', () => {
    const q: ArchetypeQuery = {
      archetype: 'entity-daily-sparkline',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'query',
      entities: [],
      metric: 'clicks',
    }
    expect(() => compileArchetypeSql(q)).toThrow(/resolved entities/)
  })

  it('4 — top-n-breakdown: applies LIMIT and optional OFFSET', () => {
    const base: ArchetypeQuery = {
      archetype: 'top-n-breakdown',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 100,
    }
    const noOffset = compileArchetypeSql(base)
    expect(noOffset.sql).toContain('ORDER BY clicks DESC LIMIT ?')
    expect(noOffset.sql).not.toContain('OFFSET')

    const withOffset = compileArchetypeSql({ ...base, offset: 50 })
    expect(withOffset.sql).toContain('OFFSET ?')
    expect(withOffset.params.slice(-2)).toEqual([100, 50])
  })

  it('4 — top-n-breakdown: brand regex/notRegex facet → regexp_matches on the query column', () => {
    const base: ArchetypeQuery = {
      archetype: 'top-n-breakdown',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
    }
    const branded = compileArchetypeSql({ ...base, facets: [{ column: 'query', op: 'regex', value: '(nuxt seo)' }] })
    expect(branded.sql).toContain('regexp_matches(LOWER(query), ?)')
    expect(branded.sql).not.toContain('NOT regexp_matches')
    // facet param sits between the range params and the trailing LIMIT param.
    // (No search_type param — dropped; the view is already per-searchType.)
    expect(branded.params).toEqual(['2026-01-01', '2026-03-31', '(nuxt seo)', 50])

    const nonBranded = compileArchetypeSql({ ...base, facets: [{ column: 'query', op: 'notRegex', value: '(nuxt seo)' }] })
    expect(nonBranded.sql).toContain('NOT regexp_matches(LOWER(query), ?)')
  })

  it('4 — top-n-breakdown: eq facet → equality predicate', () => {
    const c = compileArchetypeSql({
      archetype: 'top-n-breakdown',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'query',
      metrics: ['clicks'],
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 50,
      facets: [{ column: 'country', op: 'eq', value: 'ind' }],
    })
    expect(c.sql).toContain('country = ?')
    expect(c.params).toContain('ind')
  })

  it('5 — single-row-lookup: ANDs every match dimension', () => {
    const q: ArchetypeQuery = {
      archetype: 'single-row-lookup',
      siteId: 's1',
      searchType: 'web',
      range,
      match: { page: 'https://x.com/a', query: 'kw' },
      metrics: ['clicks'],
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('page_queries')
    expect(c.sql).toContain('url = ?')
    expect(c.sql).toContain('query = ?')
  })

  it('6 — multi-series-stacked-daily: device unpivots the dates pivot columns', () => {
    const q: ArchetypeQuery = {
      archetype: 'multi-series-stacked-daily',
      siteId: 's1',
      searchType: 'web',
      range,
      seriesDimension: 'device',
      metric: 'clicks',
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('dates')
    // device breakdown is pivoted on `dates`; the compiler UNION-ALL-unpivots it.
    expect(c.sql).toContain('UNION ALL')
    expect(c.sql).toContain('SUM(clicks_desktop)')
    expect(c.sql).toContain('ORDER BY date, device')
  })

  it('4b — top-n-breakdown: device includes the order metric when it is not selected', () => {
    const q: ArchetypeQuery = {
      archetype: 'top-n-breakdown',
      siteId: 's1',
      searchType: 'web',
      range,
      dimension: 'device',
      metrics: ['clicks'],
      orderBy: { metric: 'impressions', dir: 'desc' },
      limit: 3,
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('dates')
    expect(c.sql).toContain('UNION ALL')
    expect(c.sql).toContain('SUM(clicks_desktop) AS clicks')
    expect(c.sql).toContain('SUM(impressions_desktop) AS impressions')
    expect(c.sql).toContain('SELECT device, clicks, impressions FROM')
    expect(c.sql).toContain('ORDER BY impressions DESC LIMIT ?')
  })

  it('6b — multi-series-stacked-daily: non-device series still groups by date + dim', () => {
    const q: ArchetypeQuery = {
      archetype: 'multi-series-stacked-daily',
      siteId: 's1',
      searchType: 'web',
      range,
      seriesDimension: 'country',
      metric: 'clicks',
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('countries')
    expect(c.sql).toContain('GROUP BY date, country')
  })

  it('8 — two-dimension-detail: groups by url, query with optional filter', () => {
    const q: ArchetypeQuery = {
      archetype: 'two-dimension-detail',
      siteId: 's1',
      searchType: 'web',
      range,
      metrics: ['clicks', 'impressions'],
      filter: { page: 'https://x.com/a' },
      orderBy: { metric: 'clicks', dir: 'desc' },
      limit: 1000,
    }
    const c = compileArchetypeSql(q)
    expect(c.table).toBe('page_queries')
    expect(c.sql).toContain('GROUP BY url, query')
    expect(c.sql).toContain('url = ?')
    expect(c.params).toContain('https://x.com/a')
  })

  it('9 — arbitrary-sql: passes the SQL through verbatim', () => {
    const q: ArchetypeQuery = {
      archetype: 'arbitrary-sql',
      siteId: 's1',
      searchType: 'web',
      range,
      sql: 'SELECT date, AVG(clicks) OVER (ORDER BY date) FROM pages',
      params: [1],
    }
    const c = compileArchetypeSql(q)
    expect(c.sql).toContain('OVER (ORDER BY date)')
    expect(c.params).toEqual([1])
  })

  it('10 — aux-cloud-only: throws (not an Iceberg query)', () => {
    const q: ArchetypeQuery = {
      archetype: 'aux-cloud-only',
      siteId: 's1',
      dataset: 'sitemaps',
    }
    expect(() => compileArchetypeSql(q)).toThrow(/aux-cloud-only/)
  })
})

describe('tableForArchetype', () => {
  it('returns null for aux-cloud-only', () => {
    expect(tableForArchetype({ archetype: 'aux-cloud-only', siteId: 's1', dataset: 'indexing' })).toBeNull()
  })

  it('returns page_queries for a two-dimension query', () => {
    expect(tableForArchetype({
      archetype: 'two-dimension-detail',
      siteId: 's1',
      searchType: 'web',
      range,
      metrics: ['clicks'],
    })).toBe('page_queries')
  })
})
