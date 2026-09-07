import type { BuilderState } from 'gscdump/query'
import { DatabaseSync } from 'node:sqlite'
import { buildExtrasQueries, createIcebergResolverAdapter, createR2SqlResolverAdapter, resolveToSQL } from '@gscdump/engine/resolver'
import { describe, expect, it } from 'vitest'

function state(operator: 'includingRegex' | 'excludingRegex'): BuilderState {
  return {
    dimensions: ['query'],
    filter: {
      _filters: [
        { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
        { dimension: 'query', operator, expression: '^regexp_matches\\(\'literal\'' },
      ],
    },
  } as BuilderState
}

describe('resolver SQL dialects', () => {
  it('executes canonical label aggregation on SQLite', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE queries (site_id INTEGER, search_type INTEGER, date TEXT, query TEXT, clicks INTEGER, impressions INTEGER, sum_position REAL);
        CREATE TABLE query_dim (query TEXT, query_canonical TEXT);
        INSERT INTO queries VALUES (42, 1, '2026-03-05', 'alpha', 8, 10, 20), (42, 1, '2026-03-05', 'beta', 2, 5, 10);
        INSERT INTO query_dim VALUES ('alpha', 'group'), ('beta', 'group');
      `)
      const input = { ...state('includingRegex'), dimensions: ['queryCanonical'], filter: { _filters: [state('includingRegex').filter!._filters[0]!] } } as BuilderState
      const [query] = buildExtrasQueries(input, { adapter: createIcebergResolverAdapter(), siteId: 42, searchType: 1 })
      const bindings = Object.fromEntries(query!.params.map((value, index) => [`$${index + 1}`, value]))
      const rows = db.prepare(query!.sql).all(bindings)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ joinKey: 'group', canonicalName: 'alpha', variantCount: 2 })
      expect(String(rows[0]!.variants).split('||').sort()).toEqual(['alpha:::8:::10:::3.0', 'beta:::2:::5:::3.0'])
    }
    finally {
      db.close()
    }
  })

  it.each(['includingRegex', 'excludingRegex'] as const)('compiles %s for R2 SQL without rewriting bound text', (operator) => {
    const adapter = createIcebergResolverAdapter({ dialect: 'r2sql' })
    const result = resolveToSQL(state(operator), { adapter, siteId: 42, searchType: 1 })
    expect(result.sql).toMatch(/regexp_like\(/i)
    expect(result.sql).not.toMatch(/regexp_matches\(/i)
    expect(result.sql.includes('NOT regexp_like(')).toBe(operator === 'excludingRegex')
    expect(result.params).toContain('^regexp_matches\\(\'literal\'')
    expect(result.params).toContain(42)
    expect(result.params).toContain(1)
  })

  it('keeps the default Iceberg regex compatible with DuckDB', () => {
    const result = resolveToSQL(state('includingRegex'), { adapter: createIcebergResolverAdapter(), siteId: 42, searchType: 1 })
    expect(result.sql).toMatch(/regexp_matches\(/i)
    expect(result.params).toContain('^regexp_matches\\(\'literal\'')
  })

  it.each([
    ['iceberg', () => createIcebergResolverAdapter({ dialect: 'r2sql' })],
    ['r2sql', () => createR2SqlResolverAdapter()],
  ] as const)('compiles canonical labels with a supported aggregate for %s', (_, createAdapter) => {
    const input = { ...state('includingRegex'), dimensions: ['queryCanonical'], filter: { _filters: [state('includingRegex').filter!._filters[0]!] } } as BuilderState
    const [result] = buildExtrasQueries(input, { adapter: createAdapter(), siteId: 42, searchType: 1 })
    expect(result!.sql).toMatch(/STRING_AGG\(/i)
    expect(result!.sql).not.toMatch(/GROUP_CONCAT\(/i)
    expect(result!.params).toEqual([42, 1, '2026-03-01', '2026-03-31'])
  })
})
