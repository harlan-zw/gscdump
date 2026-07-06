import type { BuilderState } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { FILES_PLACEHOLDER, resolveParquetSQL, substituteNamedFiles } from '../src/index'
import { resolveToSQL as resolverResolveToSQL, resolveToSQLOptimized } from '../src/resolver/compile'
import {
  createIcebergResolverAdapter,
  createParquetResolverAdapter,
  createR2SqlResolverAdapter,
  pgResolverAdapter,
} from '../src/resolver/pg-adapter'

function state(partial: Partial<BuilderState>): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: '2026-03-01',
        expression2: '2026-03-31',
      }],
    } as any,
    ...partial,
  }
}

describe('resolveParquetSQL', () => {
  it('builds GROUP BY + ORDER BY + LIMIT with FILES placeholder', () => {
    const r = resolveParquetSQL(state({}), 'pages')
    expect(r.sql).toContain(FILES_PLACEHOLDER)
    expect(r.sql).toMatch(/GROUP BY url/)
    expect(r.sql).toMatch(/ORDER BY clicks DESC/)
    expect(r.sql).toMatch(/LIMIT/)
    expect(r.params).toEqual(['2026-03-01', '2026-03-31'])
  })

  it('enumerates candidate partitions for the date range (daily + monthly)', () => {
    const r = resolveParquetSQL(state({}), 'pages')
    expect(r.partitions).toContain('daily/2026-03-01')
    expect(r.partitions).toContain('daily/2026-03-31')
    expect(r.partitions).toContain('monthly/2026-03')
  })

  it('translates a metric HAVING filter to a metricExpr comparison', () => {
    const r = resolveParquetSQL(state({
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'clicks', operator: 'metricGte', expression: '100' },
        ],
      } as any,
    }), 'pages')
    expect(r.sql).toMatch(/HAVING/)
    expect(r.sql).toMatch(/SUM\(clicks\)\s*AS\s+DOUBLE\)\s*>=\s*\?/)
    expect(r.params).toContain(100)
  })

  it('translates contains/regex to DuckDB-safe predicates', () => {
    const r = resolveParquetSQL(state({
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'page', operator: 'includingRegex', expression: '^/blog/' },
        ],
      } as any,
    }), 'pages')
    expect(r.sql).toMatch(/regexp_matches\(url, \?\)/)
    expect(r.params).toContain('^/blog/')
  })

  it('throws when date range is missing', () => {
    expect(() => resolveParquetSQL(state({ filter: undefined }), 'pages')).toThrow(/date range/i)
  })
})

describe('substituteNamedFiles', () => {
  it('replaces the FILES placeholder with a SQL string-list', () => {
    const sql = `SELECT * FROM read_parquet(${FILES_PLACEHOLDER})`
    const out = substituteNamedFiles(sql, { FILES: ['a.parquet', 'b.parquet'] })
    expect(out).toBe('SELECT * FROM read_parquet([\'a.parquet\', \'b.parquet\'])')
  })

  it('escapes single quotes in keys', () => {
    const out = substituteNamedFiles(`read_parquet(${FILES_PLACEHOLDER})`, { FILES: ['a\'b.parquet'] })
    expect(out).toBe('read_parquet([\'a\'\'b.parquet\'])')
  })

  it('emits an empty list when no keys', () => {
    const out = substituteNamedFiles(`read_parquet(${FILES_PLACEHOLDER})`, { FILES: [] })
    expect(out).toBe('read_parquet([])')
  })

  it('supports multiple named placeholders', () => {
    const sql = 'SELECT a FROM read_parquet({{FILES}}) UNION SELECT b FROM read_parquet({{FILES_PREV}})'
    const out = substituteNamedFiles(sql, { FILES: ['a.parquet'], FILES_PREV: ['b.parquet'] })
    expect(out).toBe('SELECT a FROM read_parquet([\'a.parquet\']) UNION SELECT b FROM read_parquet([\'b.parquet\'])')
  })
})

