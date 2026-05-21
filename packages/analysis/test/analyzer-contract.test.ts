/**
 * Unified Analyzer contract tests. Each analyzer id has an `sql` variant
 * (adapted from duckdb builders) and optionally a `rows` variant (for
 * portable row-based paths). Verifies `build` is pure + shape-stable and
 * `reduce` works against canned rows.
 */

import { describe, expect, it } from 'vitest'

import { defaultAnalyzerRegistry } from '../src/default-registry'

const { getAnalyzerVariants, listAnalyzerIds, listAnalyzersFor, resolveAnalyzer } = defaultAnalyzerRegistry

describe('unified Analyzer registry', () => {
  it('lists every known tool id', () => {
    const ids = listAnalyzerIds()
    expect(ids).toContain('striking-distance')
    expect(ids).toContain('opportunity')
    expect(ids).toContain('movers')
    expect(ids).toContain('decay')
    expect(ids).toContain('bayesian-ctr')
    expect(ids.length).toBeGreaterThanOrEqual(29)
  })

  it('sQL variant exists for every duckdb analyzer', () => {
    const ids = listAnalyzerIds()
    for (const id of ids) {
      const variants = getAnalyzerVariants(id)
      expect(variants?.sql, `${id} missing sql variant`).toBeTruthy()
    }
  })

  it('row variant exists for every portable analyzer', () => {
    const portable = ['striking-distance', 'opportunity', 'brand', 'concentration', 'clustering', 'seasonality', 'movers', 'decay']
    for (const id of portable) {
      expect(getAnalyzerVariants(id)?.rows, `${id} missing rows variant`).toBeTruthy()
    }
  })

  it('resolveAnalyzer prefers sql when source supports it', () => {
    const a = resolveAnalyzer('striking-distance', true)
    expect(a?.id).toBe('striking-distance')
    const plan = a!.build({ type: 'striking-distance', startDate: '2026-01-01', endDate: '2026-01-31' } as any)
    expect(plan.kind).toBe('sql')
  })

  it('resolveAnalyzer falls back to rows when source cannot SQL', () => {
    const a = resolveAnalyzer('striking-distance', false)
    expect(a?.id).toBe('striking-distance')
    const plan = a!.build({ type: 'striking-distance', startDate: '2026-01-01', endDate: '2026-01-31' } as any)
    expect(plan.kind).toBe('rows')
  })
})

describe('sQL-native pilot (striking-distance)', () => {
  it('build emits an SqlPlan with stable placeholders', () => {
    const a = resolveAnalyzer('striking-distance', true)!
    const plan = a.build({
      type: 'striking-distance',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    } as any)
    expect(plan.kind).toBe('sql')
    if (plan.kind === 'sql') {
      expect(plan.sql).toMatch(/read_parquet/)
      expect(plan.sql).toMatch(/\{\{FILES\}\}/)
      expect(plan.current.table).toBe('page_queries')
      // Filtering + derivation moved to the shared reducer; only date bounds
      // are pushed into SQL now.
      expect(plan.params).toEqual(['2026-01-01', '2026-01-31'])
    }
  })

  it('reduce shapes rows into typed results', () => {
    const a = resolveAnalyzer('striking-distance', true)!
    // SQL + row plans both emit the `query` key (matches GSC's native column).
    // Reducer derives `potentialClicks` and renames to `keyword` in results.
    const rows = [
      { query: 'seo', page: '/a', clicks: 10, impressions: 1000, ctr: 0.01, position: 12 },
    ]
    const { results, meta } = a.reduce(rows as any, {
      params: { type: 'striking-distance' } as any,
    })
    expect(Array.isArray(results)).toBe(true)
    expect((results as any)[0].keyword).toBe('seo')
    expect((results as any)[0].potentialClicks).toBe(150)
    expect(meta?.total).toBe(1)
  })
})

describe('row-based pilot (opportunity)', () => {
  it('build emits a RowQueriesPlan with a queries query', () => {
    const a = resolveAnalyzer('opportunity', false)!
    const plan = a.build({
      type: 'opportunity',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      limit: 500,
    } as any)
    expect(plan.kind).toBe('rows')
    if (plan.kind === 'rows') {
      expect(Object.keys(plan.queries)).toEqual(['queries'])
      expect(plan.queries.queries.state).toBeDefined()
    }
  })

  it('reduce runs pure analyzeOpportunity over keyword rows', () => {
    const a = resolveAnalyzer('opportunity', false)!
    const keywords = [
      { query: 'high-value', page: '/a', clicks: 5, impressions: 500, ctr: 0.01, position: 12 },
      { query: 'low-imp', page: '/b', clicks: 1, impressions: 5, ctr: 0.2, position: 3 }, // skipped (< 100 imp)
    ]
    const { results } = a.reduce({ queries: keywords as any }, {
      params: { type: 'opportunity' } as any,
    })
    const out = results as any[]
    expect(out.length).toBe(1)
    expect(out[0].keyword).toBe('high-value')
  })
})

describe('listAnalyzersFor toggles variant selection', () => {
  it('sourceSupportsSql=true picks sql variants', () => {
    const list = listAnalyzersFor(true)
    const striking = list.find(a => a.id === 'striking-distance')!
    const plan = striking.build({ type: 'striking-distance', startDate: '2026-01-01', endDate: '2026-01-31' } as any)
    expect(plan.kind).toBe('sql')
  })

  it('sourceSupportsSql=false picks row variants where present', () => {
    const list = listAnalyzersFor(false)
    const striking = list.find(a => a.id === 'striking-distance')!
    const plan = striking.build({ type: 'striking-distance', startDate: '2026-01-01', endDate: '2026-01-31' } as any)
    expect(plan.kind).toBe('rows')
  })
})
