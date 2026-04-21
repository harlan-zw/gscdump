import type { BuilderState } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { FILES_PLACEHOLDER, resolveToSQL, substituteNamedFiles } from '../src/index'

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
    expect(r.sql).toMatch(/SUM\(clicks\)\s*AS\s+DOUBLE\)\s*>=\s*\?/)
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