describe('pgResolverAdapter url-to-path dialect', () => {
  // Regression guard: pgResolverAdapter must override the SQLite-default
  // urlToPathExpr (INSTR/SUBSTR) with DuckDB's regexp_replace, or every
  // page-dimension query against R2 dies with a parse error.
  it('emits regexp_replace (not INSTR) for the page dimension', () => {
    const r = resolverResolveToSQL(state({}), { adapter: pgResolverAdapter })
    expect(r.sql).toContain('regexp_replace')
    expect(r.sql).not.toContain('INSTR')
  })

  it('emits regexp_replace for page-equals predicates (path normalization)', () => {
    const r = resolverResolveToSQL(state({
      dimensions: [],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'page', operator: 'equals', expression: '/blog/' },
        ],
      } as any,
    }), { adapter: pgResolverAdapter })
    expect(r.sql).toContain('regexp_replace')
    expect(r.sql).not.toContain('INSTR')
  })
})

describe('createParquetResolverAdapter', () => {
  it('emits read_parquet({{FILES}}, ...) AS "<table>" with bound col refs intact', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter })
    expect(r.sql).toContain('read_parquet({{FILES}}, union_by_name = true)')
    expect(r.sql).toContain('AS "pages"')
    // drizzle-bound colRefs compile to "pages"."<col>" — alias keeps them
    // resolvable against the parquet FROM. (urlToPathExpr emits bare `url`,
    // which DuckDB resolves unambiguously via the single FROM target.)
    expect(r.sql).toContain('"pages"."clicks"')
    expect(r.sql).toContain('"pages"."impressions"')
    expect(r.sql).toContain('"pages"."date"')
  })

  it('inherits DuckDB regexp_replace path normalization from pgResolverAdapter', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter })
    expect(r.sql).toContain('regexp_replace')
    expect(r.sql).not.toContain('INSTR')
  })

  it('derives queryCanonical predicates from QUERY_DIM', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'bar' },
        ],
      } as any,
    }), { adapter })
    expect(r.sql).toContain('LEFT JOIN read_parquet({{QUERY_DIM}}, union_by_name = true) AS "query_dim"')
    expect(r.sql).toContain('COALESCE("query_dim"."query_canonical", "queries"."query")')
    expect(r.sql).not.toContain('"queries"."query_canonical"')
    expect(r.params).toContain('bar')
  })

  it('produces a fresh adapter instance per call (no caching)', () => {
    expect(createParquetResolverAdapter()).not.toBe(createParquetResolverAdapter())
  })
})

describe('resolveToSQLOptimized SUM casts', () => {
  // Regression guard: DuckDB returns SUM() over INTEGER as HUGEINT which fails
  // to serialize through the DUCKDB_SVC service binding (returns null on the
  // host side). Every metric SUM in the optimized SQL must be wrapped in a
  // CAST so DuckDB returns DOUBLE instead.
  it('cTE SUM(clicks)/SUM(impressions)/SUM(sum_position) projections are CAST AS DOUBLE', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
    }), { adapter })
    expect(r.sql).toMatch(/CAST\(SUM\("pages"\."clicks"\) AS DOUBLE\)\s+as\s+clicks/)
    expect(r.sql).toMatch(/CAST\(SUM\("pages"\."impressions"\) AS DOUBLE\)\s+as\s+impressions/)
    expect(r.sql).toMatch(/CAST\(SUM\("pages"\."sum_position"\) AS DOUBLE\)\s+as\s+sum_position/)
  })

  it('outer totalClicks / totalImpressions window SUMs are CAST AS DOUBLE (not bare HUGEINT)', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      metrics: ['clicks', 'impressions'],
    }), { adapter })
    expect(r.sql).toContain('CAST(SUM(clicks) OVER() AS DOUBLE) as totalClicks')
    expect(r.sql).toContain('CAST(SUM(impressions) OVER() AS DOUBLE) as totalImpressions')
    // Negative guard: a bare `SUM(clicks) OVER()` projection would serialize
    // as null through the DUCKDB_SVC binding.
    expect(r.sql).not.toMatch(/(?<!CAST\()SUM\(clicks\) OVER\(\) as totalClicks/)
    expect(r.sql).not.toMatch(/(?<!CAST\()SUM\(impressions\) OVER\(\) as totalImpressions/)
  })

  it('projects a hidden helper when ordering by an unselected metric', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      metrics: ['clicks'],
      orderBy: { column: 'impressions', dir: 'desc' },
    }), { adapter })

    expect(r.sql).toContain('impressions as "__order_impressions"')
    expect(r.sql).toContain('ORDER BY __order_impressions DESC')
  })
})

