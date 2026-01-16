import { describe, expect, it } from 'vitest'
import {
  analyzeDecay,
  analyzeMovers,
  analyzeStrikingDistance,
  analyzeOpportunity,
  analyzeCannibalization,
  analyzeZeroClick,
  analyzeSeasonality,
  analyzeConcentration,
  analyzePageConcentration,
  analyzeKeywordConcentration,
  analyzeBrandSegmentation,
} from '../src/analysis'

describe('analyzeDecay', () => {
  it('identifies pages with declining traffic', () => {
    const result = analyzeDecay({
      current: [
        { page: '/declining', clicks: 10, impressions: 100, ctr: 0.1, position: 5, keyword: '' },
        { page: '/stable', clicks: 100, impressions: 500, ctr: 0.2, position: 3, keyword: '' },
      ],
      previous: [
        { page: '/declining', clicks: 100, impressions: 500, ctr: 0.2, position: 3, keyword: '' },
        { page: '/stable', clicks: 100, impressions: 500, ctr: 0.2, position: 3, keyword: '' },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0].page).toBe('/declining')
    expect(result[0].lostClicks).toBe(90)
    expect(result[0].declinePercent).toBe(0.9)
  })

  it('respects minPreviousClicks threshold', () => {
    const result = analyzeDecay({
      current: [{ page: '/low-traffic', clicks: 5, impressions: 50, ctr: 0.1, position: 10, keyword: '' }],
      previous: [{ page: '/low-traffic', clicks: 30, impressions: 100, ctr: 0.3, position: 8, keyword: '' }],
    }, { minPreviousClicks: 50 })

    expect(result).toHaveLength(0)
  })

  it('respects decline threshold', () => {
    const result = analyzeDecay({
      current: [{ page: '/small-decline', clicks: 90, impressions: 450, ctr: 0.2, position: 3, keyword: '' }],
      previous: [{ page: '/small-decline', clicks: 100, impressions: 500, ctr: 0.2, position: 3, keyword: '' }],
    }, { threshold: 0.2 })

    expect(result).toHaveLength(0) // 10% decline < 20% threshold
  })

  it('handles pages that disappeared', () => {
    const result = analyzeDecay({
      current: [],
      previous: [{ page: '/gone', clicks: 100, impressions: 500, ctr: 0.2, position: 3, keyword: '' }],
    })

    expect(result).toHaveLength(1)
    expect(result[0].page).toBe('/gone')
    expect(result[0].currentClicks).toBe(0)
    expect(result[0].declinePercent).toBe(1)
  })

  it('sorts by lostClicks by default', () => {
    const result = analyzeDecay({
      current: [
        { page: '/a', clicks: 50, impressions: 100, ctr: 0.5, position: 2, keyword: '' },
        { page: '/b', clicks: 20, impressions: 100, ctr: 0.2, position: 5, keyword: '' },
      ],
      previous: [
        { page: '/a', clicks: 100, impressions: 200, ctr: 0.5, position: 2, keyword: '' },
        { page: '/b', clicks: 100, impressions: 200, ctr: 0.5, position: 3, keyword: '' },
      ],
    })

    expect(result[0].page).toBe('/b') // Lost 80 vs 50
    expect(result[0].lostClicks).toBe(80)
  })
})

describe('analyzeMovers', () => {
  it('categorizes keywords as rising, declining, or stable', () => {
    const result = analyzeMovers({
      current: [
        { keyword: 'rising', page: '/a', clicks: 200, impressions: 1000, ctr: 0.2, position: 3 },
        { keyword: 'declining', page: '/b', clicks: 50, impressions: 500, ctr: 0.1, position: 10 },
        { keyword: 'stable', page: '/c', clicks: 100, impressions: 500, ctr: 0.2, position: 5 },
      ],
      previous: [
        { keyword: 'rising', page: '/a', clicks: 100, impressions: 800, ctr: 0.125, position: 5 },
        { keyword: 'declining', page: '/b', clicks: 200, impressions: 1000, ctr: 0.2, position: 3 },
        { keyword: 'stable', page: '/c', clicks: 100, impressions: 500, ctr: 0.2, position: 5 },
      ],
    })

    expect(result.rising).toHaveLength(1)
    expect(result.rising[0].keyword).toBe('rising')

    expect(result.declining).toHaveLength(1)
    expect(result.declining[0].keyword).toBe('declining')

    expect(result.stable).toHaveLength(1)
    expect(result.stable[0].keyword).toBe('stable')
  })

  it('respects minImpressions filter', () => {
    const result = analyzeMovers({
      current: [{ keyword: 'low', page: '/a', clicks: 10, impressions: 30, ctr: 0.33, position: 2 }],
      previous: [{ keyword: 'low', page: '/a', clicks: 5, impressions: 20, ctr: 0.25, position: 3 }],
    }, { minImpressions: 50 })

    expect(result.rising).toHaveLength(0)
    expect(result.declining).toHaveLength(0)
    expect(result.stable).toHaveLength(0)
  })

  it('handles new keywords not in baseline', () => {
    const result = analyzeMovers({
      current: [{ keyword: 'new', page: '/a', clicks: 100, impressions: 500, ctr: 0.2, position: 3 }],
      previous: [],
    })

    expect(result.rising).toHaveLength(1)
    expect(result.rising[0].keyword).toBe('new')
    expect(result.rising[0].baselineClicks).toBe(0)
  })

  it('applies normalization factor', () => {
    // Previous period was 2x as long, so normalize by dividing by 2
    const result = analyzeMovers({
      current: [{ keyword: 'test', page: '/a', clicks: 100, impressions: 500, ctr: 0.2, position: 3 }],
      previous: [{ keyword: 'test', page: '/a', clicks: 200, impressions: 1000, ctr: 0.2, position: 3 }],
      normalizationFactor: 2,
    })

    // After normalization, both periods have 100 clicks = stable
    expect(result.stable).toHaveLength(1)
    expect(result.stable[0].keyword).toBe('test')
  })
})

describe('analyzeStrikingDistance', () => {
  it('finds keywords in positions 4-20 with low CTR', () => {
    const result = analyzeStrikingDistance([
      { keyword: 'striking', page: '/a', clicks: 10, impressions: 1000, ctr: 0.01, position: 8 },
      { keyword: 'too-high-ctr', page: '/b', clicks: 100, impressions: 1000, ctr: 0.1, position: 8 },
      { keyword: 'too-low-position', page: '/c', clicks: 5, impressions: 500, ctr: 0.01, position: 2 },
      { keyword: 'too-high-position', page: '/d', clicks: 2, impressions: 200, ctr: 0.01, position: 25 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].keyword).toBe('striking')
    expect(result[0].potentialClicks).toBe(150) // 1000 * 0.15
  })

  it('respects custom position range', () => {
    const result = analyzeStrikingDistance([
      { keyword: 'pos-3', page: '/a', clicks: 10, impressions: 500, ctr: 0.02, position: 3 },
    ], { minPosition: 2, maxPosition: 5, minImpressions: 100 })

    expect(result).toHaveLength(1)
  })

  it('sorts by potentialClicks by default', () => {
    const result = analyzeStrikingDistance([
      { keyword: 'low-potential', page: '/a', clicks: 5, impressions: 200, ctr: 0.025, position: 10 },
      { keyword: 'high-potential', page: '/b', clicks: 20, impressions: 1000, ctr: 0.02, position: 8 },
    ])

    expect(result[0].keyword).toBe('high-potential')
  })
})

describe('analyzeOpportunity', () => {
  it('scores keywords by optimization potential', () => {
    const result = analyzeOpportunity([
      { keyword: 'good-opportunity', page: '/a', clicks: 50, impressions: 5000, ctr: 0.01, position: 10 },
      { keyword: 'already-winning', page: '/b', clicks: 500, impressions: 1000, ctr: 0.5, position: 1 },
    ])

    expect(result[0].keyword).toBe('good-opportunity')
    expect(result[0].opportunityScore).toBeGreaterThan(0)
    expect(result[0].factors.positionScore).toBeGreaterThan(0)
  })

  it('respects minImpressions filter', () => {
    const result = analyzeOpportunity([
      { keyword: 'low-impressions', page: '/a', clicks: 1, impressions: 50, ctr: 0.02, position: 10 },
    ], { minImpressions: 100 })

    expect(result).toHaveLength(0)
  })

  it('applies custom weights', () => {
    // High impressions keyword with low position score
    const highImpressionsResult = analyzeOpportunity([
      { keyword: 'high-impr', page: '/a', clicks: 10, impressions: 10000, ctr: 0.001, position: 50 },
    ], { weights: { position: 0, impressions: 2, ctrGap: 1 } })

    // Emphasizing impressions should still produce a score despite bad position
    expect(highImpressionsResult).toHaveLength(1)
    expect(highImpressionsResult[0].opportunityScore).toBeGreaterThan(0)
  })
})

describe('analyzeCannibalization', () => {
  it('detects queries ranking for multiple pages', () => {
    const result = analyzeCannibalization([
      { query: 'shared-query', page: '/a', clicks: 50, impressions: 200, ctr: 0.25, position: 3 },
      { query: 'shared-query', page: '/b', clicks: 30, impressions: 150, ctr: 0.2, position: 5 },
      { query: 'unique-query', page: '/c', clicks: 100, impressions: 500, ctr: 0.2, position: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].query).toBe('shared-query')
    expect(result[0].pages).toHaveLength(2)
    expect(result[0].totalClicks).toBe(80)
  })

  it('respects minPages threshold', () => {
    const result = analyzeCannibalization([
      { query: 'shared-query', page: '/a', clicks: 50, impressions: 200, ctr: 0.25, position: 3 },
      { query: 'shared-query', page: '/b', clicks: 30, impressions: 150, ctr: 0.2, position: 5 },
    ], { minPages: 3 })

    expect(result).toHaveLength(0)
  })

  it('excludes queries with high position spread', () => {
    const result = analyzeCannibalization([
      { query: 'spread-out', page: '/a', clicks: 50, impressions: 200, ctr: 0.25, position: 1 },
      { query: 'spread-out', page: '/b', clicks: 5, impressions: 100, ctr: 0.05, position: 50 },
    ], { maxPositionSpread: 10 })

    expect(result).toHaveLength(0)
  })

  it('sorts pages by clicks within each query', () => {
    const result = analyzeCannibalization([
      { query: 'test', page: '/low', clicks: 10, impressions: 100, ctr: 0.1, position: 8 },
      { query: 'test', page: '/high', clicks: 100, impressions: 500, ctr: 0.2, position: 2 },
    ])

    expect(result[0].pages[0].page).toBe('/high')
    expect(result[0].pages[1].page).toBe('/low')
  })
})

describe('analyzeZeroClick', () => {
  it('finds high-impression low-CTR queries', () => {
    const result = analyzeZeroClick([
      { query: 'zero-click', page: '/a', clicks: 10, impressions: 2000, ctr: 0.005, position: 3 },
      { query: 'normal', page: '/b', clicks: 100, impressions: 500, ctr: 0.2, position: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].query).toBe('zero-click')
  })

  it('respects maxPosition filter', () => {
    const result = analyzeZeroClick([
      { query: 'low-rank', page: '/a', clicks: 5, impressions: 5000, ctr: 0.001, position: 15 },
    ], { maxPosition: 10 })

    expect(result).toHaveLength(0)
  })

  it('keeps best position when query has multiple pages', () => {
    const result = analyzeZeroClick([
      { query: 'multi', page: '/worse', clicks: 5, impressions: 1500, ctr: 0.003, position: 5 },
      { query: 'multi', page: '/better', clicks: 10, impressions: 1500, ctr: 0.007, position: 2 },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].page).toBe('/better')
    expect(result[0].position).toBe(2)
  })
})

describe('analyzeSeasonality', () => {
  it('detects seasonal patterns', () => {
    // Create data with obvious peak in December
    const dates = [
      ...Array.from({ length: 30 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        clicks: 100,
        impressions: 500,
        ctr: 0.2,
        position: 5,
      })),
      ...Array.from({ length: 31 }, (_, i) => ({
        date: `2024-12-${String(i + 1).padStart(2, '0')}`,
        clicks: 500, // 5x normal
        impressions: 2500,
        ctr: 0.2,
        position: 5,
      })),
    ]

    const result = analyzeSeasonality(dates)

    expect(result.hasSeasonality).toBe(true)
    expect(result.peakMonths).toContain('12')
    expect(result.insufficientData).toBe(true) // Only 2 months
  })

  it('returns empty for no data', () => {
    const result = analyzeSeasonality([])

    expect(result.hasSeasonality).toBe(false)
    expect(result.insufficientData).toBe(true)
    expect(result.monthlyBreakdown).toHaveLength(0)
  })

  it('analyzes impressions when specified', () => {
    const dates = [
      { date: '2024-01-01', clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
      { date: '2024-02-01', clicks: 10, impressions: 500, ctr: 0.02, position: 10 },
    ]

    const result = analyzeSeasonality(dates, { metric: 'impressions' })

    expect(result.monthlyBreakdown[1].value).toBe(500)
  })
})

describe('analyzeConcentration', () => {
  it('calculates concentration metrics', () => {
    const result = analyzeConcentration([
      { key: '/a', clicks: 900 },
      { key: '/b', clicks: 50 },
      { key: '/c', clicks: 50 },
    ])

    expect(result.totalClicks).toBe(1000)
    expect(result.totalItems).toBe(3)
    expect(result.riskLevel).toBe('high') // HHI > 2500
    expect(result.giniCoefficient).toBeGreaterThan(0.5)
  })

  it('returns low risk for even distribution', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      key: `/page-${i}`,
      clicks: 10,
    }))

    const result = analyzeConcentration(items)

    expect(result.riskLevel).toBe('low')
    expect(result.giniCoefficient).toBeLessThan(0.1)
  })

  it('handles empty input', () => {
    const result = analyzeConcentration([])

    expect(result.totalClicks).toBe(0)
    expect(result.totalItems).toBe(0)
    expect(result.riskLevel).toBe('low')
  })

  it('respects topN option', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      key: `/page-${i}`,
      clicks: 20 - i,
    }))

    const result = analyzeConcentration(items, { topN: 5 })

    expect(result.topNItems).toHaveLength(5)
    expect(result.topNItems[0].clicks).toBe(20)
  })
})

