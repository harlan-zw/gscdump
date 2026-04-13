import type { BuilderState } from '../../src/query/types'
import { describe, expect, it } from 'vitest'
import { FILES_PLACEHOLDER, resolveToSQL, substituteFiles } from '../../src/analytics'

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

describe('resolveToSQL', () => {
  it('builds GROUP BY + ORDER BY + LIMIT with FILES placeholder', () => {
    const r = resolveToSQL(state({}), 'pages')
    expect(r.sql).toContain(FILES_PLACEHOLDER)
    expect(r.sql).toMatch(/GROUP BY url/)
    expect(r.sql).toMatch(/ORDER BY clicks DESC/)
    expect(r.sql).toMatch(/LIMIT/)
    expect(r.params).toEqual(['2026-03-01', '2026-03-31'])
  })

  it('enumerates candidate partitions for the date range (daily + monthly)', () => {
    const r = resolveToSQL(state({}), 'pages')
    expect(r.partitions).toContain('daily/2026-03-01')
    expect(r.partitions).toContain('daily/2026-03-31')
    expect(r.partitions).toContain('monthly/2026-03')
  })

  it('translates a metric HAVING filter to a metricExpr comparison', () => {
    const r = resolveToSQL(state({
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'clicks', operator: 'metricGte', expression: '100' },
        ],
      } as any,
    }), 'pages')
    expect(r.sql).toMatch(/HAVING/)
    expect(r.sql).toMatch(/SUM\(clicks\)\s*>=\s*\?/)
    expect(r.params).toContain(100)
  })

  it('translates contains/regex to DuckDB-safe predicates', () => {
    const r = resolveToSQL(state({
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
    expect(() => resolveToSQL(state({ filter: undefined }), 'pages')).toThrow(/date range/)
  })
})

describe('substituteFiles', () => {
  it('replaces the placeholder with a SQL string-list', () => {
    const sql = `SELECT * FROM read_parquet(${FILES_PLACEHOLDER})`
    const out = substituteFiles(sql, ['a.parquet', 'b.parquet'])
    expect(out).toBe('SELECT * FROM read_parquet([\'a.parquet\', \'b.parquet\'])')
  })

  it('escapes single quotes in keys', () => {
    const out = substituteFiles(`read_parquet(${FILES_PLACEHOLDER})`, ['a\'b.parquet'])
    expect(out).toBe('read_parquet([\'a\'\'b.parquet\'])')
  })

  it('emits an empty list when no keys', () => {
    const out = substituteFiles(`read_parquet(${FILES_PLACEHOLDER})`, [])
    expect(out).toBe('read_parquet([])')
  })
})
