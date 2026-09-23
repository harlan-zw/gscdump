import type { InspectionRecord } from '@gscdump/engine/entities'
import { describe, expect, it } from 'vitest'
import { latestByUrl, planInspections, toInspectionRecord } from '../src/inspection-record'
import { resolvePagePaths } from '../src/local-entities'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function inspected(url: string, daysAgo: number, verdict: string): InspectionRecord {
  return toInspectionRecord({
    url,
    result: { indexStatusResult: { verdict } },
    inspectedAt: new Date(NOW.getTime() - daysAgo * DAY),
  })
}

describe('planInspections', () => {
  it('puts never-inspected URLs first, then due URLs by oldest schedule, and skips URLs not due', () => {
    const history = [
      inspected('https://e.com/fail-8d', 8, 'FAIL'), // FAIL rechecks after 7 days: due
      inspected('https://e.com/pass-40d', 40, 'PASS'), // PASS rechecks after 30 days: due, older
      inspected('https://e.com/pass-2d', 2, 'PASS'), // not due
    ]
    const plan = planInspections({
      candidates: ['https://e.com/fail-8d', 'https://e.com/pass-2d', 'https://e.com/new', 'https://e.com/pass-40d', 'https://e.com/new'],
      latest: latestByUrl(history),
      recent: history,
      now: NOW,
      limit: 10,
    })
    expect(plan.urls).toEqual(['https://e.com/new', 'https://e.com/pass-40d', 'https://e.com/fail-8d'])
    expect(plan.deferred).toBe(0)
  })

  it('caps the run at the daily quota left after the last 24 hours of calls', () => {
    const history = Array.from({ length: 1998 }, (_, i) => inspected(`https://e.com/done-${i}`, 0.5, 'PASS'))
    const plan = planInspections({
      candidates: ['https://e.com/a', 'https://e.com/b', 'https://e.com/c'],
      latest: latestByUrl(history),
      recent: history,
      now: NOW,
      limit: 50,
    })
    expect(plan).toEqual({ urls: ['https://e.com/a', 'https://e.com/b'], deferred: 1, quotaLeft: 2 })
  })
})

describe('toInspectionRecord', () => {
  it('continues the schedule from the previous record and resets it when the state changes', () => {
    const first = inspected('https://e.com/a', 40, 'PASS')
    const same = toInspectionRecord({ url: 'https://e.com/a', result: { indexStatusResult: { verdict: 'PASS' } }, inspectedAt: NOW, previous: first })
    expect(same.raw?.schedule).toMatchObject({ consecutiveUnchanged: 1, nextAt: NOW.getTime() + 30 * DAY })
    const changed = toInspectionRecord({ url: 'https://e.com/a', result: { indexStatusResult: { verdict: 'FAIL' } }, inspectedAt: NOW, previous: same })
    expect(changed.raw?.schedule).toMatchObject({ consecutiveUnchanged: 0, nextAt: NOW.getTime() + 7 * DAY })
  })
})

describe('resolvePagePaths', () => {
  it('uses the most common sitemap origin for a domain property', () => {
    expect(resolvePagePaths(['/a', '/b?x=1'], 'sc-domain:e.com', [
      'https://www.e.com/1',
      'https://www.e.com/2',
      'https://blog.e.com/3',
      'https://other.com/4',
    ])).toEqual(['https://www.e.com/a', 'https://www.e.com/b?x=1'])
  })

  it('falls back to https://<domain>, and uses the prefix of a URL-prefix property', () => {
    expect(resolvePagePaths(['/a'], 'sc-domain:e.com', [])).toEqual(['https://e.com/a'])
    expect(resolvePagePaths(['/a'], 'http://e.com/', [])).toEqual(['http://e.com/a'])
  })
})
