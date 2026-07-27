import { describe, expect, it } from 'vitest'
import { classifyReachStage } from '../src/site-triage'

describe('classifyReachStage', () => {
  it('renders signed evidence and uses the metric that actually drove growth', () => {
    const verdict = classifyReachStage({
      connected: true,
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
