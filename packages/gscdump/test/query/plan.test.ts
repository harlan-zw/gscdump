import type { BuilderState } from '../../src/query/types'

import { describe, expect, it } from 'vitest'
import { buildLogicalComparisonPlan, buildLogicalPlan, inferDataset, isDatasetResolvable, isStateResolvable, UnresolvableDatasetError } from '../../src/query/plan'

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

describe('buildLogicalPlan', () => {
  it('infers dataset and normalizes queryCanonical column intent', () => {
    const plan = buildLogicalPlan(state({
      dimensions: ['queryCanonical'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'queryCanonical', operator: 'equals', expression: 'seo tools' },
        ],
      } as any,
    }))

    expect(plan.dataset).toBe('queries')
    expect(plan.dimensionFilters).toEqual([
      {
        dimension: 'queryCanonical',
        operator: 'equals',
        expression: 'seo tools',
        expression2: undefined,
      },
    ])
  })

  it('gates regex support at plan time', () => {
    expect(() => buildLogicalPlan(state({
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'page', operator: 'includingRegex', expression: '^/blog/' },
        ],
      } as any,
    }))).toThrow(/regex capability/)

    const plan = buildLogicalPlan(state({
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'page', operator: 'includingRegex', expression: '^/blog/' },
        ],
      } as any,
    }), { regex: true })

    expect(plan.dimensionFilters[0]?.operator).toBe('includingRegex')
  })
})

describe('inferDataset', () => {
  it('routes each single dimension to its own dataset', () => {
    expect(inferDataset(['page'])).toBe('pages')
    expect(inferDataset(['query'])).toBe('queries')
    expect(inferDataset(['country'])).toBe('countries')
    // `device` folds into the pivoted `dates` table (the standalone `devices`
    // table was retired); it has no groupable stored home.
    expect(inferDataset(['device'])).toBe('dates')
    expect(inferDataset(['page', 'query'])).toBe('page_queries')
    expect(inferDataset(['searchAppearance'])).toBe('search_appearance')
    expect(inferDataset(['searchAppearance', 'page'])).toBe('search_appearance_pages')
    expect(inferDataset(['searchAppearance', 'query'])).toBe('search_appearance_queries')
    expect(inferDataset(['searchAppearance', 'page', 'query'])).toBe('search_appearance_page_queries')
  })

  it('routes date-only / dimensionless queries to dates', () => {
    // `dates` carries the TRUE site totals (incl. anonymized impressions);
    // dimension-grouped tables undercount the host total under the
    // registered-host `page`-regex filter (ADR-0033).
    expect(inferDataset([])).toBe('dates')
    expect(inferDataset(['date'])).toBe('dates')
  })
})

describe('isDatasetResolvable', () => {
  it('accepts a single-dimension breakdown and its own filter', () => {
    expect(isDatasetResolvable(['query'], ['query'])).toBe(true)
    expect(isDatasetResolvable(['page', 'query'])).toBe(true)
    expect(isDatasetResolvable(['country'])).toBe(true)
  })

  it('treats a device breakdown as unresolvable (folded into pivoted `dates`)', () => {
    // The standalone `devices` table was retired; a `GROUP BY device` has no
    // stored home — device reads go through the device-pivot archetypes.
    expect(isDatasetResolvable(['device'])).toBe(false)
  })

  it('ignores the date and hour time axes', () => {
    expect(isDatasetResolvable(['date', 'country'])).toBe(true)
    expect(isDatasetResolvable(['country'], ['date'])).toBe(true)
    expect(isDatasetResolvable([], ['date'])).toBe(true)
  })

  it('rejects dimensions that span two stored datasets', () => {
    expect(isDatasetResolvable(['country'], ['query'])).toBe(false)
    expect(isDatasetResolvable(['page'], ['country'])).toBe(false)
    expect(isDatasetResolvable(['searchAppearance'], ['country'])).toBe(false)
  })

  it('accepts contextual search appearance page/query breakdowns', () => {
    expect(isDatasetResolvable(['searchAppearance'], ['query'])).toBe(true)
    expect(isDatasetResolvable(['searchAppearance', 'page', 'query'])).toBe(true)
  })

  it('agrees with inferDataset: routed dataset always covers a resolvable query', () => {
    expect(inferDataset(['device'], ['query'])).toBe('queries')
    // inferDataset still routes (legacy precedence); the predicate is what
    // tells callers the routed table cannot actually answer it.
    expect(isDatasetResolvable(['device'], ['query'])).toBe(false)
  })
})

describe('isStateResolvable', () => {
  it('extracts a state\'s filter dimensions and rejects cross-dimension queries', () => {
    const crossDim = state({
      dimensions: ['query'],
      filter: {
        _filters: [
          { dimension: 'date', operator: 'between', expression: '2026-03-01', expression2: '2026-03-31' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
        ],
      } as any,
    })
    expect(isStateResolvable(crossDim)).toBe(false)
  })

  it('accepts a single-family query (date filter only)', () => {
    expect(isStateResolvable(state({ dimensions: ['query'] }))).toBe(true)
    expect(isStateResolvable(state({ dimensions: ['page', 'query'] }))).toBe(true)
  })
})

describe('unresolvableDatasetError', () => {
  it('names the offending grouped and filtered dimensions', () => {
    const err = new UnresolvableDatasetError(['date', 'device'], ['date', 'query'])
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UnresolvableDatasetError')
    expect(err.message).toContain('[device]')
    expect(err.message).toContain('[query]')
  })
})

describe('buildLogicalComparisonPlan', () => {
  it('gates comparison joins at plan time', () => {
    expect(() => buildLogicalComparisonPlan(
      state({ dimensions: ['query'] }),
      state({ dimensions: ['query'] }),
    )).toThrow(/comparisonJoin capability/)

    const plan = buildLogicalComparisonPlan(
      state({ dimensions: ['query'] }),
      state({ dimensions: ['query'] }),
      { comparisonJoin: true },
      'new',
    )
    expect(plan.current.dataset).toBe('queries')
    expect(plan.comparisonFilter).toBe('new')
  })
})
