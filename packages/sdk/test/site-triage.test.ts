import { describe, expect, it } from 'vitest'
import { classifyHealthStage, classifyReachStage, reachLivenessRatio } from '../src/site-triage'

function observations(priorClicks: number, currentClicks: number, priorImpressions = 28000, currentImpressions = 28000) {
  const distribute = (total: number, index: number) => Math.floor(total / 28) + (index % 28 < total % 28 ? 1 : 0)
  return Array.from({ length: 56 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 14 + index)).toISOString().slice(0, 10),
    clicks: distribute(index < 28 ? priorClicks : currentClicks, index),
    impressions: distribute(index < 28 ? priorImpressions : currentImpressions, index),
  }))
}

function classify(prior: number, current: number, priorImpressions = 28000, impressions28d = 28000) {
  return classifyReachStage({ impressions28d, clicks28d: current, daily: observations(prior, current, priorImpressions, impressions28d) })
}

function weeklyObservations(priorClicks: number[], currentClicks: number[]) {
  const clicks = [...priorClicks, ...currentClicks]
  return Array.from({ length: 56 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 14 + index)).toISOString().slice(0, 10),
    clicks: Math.floor(clicks[Math.floor(index / 7)]! / 7) + (index % 7 < clicks[Math.floor(index / 7)]! % 7 ? 1 : 0),
    impressions: 1000,
  }))
}

describe('classifyReachStage', () => {
  it.each([[132, 191, 23292, 15065], [191, 132, 15065, 23292]])(
    'reports opposing measured click and impression directions as mixed',
    (prior, current, priorImpressions, currentImpressions) => {
      expect(classify(prior, current, priorImpressions, currentImpressions).stage).toBe('mixed')
    },
  )

  it('recognizes recent click recovery when impressions are flat despite a longer decline', () => {
    const verdict = classifyReachStage({ impressions28d: 15065, clicks28d: 191, clicksPct90d: -17, daily: observations(132, 191, 15065, 15065) })
    expect(verdict.stage).toBe('growing')
  })

  it.each([0, 2, 25])('recognizes stable measured visibility with %i clicks', (clicks) => {
    expect(classify(clicks, clicks, 50000, 50000).stage).toBe('plateaued')
  })

  it('keeps flat observations with sparse impressions emerging', () => {
    expect(classify(2, 2, 280, 280).stage).toBe('emerging')
  })

  it('includes the absolute click growth floor in progression targets', () => {
    const verdict = classify(50, 60)
    expect(verdict.progression.target).toBe(70)
    expect(verdict.progression.pct).toBeLessThan(1)
    expect(classify(50, 70).stage).toBe('growing')
  })

  it('does not claim strong growth from nine extra clicks', () => {
    expect(classify(16, 25, 1541, 1450).stage).toBe('emerging')
  })

  it('does not infer decay from low CTR on steady traffic', () => {
    expect(classify(100, 100, 50000, 50000).stage).toBe('plateaued')
  })

  it.each([[100, 160, 'growing'], [100, 60, 'declining'], [100, 100, 'plateaued'], [100, 115, 'mixed']])(
    'compares %i prior clicks with %i current clicks',
    (prior, current, expected) => {
      expect(classify(prior as number, current as number).stage).toBe(expected)
    },
  )

  it('keeps conflicting flat-click and rising-impression signals separate from stability', () => {
    expect(classify(100, 100, 10000, 15000).stage).toBe('mixed')
  })

  it('requires growth to persist beyond one spike week', () => {
    const daily = observations(100, 100)
    daily[55]!.clicks += 200
    expect(classifyReachStage({ impressions28d: 28000, clicks28d: 300, daily }).stage).toBe('mixed')
  })

  it('requires three materially increased weeks before reporting growth', () => {
    const spike = weeklyObservations([25, 25, 25, 25], [26, 26, 25, 83])
    expect(classifyReachStage({ impressions28d: 28000, clicks28d: 160, daily: spike }).stage).toBe('mixed')

    const sustained = weeklyObservations([25, 25, 25, 25], [32, 32, 32, 25])
    expect(classifyReachStage({ impressions28d: 28000, clicks28d: 121, daily: sustained }).stage).toBe('growing')
  })

  it('uses recovery progressions for non-successful reach stages', () => {
    const declining = classify(100, 60)
    expect(declining.stage).toBe('declining')
    expect(declining.progression).toMatchObject({ direction: 'escape', nextStage: 'plateaued' })
    expect(declining.progression.pct).toBeLessThan(1)

    expect(classify(100, 100).progression.direction).toBe('advance')
    expect(classify(100, 115).progression.direction).toBe('advance')
    expect(classify(100, 160).progression.direction).toBe('sustain')
  })

  it('uses measured impressions when clicks are sparse', () => {
    const verdict = classify(2, 3, 1000, 1600)
    expect(verdict.stage).toBe('growing')
    expect(verdict.progression.metric).toBe('28d impressions growth')
  })

  it('does not turn sparse click percentages into decline', () => {
    expect(classify(3, 0).stage).toBe('emerging')
  })

  it('includes the exact growth boundary without floating-point rounding errors', () => {
    expect(classify(100, 120).stage).toBe('growing')
  })

  it('does not infer stability from changes that cancel across volatile weeks', () => {
    const daily = observations(280, 280)
    for (let index = 28; index < 56; index++)
      daily[index]!.clicks = index < 42 ? 0 : 20
    expect(classifyReachStage({ daily, impressions28d: 28000 }).stage).toBe('mixed')
  })

  it('refuses a complete series that ends before the requested reporting date', () => {
    expect(classifyReachStage({ daily: observations(100, 150), impressions28d: 28000, periodEnd: '2026-10-09' }).stage).toBe('insufficient_data')
  })

  it('keeps observed low-volume traffic distinct from missing data', () => {
    expect(classifyReachStage({ impressions28d: 14 }).stage).toBe('emerging')
    expect(classifyReachStage({ impressions28d: 0 }).stage).toBe('emerging')
    expect(classifyReachStage({}).stage).toBe('insufficient_data')
    expect(classifyReachStage({ impressions28d: 28000 }).stage).toBe('insufficient_data')
  })

  it.each(['date', 'negative', 'periodEnd'])('refuses %s defects in supplied sparse early history', (defect) => {
    const daily = observations(0, 0, 280, 280).slice(-14)
    if (defect === 'date')
      daily[0]!.date = 'invalid'
    if (defect === 'negative')
      daily[0]!.clicks = -1
    const periodEnd = defect === 'periodEnd' ? '2026-10-09' : daily.at(-1)!.date
    expect(classifyReachStage({ daily, impressions28d: 280, periodEnd }).stage).toBe('insufficient_data')
  })

  it('keeps valid sparse early history emerging', () => {
    const daily = observations(0, 0, 280, 280).slice(-14)
    expect(classifyReachStage({ daily, impressions28d: 280, periodEnd: daily.at(-1)!.date }).stage).toBe('emerging')
  })

  it.each(['missing', 'duplicate', 'negative', 'mismatch'])('refuses a %s daily comparison', (defect) => {
    const daily = observations(100, 150)
    if (defect === 'missing')
      daily.splice(20, 1)
    if (defect === 'duplicate')
      daily[20]!.date = daily[19]!.date
    if (defect === 'negative')
      daily[20]!.clicks = -1
    expect(classifyReachStage({ daily, impressions28d: defect === 'mismatch' ? 29000 : 28000 }).stage).toBe('insufficient_data')
  })
})

