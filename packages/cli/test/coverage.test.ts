import type { StoreCoverage } from '../src/coverage'
import { describe, expect, it } from 'vitest'
import { analyticsCoverage, inspectionCoverage, renderCoverage } from '../src/coverage'
import { syncRunStatus } from '../src/sync-run'

const SITE = 'sc-domain:example.com'
const urls = (count: number, from = 0): string[] => Array.from({ length: count }, (_, i) => `https://example.com/${from + i}`)

function coverage(overrides: Partial<StoreCoverage>): StoreCoverage {
  return {
    site: SITE,
    analytics: [],
    days: { from: '2026-09-19', to: '2026-09-19', coverage: { kind: 'empty' } },
    inspections: { perRun: 50, coverage: { kind: 'empty' } },
    sitemaps: { coverage: { kind: 'empty' }, urls: 0 },
    run: { kind: 'none' },
    ...overrides,
  }
}

describe('renderCoverage', () => {
  it('words partial inspections as progress with an ETA and a faster option', () => {
    const inspections = inspectionCoverage({ candidates: urls(10_000), inspected: new Set(urls(1_200)), perRun: 50 })

    const lines = renderCoverage(coverage({ inspections }))

    expect(lines).toContain('Inspections: 1,200 of 10,000 URLs so far. Daily sync covers the rest in about 176 runs at 50 URLs a run. Pass --inspect-limit 2000 to finish in about 5 days.')
    expect(lines.at(-1)).toBe(`Next: gscdump sync --site ${SITE}`)
  })

  it('says complete only when every URL has a record', () => {
    const inspections = inspectionCoverage({ candidates: urls(3), inspected: new Set(urls(3)), perRun: 50 })
    expect(renderCoverage(coverage({ inspections }))).toContain('Inspections: all 3 URLs inspected at least once.')
  })

  it('counts a day done only when every table has it', () => {
    const { jobs, days } = analyticsCoverage({
      states: [
        { table: 'pages', date: '2026-09-18', state: 'done' },
        { table: 'pages', date: '2026-09-19', state: 'done' },
        { table: 'queries', date: '2026-09-18', state: 'done' },
        { table: 'queries', date: '2026-09-19', state: 'failed' },
      ],
      latest: '2026-09-19',
      floor: '2025-05-23',
      today: '2026-09-22',
    })

    expect(jobs.map(job => [job.table, job.coverage.kind])).toEqual([['pages', 'complete'], ['queries', 'partial']])
    expect(renderCoverage(coverage({ analytics: jobs, days }))[0])
      .toBe('Analytics: 1 of 2 days so far (2026-09-18 to 2026-09-19). 1 day has a failed table. The next sync continues from there.')
  })

  it('points at the running sync instead of starting another', () => {
    const run = syncRunStatus({ pid: 42, startedAt: 0, heartbeatAt: 1000, sites: [SITE], planned: 400, done: 120 }, { now: 2000, isAlive: () => true })
    const lines = renderCoverage(coverage({ run }))
    expect(lines[0]).toBe('Sync running: 120/400 days, pid 42.')
    expect(lines.at(-1)).toBe(`Next: gscdump sync --status --site ${SITE}`)
  })
})

describe('syncRunStatus', () => {
  const record = { pid: 42, startedAt: 0, heartbeatAt: 0, sites: [SITE], planned: 10, done: 3 }

  it.each([
    ['process-gone', { now: 1000, isAlive: () => false }],
    ['no-heartbeat', { now: 10 * 60_000, isAlive: () => true }],
  ] as const)('marks a run stale when %s', (reason, probe) => {
    expect(syncRunStatus(record, probe)).toEqual({ kind: 'stale', record, reason })
  })

  it('treats a finished run as finished even if its pid is gone', () => {
    expect(syncRunStatus({ ...record, finishedAt: 5, outcome: 'completed' }, { now: 10, isAlive: () => false }).kind).toBe('finished')
  })
})
