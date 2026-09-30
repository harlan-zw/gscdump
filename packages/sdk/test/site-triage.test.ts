import { describe, expect, it } from 'vitest'
import { classifyHealthStage, classifyReachStage } from '../src/site-triage'

describe('classifyReachStage', () => {
  it('classifies observed low-volume search data as emerging', () => {
    const verdict = classifyReachStage({
      impressions28d: 14,
      impressions12m: 7,
      clicksPct90d: 100,
    })

    expect(verdict.stage).toBe('emerging')
    expect(verdict.evidence).toContainEqual({ label: 'Impressions (28d)', value: '14' })
    expect(verdict.progression.metric).toBe('28d impressions')
  })

  it('classifies an observed zero-impression window as emerging', () => {
    const verdict = classifyReachStage({
      impressions28d: 0,
      impressions12m: 0,
    })

    expect(verdict.stage).toBe('emerging')
    expect(verdict.progression.metric).toBe('28d impressions')
  })

  it('requires meaningful current reach before claiming growth', () => {
    const verdict = classifyReachStage({
      impressions28d: 14,
      impressions12m: 20_000,
      clicksPct90d: 100,
    })

    expect(verdict.stage).toBe('emerging')
  })

  it('renders signed evidence and uses the metric that actually drove growth', () => {
    const verdict = classifyReachStage({
      impressions28d: 50000,
      impressions12m: 100000,
      clicksPct90d: -5,
      impressionsPct90d: 30,
      positionDelta90d: -1,
    })

    expect(verdict.stage).toBe('growing')
    expect(verdict.evidence.find(evidence => evidence.label === 'Clicks 90d')?.value).toBe('-5%')
    expect(verdict.evidence.find(evidence => evidence.label === 'Impressions 90d')?.value).toBe('+30%')
    expect(verdict.progression.metric).toBe('90d impressions growth')
    expect(verdict.progression.gapLabel).toContain('+30% 90d impressions')
  })
})

describe('classifyHealthStage', () => {
  const issue = (type: string, count: number) => ({ type, label: type, count })

  it('names a Site whose known URLs are mostly Discovered as not indexed', () => {
    const health = classifyHealthStage({
      totalUrls: 1000,
      issues: [issue('crawled_not_indexed', 100), issue('discovered_not_indexed', 600)],
    })
    expect(health.stage).toBe('not_indexed')
    expect(health.evidence).toEqual([
      { label: 'Discovered, currently not indexed', value: '600' },
      { label: 'Crawled, currently not indexed', value: '100' },
      { label: 'Share of known URLs', value: '70%' },
    ])
  })

  it('keeps quality_rejection when Crawled alone dominates', () => {
    const health = classifyHealthStage({
      totalUrls: 1000,
      issues: [issue('crawled_not_indexed', 500), issue('discovered_not_indexed', 300)],
    })
    expect(health.stage).toBe('quality_rejection')
  })

  it('stays healthy when the not-indexed share is small', () => {
    const health = classifyHealthStage({
      totalUrls: 1000,
      issues: [issue('crawled_not_indexed', 100), issue('discovered_not_indexed', 100)],
    })
    expect(health.stage).toBe('healthy')
  })

  it('ignores a Discovered count on a Site too small to judge', () => {
    const health = classifyHealthStage({ totalUrls: 60, issues: [issue('discovered_not_indexed', 50)] })
    expect(health.stage).toBe('healthy')
  })
})
