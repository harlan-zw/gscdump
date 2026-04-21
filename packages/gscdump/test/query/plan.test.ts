import type { BuilderState } from '../../src/query/types'

import { describe, expect, it } from 'vitest'
import { buildLogicalComparisonPlan, buildLogicalPlan } from '../../src/query/plan'

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

    expect(plan.dataset).toBe('keywords')
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
    expect(plan.current.dataset).toBe('keywords')
    expect(plan.comparisonFilter).toBe('new')
  })
})
