import { describe, expect, it } from 'vitest'
import { analyzeConcentration } from '../src/analyzers/concentration'

describe('analyzeConcentration', () => {
  it('computes Gini and HHI while retaining descending top items', () => {
    const result = analyzeConcentration([
      { key: 'middle', clicks: 30 },
      { key: 'top', clicks: 50 },
      { key: 'bottom', clicks: 20 },
    ], { topN: 2 })

    expect(result.giniCoefficient).toBeCloseTo(0.2, 10)
    expect(result.hhi).toBeCloseTo(3800, 10)
    expect(result.topNConcentration).toBeCloseTo(0.8, 10)
    expect(result.topNItems.map(item => item.key)).toEqual(['top', 'middle'])
  })

  it('returns zero-valued distribution metrics when all clicks are zero', () => {
    const result = analyzeConcentration([
      { key: 'a', clicks: 0 },
      { key: 'b', clicks: 0 },
    ])

    expect(result.giniCoefficient).toBe(0)
    expect(result.hhi).toBe(0)
    expect(result.topNConcentration).toBe(0)
  })
})
