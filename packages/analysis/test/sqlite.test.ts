/**
 * @gscdump/analysis/sqlite — schema, window, scope, typed query compilation.
 * Uses a stub executor to record SQL + params without a real sqlite backend.
 */

import { desc, sql as drizzleSql, eq, sum } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import {
  compileSqlite,
  createSqliteInsightRunner,
  gsc_keywords,
  gsc_pages,
  mergeScope,
  resolveWindow,
  scopeFor,
} from '../src/sqlite'

interface Captured {
  sql: string
  params: unknown[]
  method: string
}

function stubExecutor(captured: Captured[], rows: unknown[] = []) {
  return async (sql: string, params: unknown[], method: string) => {
    captured.push({ sql, params, method })
    return { rows }
  }
}

describe('@gscdump/analysis/sqlite', () => {
  it('schema exposes gsc_* tables with site_id + date', () => {
    const cols = Object.keys((gsc_pages as any)[Symbol.for('drizzle:Columns')])
    expect(cols).toContain('site_id')
    expect(cols).toContain('date')
    expect(cols).toContain('url')
    expect(cols).toContain('sum_position')
  })

  it('resolveWindow works from /sqlite re-export', () => {
    const w = resolveWindow({ preset: 'last-30d', anchor: '2026-04-14' })
    expect(w.start).toBe('2026-03-16')
    expect(w.end).toBe('2026-04-14')
    expect(w.days).toBe(30)
  })

  it('scopeFor emits site_id + date predicates', () => {
    const w = resolveWindow({ preset: 'last-7d', anchor: '2026-04-14' })
    const scope = scopeFor('gsc_pages', { siteId: 'site-123', window: w })
    expect(scope.wherePredicates).toHaveLength(3)
    expect(scope.siteId).toBe('site-123')
  })

  it('mergeScope returns undefined when empty', () => {
    const scope = scopeFor('gsc_pages', {})
    expect(mergeScope(scope)).toBeUndefined()
  })

  it('scopeFor accepts bare startDate/endDate and emits what is provided', () => {
    const both = scopeFor('gsc_pages', { siteId: 's1', startDate: '2026-01-01', endDate: '2026-01-31' })
    expect(both.wherePredicates).toHaveLength(3)

    const onlyStart = scopeFor('gsc_pages', { siteId: 's1', startDate: '2026-01-01' })
    expect(onlyStart.wherePredicates).toHaveLength(2)

    const onlyEnd = scopeFor('gsc_pages', { siteId: 's1', endDate: '2026-01-31' })
    expect(onlyEnd.wherePredicates).toHaveLength(2)

    const siteOnly = scopeFor('gsc_pages', { siteId: 's1' })
    expect(siteOnly.wherePredicates).toHaveLength(1)
  })

  it('typed .select() compiles against gsc_keywords with scope predicates', async () => {
    const captured: Captured[] = []
    const runner = createSqliteInsightRunner({ executor: stubExecutor(captured) })

    const w = resolveWindow({ preset: 'last-30d', anchor: '2026-04-14' })
    const scope = scopeFor('gsc_keywords', { siteId: 'site-abc', window: w })

    const q = runner.db
      .select({
        query: gsc_keywords.query,
        clicks: sum(gsc_keywords.clicks),
      })
      .from(gsc_keywords)
      .where(mergeScope(scope, eq(gsc_keywords.query_canonical, 'seo')))
      .groupBy(gsc_keywords.query)
      .orderBy(desc(sum(gsc_keywords.clicks)))
      .limit(10)

    const { sql, params } = q.toSQL()
    expect(sql).toMatch(/from\s+"gsc_keywords"/i)
    expect(sql).toContain('group by')
    expect(sql).toContain('"site_id" = ?')
    expect(sql).toContain('"date" >= ?')
    expect(sql).toContain('"date" <= ?')
    expect(params).toContain('site-abc')
    expect(params).toContain('2026-03-16')
    expect(params).toContain('2026-04-14')
    expect(params).toContain('seo')
  })

  it('sql template escape hatch with METRICS_SQL-style aggregations', async () => {
    const captured: Captured[] = []
    const runner = createSqliteInsightRunner({ executor: stubExecutor(captured) })

    const q = drizzleSql`
      SELECT
        ${gsc_pages.url} AS url,
        SUM(${gsc_pages.clicks}) AS clicks,
        CAST(SUM(${gsc_pages.clicks}) AS REAL) / NULLIF(SUM(${gsc_pages.impressions}), 0) AS ctr,
        SUM(${gsc_pages.sum_position}) / NULLIF(SUM(${gsc_pages.impressions}), 0) + 1 AS position
      FROM ${gsc_pages}
      WHERE ${gsc_pages.site_id} = ${'site-xyz'}
      GROUP BY ${gsc_pages.url}
    `

    await runner.db.all(q)
    expect(captured).toHaveLength(1)
    const rec = captured[0]!
    expect(rec.sql).toMatch(/from\s+"gsc_pages"/i)
    expect(rec.sql).toContain('"site_id" = ?')
    expect(rec.params).toEqual(['site-xyz'])
  })

  it('compileSqlite serializes typed column refs to { sql, params }', () => {
    const expr = drizzleSql`
      SELECT ${gsc_keywords.query} AS keyword,
             SUM(${gsc_keywords.clicks}) AS clicks
      FROM ${gsc_keywords}
      WHERE ${gsc_keywords.site_id} = ${'abc'}
        AND ${gsc_keywords.date} >= ${'2026-01-01'}
      GROUP BY ${gsc_keywords.query}
    `
    const { sql, params } = compileSqlite(expr)
    expect(sql).toMatch(/"gsc_keywords"\."query"/)
    expect(sql).toMatch(/from\s+"gsc_keywords"/i)
    expect(sql).toMatch(/"site_id"\s*=\s*\?/)
    expect(params).toEqual(['abc', '2026-01-01'])
  })

  it('rowsAsArrays: true converts object rows to positional values', async () => {
    const captured: Captured[] = []
    const objectRows = [{ query: 'alpha', clicks: 100 }, { query: 'beta', clicks: 50 }]
    const runner = createSqliteInsightRunner({
      executor: stubExecutor(captured, objectRows),
      rowsAsArrays: true,
    })

    const rows = await runner.db
      .select({ query: gsc_keywords.query, clicks: sum(gsc_keywords.clicks) })
      .from(gsc_keywords)
      .groupBy(gsc_keywords.query)

    expect(rows).toEqual([
      { query: 'alpha', clicks: '100' },
      { query: 'beta', clicks: '50' },
    ])
  })
})

