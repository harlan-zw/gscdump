import { describe, expect, it } from 'vitest'
import { fixedPolicy, inspectionPolicy, sitemapPolicy } from '../src/schedule'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('sitemapPolicy', () => {
  it('initial returns 24h cadence with zeroed counter', () => {
    const s = sitemapPolicy.initial(1000)
    expect(s).toEqual({
      nextAt: 1000 + DAY,
      consecutiveUnchanged: 0,
      policyVersion: 1,
    })
  })

  it('ladder progression unchanged: 1, 2, 3 shifts to 7d at 3, 30d at 7', () => {
    let s = sitemapPolicy.initial(0)
    s = sitemapPolicy.observe(s, { changed: false, at: 1000 })
    expect(s.consecutiveUnchanged).toBe(1)
    expect(s.nextAt).toBe(1000 + DAY)

    s = sitemapPolicy.observe(s, { changed: false, at: 2000 })
    expect(s.consecutiveUnchanged).toBe(2)
    expect(s.nextAt).toBe(2000 + DAY)

    s = sitemapPolicy.observe(s, { changed: false, at: 3000 })
    expect(s.consecutiveUnchanged).toBe(3)
    expect(s.nextAt).toBe(3000 + 7 * DAY)

    // Bump to 7
    for (let i = 0; i < 4; i++) s = sitemapPolicy.observe(s, { changed: false, at: 4000 })
    expect(s.consecutiveUnchanged).toBe(7)
    expect(s.nextAt).toBe(4000 + 30 * DAY)
  })

  it('changed: true resets to 24h regardless of state', () => {
    let s = sitemapPolicy.initial(0)
    for (let i = 0; i < 10; i++) s = sitemapPolicy.observe(s, { changed: false, at: 1000 })
    expect(s.consecutiveUnchanged).toBeGreaterThanOrEqual(7)
    s = sitemapPolicy.observe(s, { changed: true, at: 5000 })
    expect(s).toEqual({
      nextAt: 5000 + DAY,
      consecutiveUnchanged: 0,
      policyVersion: 1,
    })
  })
})

describe('inspectionPolicy', () => {
  it('pASS returns 30d cadence', () => {
    const p = inspectionPolicy('PASS')
    const s = p.initial(0)
    expect(s.nextAt).toBe(30 * DAY)
    const s2 = p.observe(s, { changed: false, at: 1000 })
    expect(s2.nextAt).toBe(1000 + 30 * DAY)
  })

  it('fAIL returns 7d cadence', () => {
    const p = inspectionPolicy('FAIL')
    const s = p.initial(0)
    expect(s.nextAt).toBe(7 * DAY)
  })

  it('nEUTRAL returns 14d cadence', () => {
    const p = inspectionPolicy('NEUTRAL')
    const s = p.initial(0)
    expect(s.nextAt).toBe(14 * DAY)
  })

  it('consecutiveUnchanged increments for telemetry but does not affect timing', () => {
    const p = inspectionPolicy('PASS')
    let s = p.initial(0)
    s = p.observe(s, { changed: false, at: 1000 })
    expect(s.consecutiveUnchanged).toBe(1)
    expect(s.nextAt).toBe(1000 + 30 * DAY)
    s = p.observe(s, { changed: false, at: 2000 })
    expect(s.consecutiveUnchanged).toBe(2)
    expect(s.nextAt).toBe(2000 + 30 * DAY)
    s = p.observe(s, { changed: true, at: 3000 })
    expect(s.consecutiveUnchanged).toBe(0)
    expect(s.nextAt).toBe(3000 + 30 * DAY)
  })
})

describe('fixedPolicy', () => {
  it('always advances by the interval', () => {
    const p = fixedPolicy(60_000)
    let s = p.initial(0)
    expect(s.nextAt).toBe(60_000)
    s = p.observe(s, { changed: false, at: 100_000 })
    expect(s.nextAt).toBe(160_000)
    s = p.observe(s, { changed: true, at: 200_000 })
    expect(s.nextAt).toBe(260_000)
  })
})

describe('isDue', () => {
  it('returns true when now >= nextAt', () => {
    const s = sitemapPolicy.initial(0)
    expect(sitemapPolicy.isDue(s, s.nextAt - 1)).toBe(false)
    expect(sitemapPolicy.isDue(s, s.nextAt)).toBe(true)
    expect(sitemapPolicy.isDue(s, s.nextAt + 1)).toBe(true)
  })
})

describe('policy version mismatch', () => {
  it('observe treats stale state as fresh-initial-equivalent', () => {
    const stale = { nextAt: 999, consecutiveUnchanged: 42, policyVersion: 0 }
    const s = sitemapPolicy.observe(stale, { changed: false, at: 5000 })
    expect(s.consecutiveUnchanged).toBe(0)
    expect(s.policyVersion).toBe(1)
    expect(s.nextAt).toBe(5000 + DAY)
  })

  it('inspectionPolicy version mismatch resets', () => {
    const p = inspectionPolicy('FAIL')
    const stale = { nextAt: 999, consecutiveUnchanged: 9, policyVersion: 0 }
    const s = p.observe(stale, { changed: false, at: 5000 })
    expect(s.consecutiveUnchanged).toBe(0)
    expect(s.policyVersion).toBe(1)
    expect(s.nextAt).toBe(5000 + 7 * DAY)
  })

  it('fixedPolicy version mismatch resets', () => {
    const p = fixedPolicy(1000)
    const stale = { nextAt: 999, consecutiveUnchanged: 9, policyVersion: 0 }
    const s = p.observe(stale, { changed: false, at: 5000 })
    expect(s.consecutiveUnchanged).toBe(0)
    expect(s.policyVersion).toBe(1)
    expect(s.nextAt).toBe(6000)
  })
})

describe('purity', () => {
  it('sitemapPolicy: same inputs → same outputs', () => {
    const s = sitemapPolicy.initial(1000)
    const a = sitemapPolicy.observe(s, { changed: false, at: 2000 })
    const b = sitemapPolicy.observe(s, { changed: false, at: 2000 })
    expect(a).toEqual(b)
  })

  it('inspectionPolicy: same inputs → same outputs', () => {
    const p = inspectionPolicy('PASS')
    const s = p.initial(1000)
    const a = p.observe(s, { changed: true, at: 2000 })
    const b = p.observe(s, { changed: true, at: 2000 })
    expect(a).toEqual(b)
  })

  it('fixedPolicy: same inputs → same outputs', () => {
    const p = fixedPolicy(500)
    const s = p.initial(1000)
    const a = p.observe(s, { changed: false, at: 2000 })
    const b = p.observe(s, { changed: false, at: 2000 })
    expect(a).toEqual(b)
  })
})