describe('cross-dimension queries (unresolvable datasets)', () => {
  // A `device` breakdown filtered by `query` has no stored table carrying both
  // columns. The resolver must fail with a typed UnresolvableDatasetError, not
  // a raw "unknown column" Error deep in SQL compilation.
  it('throws UnresolvableDatasetError instead of an opaque column error', () => {
    const adapter = createParquetResolverAdapter()
    const crossDim = state({
      dimensions: ['device'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'query', operator: 'equals', expression: 'sitemap validator' },
        ],
      } as any,
    })
    expect(() => resolveToSQLOptimized(crossDim, { adapter })).toThrowError(/UnresolvableDatasetError|cross-dimension|separate per-dimension/i)
  })

  it('still resolves a single-family query (country breakdown, no cross filter)', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({ dimensions: ['country'] }), { adapter })
    expect(r.sql).toMatch(/GROUP BY "countries"\."country"/)
  })

  it('routes search appearance + page/query context to its contextual table', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      dimensions: ['searchAppearance', 'page', 'query'],
    }), { adapter })
    expect(r.sql).toContain('read_parquet({{FILES}}, union_by_name = true) AS "search_appearance_page_queries"')
    expect(r.sql).toMatch(/GROUP BY "search_appearance_page_queries"\."searchAppearance", CASE WHEN url LIKE/)
  })

  it('keeps search appearance totals on the total table', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      dimensions: ['searchAppearance'],
    }), { adapter })
    expect(r.sql).toContain('read_parquet({{FILES}}, union_by_name = true) AS "search_appearance"')
  })

  it('treats a device breakdown as unresolvable — the standalone devices table was folded into pivoted `dates`', () => {
    const adapter = createParquetResolverAdapter()
    expect(() => resolveToSQLOptimized(state({ dimensions: ['device'] }), { adapter }))
      .toThrowError(/UnresolvableDatasetError|cross-dimension|separate per-dimension/i)
  })
})

describe('prefilter (row-level WHERE on raw metrics)', () => {
  it('omits the predicate when no prefilter is set', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({}), { adapter })
    expect(r.sql).not.toMatch(/impressions"?\s*>=/)
  })

  it('compiles metricGte(impressions) into WHERE, not HAVING', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      prefilter: {
        _filters: [{ dimension: 'impressions', operator: 'metricGte', expression: '10' }],
      } as any,
    }), { adapter })
    expect(r.sql).toMatch(/WHERE[\s\S]*"impressions"\s*>=\s*\$\d+/)
    expect(r.sql).not.toMatch(/HAVING[\s\S]*impressions/)
    expect(r.params).toContain(10)
  })

  it('supports metricBetween on raw clicks column', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      prefilter: {
        _filters: [{ dimension: 'clicks', operator: 'metricBetween', expression: '5', expression2: '50' }],
      } as any,
    }), { adapter })
    expect(r.sql).toMatch(/"clicks"\s*>=\s*\$\d+\s*AND\s*"[^"]*"?\.?"?clicks"\s*<=\s*\$\d+/)
    expect(r.params).toContain(5)
    expect(r.params).toContain(50)
  })

  it('skips ctr (derived aggregate, no per-row equivalent)', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      prefilter: {
        _filters: [{ dimension: 'ctr', operator: 'metricGte', expression: '0.05' }],
      } as any,
    }), { adapter })
    expect(r.params).not.toContain(0.05)
  })

  it('skips position (raw sum_position is impression-scaled, not comparable to a plain position threshold)', () => {
    const adapter = createParquetResolverAdapter()
    const r = resolveToSQLOptimized(state({
      prefilter: {
        _filters: [{ dimension: 'position', operator: 'metricLte', expression: '10' }],
      } as any,
    }), { adapter })
    expect(r.sql).not.toMatch(/"sum_position"\s*<=/)
    expect(r.params).not.toContain(10)
  })
})

