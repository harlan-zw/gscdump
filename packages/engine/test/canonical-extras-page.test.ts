import type { BuilderState } from 'gscdump/query'
import { DatabaseSync } from 'node:sqlite'
import { buildExtrasQueries, createIcebergResolverAdapter, runOptimizedQuery } from '@gscdump/engine/resolver'
import { describe, expect, it, vi } from 'vitest'

const state: BuilderState = {
  dimensions: ['queryCanonical'],
  filter: {
    _filters: [{ dimension: 'date', operator: 'between', expression: '2026-01-01', expression2: '2026-06-30' }],
  },
}

describe('canonical extras for selected rows', () => {
  it('keeps every variant of selected keys within the requested site, search type, and date range', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE queries (site_id INTEGER, search_type INTEGER, date TEXT, query TEXT, clicks INTEGER, impressions INTEGER, sum_position REAL);
        CREATE TABLE query_dim (query TEXT, query_canonical TEXT);
        INSERT INTO queries VALUES
          (42, 1, '2026-01-05', 'Red boots', 8, 10, 20),
          (42, 1, '2026-06-05', 'red boot', 3, 5, 10),
          (42, 1, '2026-06-05', 'Coats', 20, 30, 60),
          (42, 1, '2026-06-05', 'unmapped''s item', 1, 2, 4),
          (99, 1, '2026-06-05', 'Red boots', 999, 999, 999),
          (42, 2, '2026-06-05', 'Red boots', 999, 999, 999),
          (42, 1, '2025-12-31', 'Red boots', 999, 999, 999);
        INSERT INTO query_dim VALUES ('Red boots', 'boots'), ('red boot', 'boots'), ('Coats', 'coats');
      `)
      const options = { adapter: createIcebergResolverAdapter(), siteId: 42, searchType: 1 }
      const [query] = buildExtrasQueries(state, options, ['boots', 'unmapped\'s item', 'boots'])
      const bindings = Object.fromEntries(query!.params.map((value, index) => [`$${index + 1}`, value]))
      const rows = db.prepare(query!.sql).all(bindings).sort((a, b) => String(a.joinKey).localeCompare(String(b.joinKey)))

      expect(rows.map(row => ({ key: row.joinKey, name: row.canonicalName, count: row.variantCount }))).toEqual([
        { key: 'boots', name: 'Red boots', count: 2 },
        { key: 'unmapped\'s item', name: 'unmapped\'s item', count: 1 },
      ])
      expect(String(rows[0]!.variants).split('||').sort()).toEqual(['Red boots:::8:::10:::3.0', 'red boot:::3:::5:::3.0'])
    }
    finally {
      db.close()
    }
  })

  it('does not issue enrichment queries when the selected key list is empty', () => {
    expect(buildExtrasQueries(state, { adapter: createIcebergResolverAdapter() }, [])).toEqual([])
  })

  it('does not query extras when the requested page has no rows', async () => {
    const runSQL = vi.fn(async () => ({ rows: [] }))
    const result = await runOptimizedQuery(runSQL, { userId: 'u', siteId: 's', table: 'queries' }, state, {
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    }, {
      primarySourceFallback: 'raw',
      queryDim: { keys: ['query_dim.parquet'], normalizerVersion: 2, intentVersion: 1 },
    })
    expect(result.rows).toEqual([])
    expect(runSQL).toHaveBeenCalledOnce()
  })
})
