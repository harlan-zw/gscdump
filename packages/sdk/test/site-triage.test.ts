import { describe, expect, it } from 'vitest'
import { classifyReachStage } from '../src/site-triage'

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