describe('complete-window reach liveness', () => {
  it('retains genuine trailing zero-impression weeks', () => {
    const daily = [...Array.from({ length: 28 }, () => ({ impressions: 100 })), ...Array.from({ length: 21 }, () => ({ impressions: 0 }))]
    expect(reachLivenessRatio(daily)).toBe(0)
  })

  it('does not mistake one large spike for an established baseline', () => {
    const daily = Array.from({ length: 56 }, (_, i) => ({ impressions: i === 0 ? 10000 : 10 }))
    expect(reachLivenessRatio(daily)).toBeNull()
  })

  it('recognizes a sustained visibility collapse with known zeroes', () => {
    const daily = observations(0, 0, 2800, 0)
    expect(classifyReachStage({ daily, impressions28d: 0 }).stage).toBe('declining')
  })
})

describe('classifyHealthStage', () => {
  const issue = (type: string, count: number) => ({ type, label: type, count })

  it('reports missing indexing observations without claiming successful indexing', () => {
    const health = classifyHealthStage({})
    expect(health.stage).toBe('healthy')
    expect(health.summary).toBe('No known URL count is available to assess indexing.')
    expect(health.primaryAction).toBe('Collect URL Inspection results before assessing indexing.')
    expect(health.progression.gapLabel).toBe('Indexing assessment unavailable without a known URL count.')
  })

  it('describes the measured 30% share without claiming a majority or a quality cause', () => {
    const health = classifyHealthStage({ totalUrls: 1000, issues: [issue('crawled_not_indexed', 300)] })
    expect(health.stage).toBe('quality_rejection')
    expect(health.summary).toBe('Saved inspections show many crawled or soft-404 URLs are not indexed. These states do not establish a quality cause.')
    expect(health.evidence).toContainEqual({ label: 'Share of known URLs', value: '30%' })
    expect(health.progression.gapLabel).toBe('30% of known URLs. This classification applies at 30% or more, with over 50 affected URLs.')
  })

  it('names a Site whose known URLs are mostly Discovered as not indexed', () => {
    const health = classifyHealthStage({
      totalUrls: 1000,
      issues: [issue('crawled_not_indexed', 100), issue('discovered_not_indexed', 600)],
    })
    expect(health.stage).toBe('not_indexed')
    expect(health.evidence).toEqual([
      { label: 'Discovered, currently not indexed', value: '600' },
      { label: 'Crawled not indexed or soft 404', value: '100' },
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