describe('@gscdump/analysis/sqlite runtime-builder', () => {
  it('inferTable picks the narrowest table for combined dimensions', async () => {
    const { inferTable } = await import('../src/sqlite')
    expect(inferTable(['page', 'query'])).toBe('gsc_page_keywords')
    expect(inferTable(['query'])).toBe('gsc_keywords')
    expect(inferTable(['page'])).toBe('gsc_pages')
    expect(inferTable(['country'])).toBe('gsc_countries')
    expect(inferTable(['device'])).toBe('gsc_devices')
    expect(inferTable(['date'])).toBe('gsc_keywords')
  })

  it('dimColumn maps dimension aliases to real columns', async () => {
    const { dimColumn } = await import('../src/sqlite')
    expect(dimColumn('page', 'gsc_pages')).toBe('url')
    expect(dimColumn('queryCanonical', 'gsc_keywords')).toBe('query_canonical')
    expect(dimColumn('country', 'gsc_countries')).toBe('country')
  })

  it('metricSql compiles to expected aggregate SQL per metric', async () => {
    const { compileSqlite, metricSql } = await import('../src/sqlite')
    expect(compileSqlite(metricSql('clicks', 'gsc_pages')).sql).toMatch(/SUM\(/i)
    expect(compileSqlite(metricSql('ctr', 'gsc_pages')).sql).toMatch(/CAST\s*\(\s*SUM/i)
    expect(compileSqlite(metricSql('position', 'gsc_pages')).sql).toMatch(/sum_position/i)
  })

  it('havingPredicates emits one SQL per metric filter', async () => {
    const { havingPredicates } = await import('../src/sqlite')
    const preds = havingPredicates(
      [
        { dimension: 'clicks', operator: 'metricGte', expression: '50' } as any,
        { dimension: 'impressions', operator: 'metricBetween', expression: '100', expression2: '1000' } as any,
        { dimension: 'query', operator: 'equals', expression: 'seo' } as any, // ignored
      ],
      'gsc_keywords',
    )
    expect(preds).toHaveLength(2)
  })

  it('dimensionPredicates skips date/metric/topLevel and emits LIKE for contains', async () => {
    const { compileSqlite, dimensionPredicates } = await import('../src/sqlite')
    const preds = dimensionPredicates(
      [
        { dimension: 'date', operator: 'between', expression: '2026-01-01' } as any, // skipped
        { dimension: 'clicks', operator: 'metricGte', expression: '5' } as any, // skipped
        { dimension: 'query', operator: 'contains', expression: 'seo%tools' } as any,
        { dimension: 'page', operator: 'equals', expression: '/about' } as any,
      ],
      'gsc_page_keywords',
    )
    expect(preds).toHaveLength(2)
    const likeSql = compileSqlite(preds[0]!).sql
    expect(likeSql.toLowerCase()).toContain('like')
    const likeParams = compileSqlite(preds[0]!).params
    // escapeLike should have escaped the % in the expression
    expect(likeParams[0]).toBe('%seo\\%tools%')
  })

  it('topLevelPredicate emits a path-depth predicate only when the operator is present', async () => {
    const { topLevelPredicate } = await import('../src/sqlite')
    expect(topLevelPredicate([], 'gsc_pages')).toBeUndefined()
    const p = topLevelPredicate(
      [{ dimension: 'page', operator: 'topLevel', expression: '' } as any],
      'gsc_pages',
    )
    expect(p).toBeDefined()
  })

  it('colRef throws on an unknown column so schema drift fails loudly', async () => {
    const { colRef } = await import('../src/sqlite')
    expect(() => colRef('gsc_pages', 'nope')).toThrow(/unknown column/i)
  })
})