describe('analyzePageConcentration', () => {
  it('works with page objects', () => {
    const result = analyzePageConcentration([
      { page: '/a', clicks: 100 },
      { page: '/b', clicks: 50 },
    ])

    expect(result.topNItems[0].key).toBe('/a')
    expect(result.totalClicks).toBe(150)
  })

  it('handles nullable clicks', () => {
    const result = analyzePageConcentration([
      { page: '/a', clicks: null },
      { page: '/b', clicks: 50 },
    ])

    expect(result.totalClicks).toBe(50)
  })
})

describe('analyzeKeywordConcentration', () => {
  it('works with keyword objects', () => {
    const result = analyzeKeywordConcentration([
      { keyword: 'best shoes', clicks: 200 },
      { keyword: 'running shoes', clicks: 100 },
    ])

    expect(result.topNItems[0].key).toBe('best shoes')
    expect(result.totalClicks).toBe(300)
  })
})

describe('analyzeBrandSegmentation', () => {
  it('segments keywords by brand terms', () => {
    const result = analyzeBrandSegmentation([
      { keyword: 'nike shoes', page: '/nike', clicks: 100, impressions: 500, ctr: 0.2, position: 2 },
      { keyword: 'nike running', page: '/nike/running', clicks: 50, impressions: 300, ctr: 0.17, position: 3 },
      { keyword: 'best running shoes', page: '/guide', clicks: 80, impressions: 1000, ctr: 0.08, position: 5 },
    ], { brandTerms: ['nike'] })

    expect(result.brand).toHaveLength(2)
    expect(result.nonBrand).toHaveLength(1)
    expect(result.summary.brandClicks).toBe(150)
    expect(result.summary.nonBrandClicks).toBe(80)
    expect(result.summary.brandShare).toBeCloseTo(150 / 230, 2)
  })

  it('matches brand terms case-insensitively', () => {
    const result = analyzeBrandSegmentation([
      { keyword: 'NIKE shoes', page: '/a', clicks: 50, impressions: 200, ctr: 0.25, position: 2 },
    ], { brandTerms: ['nike'] })

    expect(result.brand).toHaveLength(1)
  })

  it('respects minImpressions filter', () => {
    const result = analyzeBrandSegmentation([
      { keyword: 'nike test', page: '/a', clicks: 5, impressions: 5, ctr: 1, position: 1 },
    ], { brandTerms: ['nike'], minImpressions: 10 })

    expect(result.brand).toHaveLength(0)
  })

  it('supports multiple brand terms', () => {
    const result = analyzeBrandSegmentation([
      { keyword: 'nike shoes', page: '/a', clicks: 50, impressions: 200, ctr: 0.25, position: 2 },
      { keyword: 'adidas shoes', page: '/b', clicks: 30, impressions: 150, ctr: 0.2, position: 3 },
      { keyword: 'running shoes', page: '/c', clicks: 100, impressions: 500, ctr: 0.2, position: 5 },
    ], { brandTerms: ['nike', 'adidas'] })

    expect(result.brand).toHaveLength(2)
    expect(result.nonBrand).toHaveLength(1)
  })
})
