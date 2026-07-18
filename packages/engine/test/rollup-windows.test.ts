import { describe, expect, it } from 'vitest'
import { planRollupWindows } from '../src/rollups'

describe('planRollupWindows', () => {
  it('directly assigns mixed partition spans while preserving input order', () => {
    const parts = [
      { partition: 'monthly/2026-01', bytes: 1000 },
      { partition: 'weekly/2026-01-29', bytes: 1000 },
      { partition: 'daily/2026-01-15', bytes: 1000 },
      { partition: 'hourly/2026-01-15', bytes: 1000 },
    ]

    expect(planRollupWindows(parts, { start: '2026-01-10', end: '2026-02-05' }, 7)).toEqual([
      { start: '2026-01-10', end: '2026-01-16', partitions: ['monthly/2026-01', 'daily/2026-01-15'] },
      { start: '2026-01-17', end: '2026-01-23', partitions: ['monthly/2026-01'] },
      { start: '2026-01-24', end: '2026-01-30', partitions: ['monthly/2026-01', 'weekly/2026-01-29'] },
      { start: '2026-01-31', end: '2026-02-04', partitions: ['monthly/2026-01', 'weekly/2026-01-29'] },
    ])
  })

  it('handles large partition sets without spread-argument limits', () => {
    const parts = Array.from({ length: 130_000 }, (_, index) => ({
      partition: `daily/${String(1000 + Math.floor(index / 365)).padStart(4, '0')}-01-01`,
      bytes: 1,
    }))
    expect(() => planRollupWindows(parts)).not.toThrow()
  })
})