describe('createIcebergResolverAdapter', () => {
  it('injects site_id and search_type predicates when both scopes are provided', () => {
    const adapter = createIcebergResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter, siteId: 42, searchType: 'web' })
    expect(r.sql).toContain('"pages"."site_id"')
    expect(r.sql).toContain('"pages"."search_type"')
    expect(r.params).toContain(42)
    expect(r.params).toContain('web')
  })

  it('omits search_type predicate when searchType option is not set', () => {
    const adapter = createIcebergResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter, siteId: 42 })
    expect(r.sql).toContain('"pages"."site_id"')
    expect(r.sql).not.toContain('"pages"."search_type"')
    expect(r.params).toContain(42)
  })

  it('omits site_id predicate when siteId option is not set', () => {
    const adapter = createIcebergResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter, searchType: 'image' })
    expect(r.sql).not.toContain('"pages"."site_id"')
    expect(r.sql).toContain('"pages"."search_type"')
    expect(r.params).toContain('image')
  })
})

describe('createR2SqlResolverAdapter', () => {
  it('uses CONCAT partition predicates for explicit string-encoded R2 SQL catalogs', () => {
    const adapter = createR2SqlResolverAdapter({ partitionKeyEncoding: 'string' })
    const r = resolverResolveToSQL(state({}), { adapter, siteId: 'site-42', searchType: 'web' })
    expect(r.sql).toContain('CONCAT("pages"."site_id", \'\') = $1')
    expect(r.sql).toContain('CONCAT("pages"."search_type", \'\') = $2')
    expect(r.params).toContain('site-42')
    expect(r.params).toContain('web')
    expect(r.sql).not.toContain('"pages"."site_id" = $1')
  })

  it('keeps bare partition predicates by default for int-encoded R2 SQL catalogs', () => {
    const adapter = createR2SqlResolverAdapter()
    const r = resolverResolveToSQL(state({}), { adapter, siteId: 42, searchType: 1 })
    expect(r.sql).toContain('"pages"."site_id" = $1')
    expect(r.sql).toContain('"pages"."search_type" = $2')
    expect(r.sql).not.toContain('CONCAT("pages"."site_id"')
    expect(r.params).toContain(42)
    expect(r.params).toContain(1)
  })

  it('advertises the narrower R2 SQL execution surface', () => {
    const adapter = createR2SqlResolverAdapter()
    expect(adapter.capabilities.regex).toBe(false)
    expect(adapter.capabilities.comparisonJoin).toBe(false)
    expect(adapter.capabilities.windowTotals).toBe(false)
  })
})

describe('pgResolverAdapter ignores multi-tenant scopes', () => {
  // Regression guard: legacy single-tenant pgResolverAdapter must NOT inject
  // site_id / search_type predicates even if callers pass these options. The
  // parquet read path treats site identity as implicit (per-site object keys).
  it('emits no site_id / search_type predicates regardless of options', () => {
    const r = resolverResolveToSQL(state({}), {
      adapter: pgResolverAdapter,
      siteId: 42,
      searchType: 'web',
    })
    expect(r.sql).not.toContain('site_id')
    expect(r.sql).not.toContain('search_type')
    expect(r.params).not.toContain(42)
    expect(r.params).not.toContain('web')
  })
})
